/* ocr-host.js — Tesseract-OCR-Host im privilegierten Kontext
   (Firefox: Background-Seite; Chrome MV3: Offscreen-Dokument, siehe offscreen.js).
   Warum nicht im Content-Script: YouTube erzwingt Trusted Types + CSP
   (`require-trusted-types-for 'script'`), dadurch schlägt `new Worker(...)` aus
   Content-Scripts synchron fehl ("Worker constructor: Sink type mismatch ... blocked by CSP").
   Der privilegierte Kontext unterliegt den Seitenrichtlinien nicht. Content-Scripts sprechen
   nur noch per runtime.sendMessage mit diesem Host.
   Alle Dateien liegen lokal im Paket: der Worker startet über ocr-worker.js
   (Log-Filter + Tesseract-Worker-Skript), Bibliothek, SIMD-WASM-Kern und
   Sprachdaten liegen in lib/ — kein CDN, kein Fernbezug zur Laufzeit.

   Erkennung seit 1.5.14 mehrstufig:
   1. schneller Lauf auf dem Originalbild (PSM 11, nur die wahrscheinliche Sprache),
   2. nur bei kurzem/unsicherem Text ein tiefer Lauf über präparierte Varianten
      (Graustufen/Otsu, Rot-Maske, helle Maske, Invertierung, dunkle Maske).
   Rot/Weiß getrennt zu erkennen ist bei stylisierten Thumbnails entscheidend;
   die Sprachmodelle werden bewusst nicht als „eng+rus“ gemischt. */
