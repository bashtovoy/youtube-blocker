/* ocr-host.js — PaddleOCR-Host im privilegierten Kontext
   (Firefox: Background-Seite; Chrome MV3: Offscreen-Dokument, siehe offscreen.js).
   Warum nicht im Content-Script: YouTube erzwingt Trusted Types + CSP
   (`require-trusted-types-for 'script'`), dadurch schlägt `new Worker(...)` aus
   Content-Scripts synchron fehl ("Worker constructor: Sink type mismatch ... blocked by CSP").
   Der privilegierte Kontext unterliegt den Seitenrichtlinien nicht. Content-Scripts sprechen
   nur noch per runtime.sendMessage mit diesem Host.

   Erkennung mit PaddleOCR.js (PP-OCRv5 mobile):
   - eine Pipeline für Englisch/Latein (`en`),
   - eine Pipeline für Russisch/Kyrillisch (`eslav`, deckt Latein und Kyrillisch ab).
   „eng+rus“ wird nicht als ein gemeinsames Modell geladen: Titel und Kanal
   entscheiden anhand der Schrift, welche Pipeline zuerst gefragt wird. Beide
   Pipelines können vom Popup vorgewärmt werden.

   Alle Dateien liegen lokal im Paket: das SDK-Bundle, der Detektor, die beiden
   Erkenner und die vorhandene ONNX-Runtime unter lib/. Es gibt zur Laufzeit
   keinen CDN- oder Modell-Download. */

