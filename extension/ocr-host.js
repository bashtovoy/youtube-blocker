/* ocr-host.js — Tesseract-OCR-Host im privilegierten Kontext
   (Firefox: Background-Seite; Chrome MV3: Offscreen-Dokument, siehe offscreen.js).
   Warum nicht im Content-Script: YouTube erzwingt Trusted Types + CSP
   (`require-trusted-types-for 'script'`), dadurch schlägt `new Worker(...)` aus
   Content-Scripts synchron fehl ("Worker constructor: Sink type mismatch ... blocked by CSP").
   Der privilegierte Kontext unterliegt den Seitenrichtlinien nicht. Content-Scripts sprechen
   nur noch per runtime.sendMessage mit diesem Host.
   Alle Dateien liegen lokal im Paket: der Worker startet über ocr-worker.js
   (Log-Filter + Tesseract-Worker-Skript), Bibliothek, SIMD-WASM-Kern und
   Sprachdaten liegen in lib/ — kein CDN, kein Fernbezug zur Laufzeit. */
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
      const bitmap = await createImageBitmap(new Blob([bytes], { type: type || 'image/png' }));
      try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        const blob = await new Promise((resolve, reject) => {
          canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Canvas-Export fehlgeschlagen'))), 'image/png');
        });
        return new Uint8Array(await blob.arrayBuffer());
      } finally {
        if (typeof bitmap.close === 'function') bitmap.close();
      }
    } catch (e) {
      dlog('ocr host: Bild nicht dekodierbar (' + ((e && e.message) || e) + ')');
      return null;
    }
  }

  /* Erstellen/Erneuern des Tesseract-Workers. Alles lokal: Einstieg ocr-worker.js,
     Tesseract-Worker-Skript, SIMD-Kern und .traineddata.gz aus dem Erweiterungspaket. */
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
        const bytes = await imageBytesFor(url);
        if (!bytes) {
          /* Kein verwertbares Bild: Karte gilt als „ohne Text“. Bewusst
             NICHT cachen — ein späterer Rescan darf die URL erneut versuchen. */
          dlog('ocr host: Bild übersprungen ' + String(url).slice(0, 90));
          return { text: '', skipped: true };
        }
        const res = await w.recognize(bytes);
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