(function () {
  'use strict';

  const api = (typeof browser !== 'undefined') ? browser : chrome;
  const LIB_DIR = api.runtime.getURL('lib/');
  const LIB_URL = api.runtime.getURL('lib/tesseract.min.js');
  /* Worker-Einstieg mit Log-Filter (ocr-worker.js) — lädt den Tesseract-Worker. */
  const WORKER_URL = api.runtime.getURL('ocr-worker.js');
  /* Worker nach Leerlauf beenden → Speicher der wasm-Erkennung wird freigegeben.
     Nächster Treffer initialisiert lazy neu (alles liegt lokal, ~2–5 s). */
  const IDLE_MS = 10 * 60 * 1000;
  const CACHE_MAX = 400;   /* Bild-URL+Sprachen → Text (Dedupe über Karten/Tabs/Rescans) */

  /* Cache-Schlüssel mit Pipeline-Version: alte, schlechte OCR-Texte aus einer
     früheren Sitzung dürfen einen erneuten Lauf nicht verhindern. */
  const CACHE_VERSION = 'ocr-v3'; /* Rand + debug_file ändern das Erkennungsergebnis */
  const OCR_PSM = '11';          /* SPARSE_TEXT: mehrere getrennte Textblöcke */
  const OCR_DPI = '300';
  const FAST_MIN_CHARS = 16;     /* darunter lohnt der tiefe Lauf fast immer */
  const FAST_MIN_CONFIDENCE = 55;
  const DEEP_SCALE = 2;
  const DEEP_MAX_SIDE = 2600;    /* 1280×720 → 2560×1440, danach Speicherdeckel */
  /* Tesseract/Leptonica meldet bei Text am Bildrand „Error in
     boxClipToRectangle: box outside rectangle“ und „Error in
     pixScanForForeground: invalid box“ (upstream bekannt). Ein Rand um das
     Bild hält die Boxen innerhalb der Fläche, ohne den Text zu verändern. */
  const OCR_BORDER = 10;
  const MASK_MIN_COVERAGE = 0.0015;
  const MASK_MAX_COVERAGE = 0.70;
  /* Graustufen-Masken haben konstruktiv ~50 % Fläche; nur komplett leere oder
     komplett gefüllte Bilder bringen Tesseract zum Rechnen und erzeugen die
     Leptonica-Meldungen. */
  const GRAY_MIN_COVERAGE = 0.0005;
  const GRAY_MAX_COVERAGE = 0.9995;

  /* Ein Tesseract-Worker je Sprache: „eng+rus“ soll beide Modelle wirklich
     vorbereiten können, ohne sie in einem gemeinsamen Modell zu mischen.
     Die Worker werden beim Öffnen des Popups vorgewärmt (prepare) und nach
     zehn Minuten Leerlauf gemeinsam beendet. */
  const workers = new Map();          /* lang → fertiger Worker */
  const workerPromises = new Map();   /* lang → laufende Initialisierung */
  let loadPromise = null;             /* Single-Flight: Bibliothek nachladen */
  let queue = Promise.resolve();
  let busy = 0;
  let idleTimer = null;
  let failChain = 0;                  /* aufeinanderfolgende Erkennungsfehler */
  let lastError = null;
  let stage = '';                     /* Tesseract-Status für das Popup */
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

  function armIdle() {
    clearTimeout(idleTimer);
    if (!(IDLE_MS > 0)) return;
    idleTimer = setTimeout(() => {
      if (busy || workerPromises.size || prepareActive) { armIdle(); return; }
      terminateWorker('idle');
    }, IDLE_MS);
  }

  function terminateWorker(reason) {
    for (const w of workers.values()) {
      try { w.terminate(); } catch (e) { /* schon tot */ }
    }
    workers.clear();
    workerPromises.clear();
    preparePromise = null;
    prepareKey = '';
    lastError = null;
    stage = '';
    stageLang = '';
    stageProgress = 0;
    failChain = 0;
    dlog('ocr host: worker beendet (' + reason + ')');
  }

  /* Tesseract-Bibliothek (nur der API-Teil, ~68 KB) erst beim ersten OCR-Bedarf
     laden: Nutzer ohne Vorschaubild-OCR zahlen beim Start nichts dafür. */
  function loadLib() {
    if (self.Tesseract) return Promise.resolve();
    if (loadPromise) return loadPromise;
    loadPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = LIB_URL;
      s.onload = () => resolve();
      s.onerror = () => reject(markFatal(new Error('Tesseract-Bibliothek konnte nicht geladen werden')));
      (document.head || document.documentElement).appendChild(s);
    }).then(v => v, err => { loadPromise = null; throw err; });
    return loadPromise;
  }

  function makeLogger(lang) {
    let last = '';
    return m => {
      if (!m || !m.status || m.status === 'recognizing text') return;
      const progress = Number(m.progress);
      if (m.status !== last) {
        last = m.status;
        stage = m.status;
        stageLang = lang;
        stageProgress = Number.isFinite(progress) ? progress : 0;
        dlog('ocr host: ' + lang + ': ' + m.status);
      } else if (Number.isFinite(progress)) {
        stageProgress = progress;
      }
    };
  }

  /* ---------- Bildbeschaffung ----------
     Tesseracts Kern (Leptonica) liest JPEG, PNG, BMP, WebP und TIFF — aber
     kein AVIF. ytimg.com liefert Vorschaubilder inzwischen aber als AVIF
     (auch mit „Accept: image/jpeg“), sogar unter .jpg-URLs. Bis 1.5.6 lud
     Tesseract das Bild selbst; am AVIF scheiterte es mit „pixRead: Unknown
     format“ („Error attempting to read image“) — die Karte blieb ohne Text
     und chrome://extensions sammelte Fehler ein. Jetzt laden wir die Bytes
     selbst und wandeln alles, was der Kern nicht direkt liest, über den
     Browser (createImageBitmap → Canvas → PNG) um. Liefert eine URL kein
     Bild (404/HTML), wird sie stillschweigend übersprungen. */

  /* Liest der Tesseract-Kern dieses Format? (Signaturprüfung statt
     Content-Type — die Serverangabe kann vom Inhalt abweichen.) */
  function coreReadable(b) {
    if (b.length < 12) return false;
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return true;              /* JPEG */
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return true; /* PNG */
    if (b[0] === 0x42 && b[1] === 0x4D) return true;                                /* BMP */
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return true; /* WebP */
    if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A) ||
        (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0x00)) return true;             /* TIFF */
    return false;
  }

  function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
      if (!canvas || typeof canvas.toBlob !== 'function') {
        reject(new Error('Canvas-Export nicht verfügbar'));
        return;
      }
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Canvas-Export fehlgeschlagen'))), 'image/png');
    });
  }

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
    if (coreReadable(bytes)) return bytes;
    /* Fremdformat (AVIF & Co.): der Browser dekodiert es zuverlässig,
       Tesseract bekommt ein verlustfreies PNG. */
    try {
      const bitmap = await createImageBitmap(new Blob([bytes], { type: type || 'application/octet-stream' }));
      try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas-Kontext fehlt');
        ctx.drawImage(bitmap, 0, 0);
        const blob = await canvasToPngBlob(canvas);
        return new Uint8Array(await blob.arrayBuffer());
      } finally {
        if (typeof bitmap.close === 'function') bitmap.close();
      }
    } catch (e) {
      dlog('ocr host: Bild nicht dekodierbar (' + ((e && e.message) || e) + ')');
      return null;
    }
  }

  /* ---------- Vorverarbeitung für den tiefen Lauf ----------
     Tesseract mag dunkle Schrift auf hellem Grund. Je nach Thumbnail liegt
     der Text aber als Rot, Weiß oder Schwarz auf einem unruhigen Hintergrund.
     Darum erzeugen wir aus einem bereits dekodierten Bild mehrere binäre
     Varianten; jede Variante wird nur erkannt, wenn sie plausibel Text
     enthält (nicht fast leer und nicht fast flächig). */

  async function decodeBitmap(bytes) {
    if (typeof createImageBitmap !== 'function') return null;
    try {
      return await createImageBitmap(new Blob([bytes]));
    } catch (e) {
      dlog('ocr host: Bild für Varianten nicht dekodierbar (' + ((e && e.message) || e) + ')');
      return null;
    }
  }

  /* Weißer Rand vor dem schnellen Lauf. Der tiefe Lauf bekommt denselben Rand
     direkt in variantCanvas(); der Rand ist der upstream empfohlene Schutz
     gegen Leptonica-Boxfehler an der Bildkante. */
  async function padBytesForOcr(bytes) {
    const bitmap = await decodeBitmap(bytes);
    if (!bitmap) return null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width + OCR_BORDER * 2;
      canvas.height = bitmap.height + OCR_BORDER * 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, OCR_BORDER, OCR_BORDER);
      return canvas;
    } catch (e) {
      dlog('ocr host: Rand für Tesseract fehlgeschlagen (' + ((e && e.message) || e) + ')');
      return null;
    } finally {
      if (typeof bitmap.close === 'function') bitmap.close();
    }
  }

  function pixelLuma(r, g, b) {
    return (r * 299 + g * 587 + b * 114) / 1000;
  }

  function makeBaseImage(bitmap) {
    const bw = Number(bitmap && bitmap.width) || 0;
    const bh = Number(bitmap && bitmap.height) || 0;
    if (!bw || !bh) return null;
    const maxSide = Math.max(bw, bh);
    const scale = Math.min(DEEP_SCALE, DEEP_MAX_SIDE / maxSide);
    const width = Math.max(1, Math.round(bw * scale));
    const height = Math.max(1, Math.round(bh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = true;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    if (!image || !image.data) return null;
    return { data: image.data, width, height };
  }

  function otsuThreshold(data, width, height) {
    const hist = new Uint32Array(256);
    const total = width * height;
    for (let i = 0; i < data.length; i += 4) {
      const l = Math.round(pixelLuma(data[i], data[i + 1], data[i + 2]));
      hist[Math.max(0, Math.min(255, l))]++;
    }
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0;
    let weightB = 0;
    let best = -1;
    let threshold = 127;
    for (let i = 0; i < 256; i++) {
      weightB += hist[i];
      if (!weightB) continue;
      const weightF = total - weightB;
      if (!weightF) break;
      sumB += i * hist[i];
      const meanB = sumB / weightB;
      const meanF = (sum - sumB) / weightF;
      const between = weightB * weightF * (meanB - meanF) * (meanB - meanF);
      if (between > best) { best = between; threshold = i; }
    }
    return threshold;
  }

  function variantCanvas(base, mode, threshold) {
    const { data, width, height } = base;
    const outW = width + OCR_BORDER * 2;
    const outH = height + OCR_BORDER * 2;
    const out = new Uint8ClampedArray(outW * outH * 4);
    out.fill(255);   /* weißer Rand und weißer Hintergrund */
    let foreground = 0;
    let i = 0;
    for (let y = 0; y < height; y++) {
      let o = ((y + OCR_BORDER) * outW + OCR_BORDER) * 4;
      for (let x = 0; x < width; x++, i += 4, o += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        let on = false;
        if (a >= 32) {
          const l = pixelLuma(r, g, b);
          if (mode === 'gray') on = l <= threshold;
          else if (mode === 'gray-inv') on = l > threshold;
          else if (mode === 'red') {
            /* Bewusst locker: die dicken Buchstaben haben weiche Kanten und
               werden bei einer strengen Rot-Schwelle zerteilt. Der Test mit
               „RIP“ auf der Referenzkarte liest nur mit dieser Maske exakt. */
            on = r >= 70 && r - Math.max(g, b) >= 20;
          } else if (mode === 'bright') {
            on = l >= 175 && (Math.max(r, g, b) - Math.min(r, g, b)) <= 90;
          } else if (mode === 'dark') {
            on = l <= 75;
          }
        }
        if (on) {
          foreground++;
          out[o] = 0;
          out[o + 1] = 0;
          out[o + 2] = 0;
        }
      }
    }

    /* Masken, die fast nichts oder fast das ganze Bild als Text markieren,
       sind für Tesseract nur Rauschen und erzeugen die Leptonica-Meldungen.
       Für Graustufen gilt eine weitere Grenze, weil dort konstruktiv rund die
       Hälfte der Fläche markiert ist. */
    const coverage = foreground / (width * height);
    const min = (mode === 'gray' || mode === 'gray-inv') ? GRAY_MIN_COVERAGE : MASK_MIN_COVERAGE;
    const max = (mode === 'gray' || mode === 'gray-inv') ? GRAY_MAX_COVERAGE : MASK_MAX_COVERAGE;
    if (coverage < min || coverage > max) return null;

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const image = ctx.createImageData(outW, outH);
    image.data.set(out);
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  /* Ein Canvas kann Tesseract direkt übernehmen; der Byte-Weg bleibt als
     Fallback für Umgebungen, in denen die Canvas-Erkennung nicht greift. */
  async function recognizePass(w, image) {
    const res = await w.recognize(image);
    const data = (res && res.data) || {};
    const confidence = Number(data.confidence);
    return {
      text: String(data.text || ''),
      confidence: Number.isFinite(confidence) ? confidence : null
    };
  }

  async function recognizeCanvas(w, canvas) {
    try {
      return await recognizePass(w, canvas);
    } catch (e) {
      try {
        const blob = await canvasToPngBlob(canvas);
        return await recognizePass(w, new Uint8Array(await blob.arrayBuffer()));
      } catch (e2) {
        throw e;
      }
    }
  }

  async function deepPass(w, bytes) {
    const bitmap = await decodeBitmap(bytes);
    if (!bitmap) return [];
    const out = [];
    try {
      const base = makeBaseImage(bitmap);
      if (!base) return out;
      const threshold = otsuThreshold(base.data, base.width, base.height);
      const modes = ['gray', 'red', 'bright', 'gray-inv', 'dark'];
      for (const mode of modes) {
        const canvas = variantCanvas(base, mode, threshold);
        if (!canvas) continue;
        try {
          const res = await recognizeCanvas(w, canvas);
          const text = String(res.text || '').trim();
          if (text) {
            out.push(text);
            dlog('ocr host: deep ' + mode + ' ' + text.length + ' Zeichen');
          }
        } catch (e) {
          dlog('ocr host: deep ' + mode + ' fehlgeschlagen (' + ((e && e.message) || e) + ')');
        }
      }
    } catch (e) {
      dlog('ocr host: Varianten fehlgeschlagen (' + ((e && e.message) || e) + ')');
    } finally {
      if (typeof bitmap.close === 'function') bitmap.close();
    }
    return out;
  }

  /* ---------- Sprachen ----------
     „eng+rus“ wird nicht als ein Tesseract-Modell geladen: Latein und
     Kyrillisch konkurrieren dann bei kurzen, verzerrten Wörtern. Stattdessen
     wählen wir anhand von Titel/Kanal die wahrscheinlichere Schrift und
     laden nur deren Modell. Die andere Sprache bleibt dem Nutzer als
     Einstellung erhalten, falls das Thumbnail anders beschriftet ist. */
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

  function needsDeep(text, confidence) {
    const s = String(text || '').trim();
    if (!s) return true;
    if (s.length < FAST_MIN_CHARS) return true;
    if (!/[\p{L}\p{N}]{3}/u.test(s)) return true;
    if (Number.isFinite(confidence) && confidence < FAST_MIN_CONFIDENCE) return true;
    return false;
  }

  function mergeTexts(texts) {
    const seen = new Set();
    const out = [];
    for (const raw of texts || []) {
      const text = String(raw || '').trim();
      if (!text) continue;
      const key = text.replace(/\s+/g, ' ').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
    return out.join('\n');
  }

  /* Erstellen eines Tesseract-Workers für genau eine Sprache. Alles lokal:
     Einstieg ocr-worker.js, Tesseract-Worker-Skript, SIMD-Kern und
     .traineddata.gz aus dem Erweiterungspaket. */
  function ensureWorker(lang) {
    if (workers.has(lang)) return Promise.resolve(workers.get(lang));
    if (workerPromises.has(lang)) return workerPromises.get(lang);
    const promise = (async () => {
      await loadLib();
      /* tesseract.js 4.1.1 nimmt hier NUR ein Optionsobjekt entgegen
         (nicht „langs, oem, options“ wie v5): sonst bleiben workerPath/
         corePath/langPath wirkungslos und der Worker startet als blob:
         mit CDN-Standardpfaden — im Erweiterungskontext von der CSP
         blockiert. Sprache und API lädt 4.1.1 ebenfalls nicht selbst. */
      const w = await Tesseract.createWorker({
        workerPath: WORKER_URL,
        corePath: LIB_DIR,      /* Verzeichnis; der Worker wählt .../tesseract-core-simd.wasm.js */
        langPath: LIB_DIR,
        gzip: true,
        workerBlobURL: false,   /* Worker direkt von moz-extension:// laden (gleiche Herkunft) */
        logger: makeLogger(lang)
      });
      try {
        await w.loadLanguage(lang);
        await w.initialize(lang);
        /* PSM 11 liest mehrere getrennte Textblöcke; PSM 6 (SINGLE_BLOCK) hat
           bei freigestellten Thumbnail-Überschriften zu viel zusammengezogen. */
        await w.setParameters({
          tessedit_pageseg_mode: OCR_PSM,
          user_defined_dpi: OCR_DPI,
          preserve_interword_spaces: '1',
          /* Tesseract schreibt „Detected N diacritics“ und andere
             tprintf-Diagnosen sonst nach stderr; /dev/null hält das
             Erweiterungsprotokoll frei, ohne die Erkennung zu ändern. */
          debug_file: '/dev/null'
        });
      } catch (e) {
        try { w.terminate(); } catch (e2) { /* schon tot */ }
        throw e;
      }
      return w;
    })().then(w => {
      workerPromises.delete(lang);
      workers.set(lang, w);
      lastError = null;
      stage = '';
      stageLang = '';
      stageProgress = 0;
      failChain = 0;
      dlog('ocr host: worker bereit (' + lang + ')');
      return w;
    }).catch(err => {
      workerPromises.delete(lang);
      lastError = String((err && err.message) || err);
      stage = '';
      stageLang = '';
      stageProgress = 0;
      throw markFatal(err);
    });
    workerPromises.set(lang, promise);
    return promise;
  }

  /* Vorwärmen für das Popup: alle in der Einstellung gewählten Sprachen
     wirklich initialisieren. „eng+rus“ lädt bewusst zwei getrennte Worker,
     damit die Anzeige „bereit“ nicht lügt und später kein Sprachwechsel mehr
     nötig ist. */
  function prepare(langs) {
    const list = splitLangs(langs);
    const key = list.join('+');
    if (preparePromise && prepareKey === key) return preparePromise;
    const run = prepareChain.then(async () => {
      prepareActive++;
      try {
        lastError = null;
        for (const lang of list) await ensureWorker(lang);
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
        const bytes = await imageBytesFor(url);
        if (!bytes) {
          /* Kein verwertbares Bild: Karte gilt als „ohne Text“. Bewusst
             NICHT cachen — ein späterer Rescan darf die URL erneut versuchen. */
          dlog('ocr host: Bild übersprungen ' + String(url).slice(0, 90));
          return { text: '', skipped: true };
        }

        const primary = primaryLang(lang, hintText);
        const w = await ensureWorker(primary);
        /* Rand vor dem schnellen Lauf: verhindert die Leptonica-Boxfehler an
           der Bildkante. Scheitert die Umwandlung, bleibt der direkte Weg. */
        const padded = await padBytesForOcr(bytes);
        const fast = padded ? await recognizeCanvas(w, padded) : await recognizePass(w, bytes);
        failChain = 0;

        const texts = [fast.text];
        let deep = false;
        if (needsDeep(fast.text, fast.confidence)) {
          deep = true;
          texts.push(...await deepPass(w, bytes));
        }

        const text = mergeTexts(texts);
        textCache.set(cacheKey, text);
        while (textCache.size > CACHE_MAX) textCache.delete(textCache.keys().next().value);
        const ms = Date.now() - t0;
        dlog('ocr ' + ms + 'ms ' + text.trim().length + ' chars' +
          (deep ? ' (deep)' : '') + ' [' + primary + ']');
        return { text, ms };
      } catch (e) {
        failChain++;
        /* Zwei Fehlschläge in Folge: vermutlich ist der Worker gestorben →
           verwerfen, der nächste Aufruf initialisiert neu. Einzelne Fehler
           (etwa eine nicht ladbare Bild-URL) sind nicht fatal. */
        if (failChain >= 2) terminateWorker('Fehler');
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
    const readyLangs = Array.from(workers.keys());
    const loadingLangs = Array.from(workerPromises.keys());
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

  self.YB_OCR_HOST = { recognize, prepare, status, reset: () => terminateWorker('reset') };
})();