(function () {
  'use strict';

  const api = (typeof browser !== 'undefined') ? browser : chrome;
  const LIB_DIR = api.runtime.getURL('lib/');
  const LIB_URL = LIB_DIR + 'paddle.bundle.js';

  const MODEL_NAMES = {
    det: 'PP-OCRv5_mobile_det',
    en: 'en_PP-OCRv5_mobile_rec',
    eslav: 'eslav_PP-OCRv5_mobile_rec'
  };
  const MODEL_URLS = {
    det: LIB_DIR + 'ppocrv5_mobile_det.tar',
    en: LIB_DIR + 'en_ppocrv5_mobile_rec.tar',
    eslav: LIB_DIR + 'eslav_ppocrv5_mobile_rec.tar'
  };

  /* Sprache in der Erweiterung → interne Paddle-Pipeline. */
  const PIPELINE_FOR_LANG = { eng: 'en', rus: 'eslav' };
  const LANG_FOR_PIPELINE = { en: 'eng', eslav: 'rus' };
  const PIPELINE_ORDER = ['en', 'eslav'];

  /* Pipeline nach Leerlauf beenden → Speicher der wasm-Erkennung wird
     freigegeben. Der nächste Treffer initialisiert lazy neu. */
  const IDLE_MS = 10 * 60 * 1000;
  const CACHE_MAX = 400;   /* Bild-URL+Sprachen → Text (Dedupe über Karten/Tabs/Rescans) */

  /* Cache-Schlüssel mit Pipeline-Version: alte OCR-Texte aus einer früheren
     Sitzung dürfen einen erneuten Lauf nicht verhindern. */
  const CACHE_VERSION = 'ocr-v5-paddle';

  /* Eine Paddle-Pipeline je Erkenner. Beide nutzen denselben lokalen
     Detektor; der Detektor wird vom SDK pro Instanz geladen. */
  const pipelines = new Map();          /* 'en' | 'eslav' → fertige Pipeline */
  const pipelinePromises = new Map();   /* 'en' | 'eslav' → laufende Initialisierung */
  let loadPromise = null;               /* Single-Flight: SDK nachladen */
  let generation = 0;                   /* schützt vor späten Initialisierungen nach reset */
  let queue = Promise.resolve();
  let busy = 0;
  let idleTimer = null;
  let failChain = 0;                    /* aufeinanderfolgende Erkennungsfehler */
  let lastError = null;
  let stage = '';                       /* Status für das Popup */
  let stageLang = '';
  let stageProgress = 0;
  let prepareActive = 0;
  let prepareChain = Promise.resolve();
  let preparePromise = null;
  let prepareKey = '';
  const textCache = new Map();

  function dlog(line) {
    if (typeof self.YB_DEVLOG === 'function') { try { self.YB_DEVLOG(line); } catch (e) { /* Dev-Log optional */ } }
  }

  function markFatal(err) {
    if (err && typeof err === 'object') err.fatal = true;
    return err;
  }

  function langForPipeline(key) {
    return LANG_FOR_PIPELINE[key] || key;
  }

  function pipelineForLang(lang) {
    return PIPELINE_FOR_LANG[String(lang || '').trim().toLowerCase()] || 'en';
  }

  /* Status-Reihenfolge stabil halten, damit das Popup nicht zwischen
     „eng, rus“ und „rus, eng“ springt. */
  function sortedPipelineKeys(keys) {
    return Array.from(keys).sort((a, b) => {
      const ia = PIPELINE_ORDER.indexOf(a);
      const ib = PIPELINE_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }

  function armIdle() {
    clearTimeout(idleTimer);
    if (!(IDLE_MS > 0)) return;
    idleTimer = setTimeout(() => {
      if (busy || pipelinePromises.size || prepareActive) { armIdle(); return; }
      disposePipelines('idle');
    }, IDLE_MS);
  }

  function disposePipelines(reason) {
    generation++;
    const active = Array.from(pipelines.values());
    pipelines.clear();
    pipelinePromises.clear();
    preparePromise = null;
    prepareKey = '';
    lastError = null;
    stage = '';
    stageLang = '';
    stageProgress = 0;
    failChain = 0;
    for (const p of active) {
      try {
        const result = p && p.dispose && p.dispose();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch (e) { /* Pipeline ist schon beendet */ }
    }
    dlog('ocr host: Paddle-Pipelines beendet (' + reason + ')');
  }

  /* SDK nur beim ersten OCR-Bedarf laden: Nutzer ohne Vorschaubild-OCR
     zahlen beim Start nichts dafür. */
  function loadLib() {
    if (self.PaddleOCR) return Promise.resolve();
    if (loadPromise) return loadPromise;
    self.YB_OPENCV_WASM_URL = LIB_DIR + 'opencv_js.wasm';
    loadPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = LIB_URL;
      s.onload = () => {
        if (self.PaddleOCR) resolve();
        else reject(markFatal(new Error('PaddleOCR-SDK nicht verfügbar')));
      };
      s.onerror = () => reject(markFatal(new Error('PaddleOCR-Bibliothek konnte nicht geladen werden')));
      (document.head || document.documentElement).appendChild(s);
    }).then(v => v, err => { loadPromise = null; throw err; });
    return loadPromise;
  }

  /* ---------- Bildbeschaffung ----------
     PaddleOCR dekodiert Bilder über den Browser (createImageBitmap) und
     unterstützt damit auch AVIF, das ytimg.com inzwischen liefert. Wir laden
     die Bytes selbst, prüfen den Content-Type und übergeben dem SDK ein
     ImageBitmap. So bleiben 404/HTML und kaputte Bilder stille Skips. */
  async function imageBytesFor(url) {
    let res;
    try {
      res = await fetch(url, { credentials: 'omit' });
    } catch (e) {
      dlog('ocr host: Bildabruf fehlgeschlagen (' + ((e && e.message) || e) + ')');
      return null;
    }
    if (!res || !res.ok) {
      dlog('ocr host: Bild HTTP ' + ((res && res.status) || '?'));
      return null;
    }
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
    if (type && !/^image\//i.test(type)) {
      dlog('ocr host: kein Bild (' + type + ')');
      return null;
    }
    let bytes;
    try {
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      return null;
    }
    if (!bytes.length) return null;
    return { bytes, type };
  }

  async function decodeImage(bytes, type) {
    if (typeof createImageBitmap !== 'function') return null;
    try {
      return await createImageBitmap(new Blob([bytes], {
        type: type || 'application/octet-stream'
      }));
    } catch (e) {
      dlog('ocr host: Bild nicht dekodierbar (' + ((e && e.message) || e) + ')');
      return null;
    }
  }

  function linesFromResult(result) {
    const items = Array.isArray(result && result.items) ? result.items : [];
    return items
      .map(item => String((item && item.text) || '').trim())
      .filter(Boolean);
  }

  /* ---------- Sprachen ----------
     „eng+rus“ wird nicht als ein gemeinsames Modell geladen: Latein und
     Kyrillisch konkurrieren bei kurzen, verzerrten Wörtern. Stattdessen
     wählen wir anhand von Titel/Kanal die wahrscheinlichere Schrift und
     initialisieren nur deren Pipeline. Die andere Sprache bleibt dem Nutzer
     als Einstellung erhalten, falls das Thumbnail anders beschriftet ist. */
  function splitLangs(langs) {
    const list = String(langs || 'eng+rus').split('+').map(s => s.trim()).filter(Boolean);
    return list.length ? Array.from(new Set(list)) : ['eng'];
  }

  function primaryLang(langs, hint) {
    const list = splitLangs(langs);
    if (list.length === 1) return list[0];
    const text = String(hint || '');
    const cyr = (text.match(/[\u0400-\u04FF]/g) || []).length;
    const lat = (text.match(/[A-Za-z]/g) || []).length;
    if (cyr > lat && list.indexOf('rus') >= 0) return 'rus';
    if (lat >= cyr && list.indexOf('eng') >= 0) return 'eng';
    return list[0];
  }

  /* Erstellen einer Paddle-Pipeline für genau einen Erkenner. Detektor und
     Erkenner sowie die ONNX-Runtime kommen ausschließlich aus lib/. */
  function ensurePipeline(key) {
    if (pipelines.has(key)) return Promise.resolve(pipelines.get(key));
    if (pipelinePromises.has(key)) return pipelinePromises.get(key);
    const gen = generation;
    const promise = (async () => {
      stage = 'PaddleOCR-Bibliothek';
      stageLang = langForPipeline(key);
      stageProgress = 0;
      await loadLib();
      if (gen !== generation) throw markFatal(new Error('OCR-Host wurde zurückgesetzt'));

      stage = 'Modell';
      stageLang = langForPipeline(key);
      stageProgress = 0;
      const sdk = self.PaddleOCR;
      if (!sdk || typeof sdk.create !== 'function') {
        throw markFatal(new Error('PaddleOCR-SDK nicht verfügbar'));
      }
      const instance = await sdk.create({
        textDetectionModelName: MODEL_NAMES.det,
        textDetectionModelAsset: { url: MODEL_URLS.det },
        textRecognitionModelName: MODEL_NAMES[key],
        textRecognitionModelAsset: { url: MODEL_URLS[key] },
        textDetectionBatchSize: 1,
        textRecognitionBatchSize: 1,
        /* Explizit lokal: die SDK-Standardwerte zeigen für Modelle und
           Worker-ORT auf paddle-model-ecology bzw. jsDelivr. */
        ortOptions: {
          backend: 'wasm',
          wasmPaths: LIB_DIR,
          numThreads: 1,
          simd: true
        }
      });
      if (gen !== generation) {
        try { await instance.dispose(); } catch (e) { /* schon beendet */ }
        throw markFatal(new Error('OCR-Host wurde zurückgesetzt'));
      }
      return instance;
    })().then(instance => {
      pipelinePromises.delete(key);
      pipelines.set(key, instance);
      lastError = null;
      stage = '';
      stageLang = '';
      stageProgress = 0;
      failChain = 0;
      dlog('ocr host: Paddle-Pipeline bereit (' + langForPipeline(key) + ')');
      return instance;
    }).catch(err => {
      pipelinePromises.delete(key);
      lastError = String((err && err.message) || err);
      stage = '';
      stageLang = '';
      stageProgress = 0;
      throw markFatal(err);
    });
    pipelinePromises.set(key, promise);
    return promise;
  }

  /* Vorwärmen für das Popup: alle in der Einstellung gewählten Sprachen
     wirklich initialisieren. „eng+rus“ lädt beide Pipelines, damit die Anzeige
     „bereit“ nicht lügt und später kein Sprachwechsel mehr nötig ist. */
  function prepare(langs) {
    const list = splitLangs(langs);
    const key = list.join('+');
    if (preparePromise && prepareKey === key) return preparePromise;
    const run = prepareChain.then(async () => {
      prepareActive++;
      try {
        lastError = null;
        for (const lang of list) await ensurePipeline(pipelineForLang(lang));
      } finally {
        prepareActive--;
        armIdle();
      }
    });
    prepareChain = run.catch(() => {});
    prepareKey = key;
    const clear = () => { if (preparePromise === completed) { preparePromise = null; prepareKey = ''; } };
    const completed = run.then(
      () => { clear(); return status(); },
      e => { clear(); throw e; }
    );
    preparePromise = completed;
    return completed;
  }

  function recognize(url, langs, hint) {
    const lang = String(langs || 'eng+rus');
    const hintText = String(hint || '');
    const cacheKey = CACHE_VERSION + '\u0001' + lang + '\u0001' + hintText + '\u0001' + url;
    if (textCache.has(cacheKey)) {
      return Promise.resolve({ text: textCache.get(cacheKey), cached: true });
    }
    const run = queue.then(async () => {
      busy++;
      try {
        const t0 = Date.now();
        const image = await imageBytesFor(url);
        if (!image) {
          /* Kein verwertbares Bild: Karte gilt als „ohne Text“. Bewusst
             NICHT cachen — ein späterer Rescan darf die URL erneut versuchen. */
          dlog('ocr host: Bild übersprungen ' + String(url).slice(0, 90));
          return { text: '', skipped: true };
        }

        const primary = primaryLang(lang, hintText);
        const pipeline = await ensurePipeline(pipelineForLang(primary));
        const bitmap = await decodeImage(image.bytes, image.type);
        if (!bitmap) {
          dlog('ocr host: Bild übersprungen ' + String(url).slice(0, 90));
          return { text: '', skipped: true };
        }

        let result = null;
        try {
          const results = await pipeline.predict(bitmap);
          result = (results && results[0]) || null;
        } finally {
          /* Das SDK schließt das ImageBitmap im Erfolgsfall selbst; ein
             zweites close() ist harmlos und deckt den Fehlerpfad ab. */
          if (typeof bitmap.close === 'function') {
            try { bitmap.close(); } catch (e) { /* schon geschlossen */ }
          }
        }

        const lines = linesFromResult(result);
        const text = lines.join('\n');
        textCache.set(cacheKey, text);
        while (textCache.size > CACHE_MAX) textCache.delete(textCache.keys().next().value);
        const ms = Date.now() - t0;
        dlog('ocr ' + ms + 'ms ' + text.trim().length + ' chars [' + primary + ']');
        return { text, ms };
      } catch (e) {
        failChain++;
        /* Zwei Fehlschläge in Folge: vermutlich ist eine Pipeline gestorben →
           verwerfen, der nächste Aufruf initialisiert neu. Einzelne Fehler
           (etwa eine nicht ladbare Bild-URL) sind nicht fatal. */
        if (failChain >= 2) disposePipelines('Fehler');
        throw e;
      } finally {
        busy--;
        armIdle();
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  function status() {
    const readyLangs = sortedPipelineKeys(pipelines.keys()).map(langForPipeline);
    const loadingLangs = sortedPipelineKeys(pipelinePromises.keys()).map(langForPipeline);
    const loading = prepareActive > 0 || loadingLangs.length > 0;
    return {
      state: lastError ? 'error' : (loading ? 'loading' : (readyLangs.length ? 'ready' : 'off')),
      ready: readyLangs.length > 0,
      loading,
      langs: readyLangs,
      loadingLangs,
      stage,
      stageLang,
      progress: Math.max(0, Math.min(100, Math.round(stageProgress * 100))),
      error: lastError,
      cached: textCache.size
    };
  }

  self.YB_OCR_HOST = { recognize, prepare, status, reset: () => disposePipelines('reset') };
})();
