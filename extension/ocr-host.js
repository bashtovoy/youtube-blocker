/* ocr-host.js — Tesseract-OCR-Host im privilegierten Kontext (Background-Seite).
   Warum nicht im Content-Script: YouTube erzwingt Trusted Types + CSP
   (`require-trusted-types-for 'script'`), dadurch schlägt `new Worker(...)` aus
   Content-Scripts synchron fehl ("Worker constructor: Sink type mismatch ... blocked by CSP").
   Die Background-Seite unterliegt den Seitenrichtlinien nicht. Content-Scripts sprechen
   nur noch per runtime.sendMessage mit diesem Host.
   Alle Dateien liegen lokal im Paket (lib/): Tesseract-Bibliothek, Worker-Skript,
   SIMD-WASM-Kern und Sprachdaten — kein CDN, kein Fernbezug zur Laufzeit.
   Für Chrome MV3 später unverändert in ein Offscreen-Dokument übernehmbar. */
(function () {
  'use strict';

  const api = (typeof browser !== 'undefined') ? browser : chrome;
  const LIB_DIR = api.runtime.getURL('lib/');
  const LIB_URL = api.runtime.getURL('lib/tesseract.min.js');
  const WORKER_URL = api.runtime.getURL('lib/worker-tesseract.min.js');
  /* Worker nach Leerlauf beenden → Speicher der wasm-Erkennung wird freigegeben.
     Nächster Treffer initialisiert lazy neu (alles liegt lokal, ~2–5 s). */
  const IDLE_MS = 10 * 60 * 1000;
  const CACHE_MAX = 400;   /* Bild-URL+Sprachen → Text (Dedupe über Karten/Tabs/Rescans) */

  let worker = null;
  let workerLangs = null;
  let loadPromise = null;     /* Single-Flight: Bibliothek nachladen */
  let createPromise = null;   /* Single-Flight: Worker erstellen */
  let queue = Promise.resolve();
  let busy = 0;
  let idleTimer = null;
  let failChain = 0;          /* aufeinanderfolgende Erkennungsfehler */
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
      if (busy || createPromise) { armIdle(); return; }   /* noch Arbeit unterwegs */
      terminateWorker('idle');
    }, IDLE_MS);
  }

  function terminateWorker(reason) {
    if (worker) { try { worker.terminate(); } catch (e) { /* schon tot */ } }
    worker = null;
    workerLangs = null;
    createPromise = null;
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

  function makeLogger() {
    let last = '';
    return m => {
      if (!m || !m.status || m.status === 'recognizing text') return;
      if (m.status === last) return;
      last = m.status;
      dlog('ocr host: ' + m.status);
    };
  }

  /* Erstellen/Erneuern des Tesseract-Workers. Alles lokal: Worker-Skript,
     SIMD-Kern und .traineddata.gz kommen aus lib/ im Erweiterungspaket. */
  function ensureWorker(langs) {
    if (worker && workerLangs === langs) return Promise.resolve(worker);
    if (worker) terminateWorker('Sprachwechsel');
    workerLangs = langs;
    const wanted = langs;
    createPromise = (async () => {
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
        logger: makeLogger()
      });
      await w.loadLanguage(wanted);
      await w.initialize(wanted);
      return w;
    })().then(w => {
      createPromise = null;
      worker = w;
      failChain = 0;
      dlog('ocr host: worker bereit (' + wanted + ')');
      return w;
    }).catch(err => {
      createPromise = null;
      worker = null;
      workerLangs = null;
      throw markFatal(err);
    });
    return createPromise;
  }

  function recognize(url, langs) {
    const lang = String(langs || 'eng+rus');
    const cacheKey = lang + '\u0001' + url;
    if (textCache.has(cacheKey)) {
      return Promise.resolve({ text: textCache.get(cacheKey), cached: true });
    }
    const run = queue.then(async () => {
      busy++;
      try {
        const w = await ensureWorker(lang);
        const t0 = Date.now();
        const res = await w.recognize(url);
        const text = String((res && res.data && res.data.text) || '');
        failChain = 0;
        textCache.set(cacheKey, text);
        while (textCache.size > CACHE_MAX) textCache.delete(textCache.keys().next().value);
        const ms = Date.now() - t0;
        dlog('ocr ' + ms + 'ms ' + text.trim().length + ' chars');
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
    return { ready: !!worker, langs: workerLangs, cached: textCache.size };
  }

  self.YB_OCR_HOST = { recognize, status, reset: () => terminateWorker('reset') };
})();
