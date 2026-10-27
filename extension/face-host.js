/* face-host.js — lokaler MediaPipe-Host für Gesichtsausdrücke in Vorschaubildern.
   Firefox MV2: Background-Seite. Chrome MV3: Offscreen-Dokument (offscreen.html).
   Der Service Worker kann kein DOM/keine Hosts erzeugen; er reicht die
   Nachrichten nur weiter (host-routes.js → dieser Host).

   Es wird ausschließlich lokal gerechnet:
   - das MediaPipe-Bundle, die Wasm-Dateien und face_landmarker.task liegen
     unter lib/mediapipe/ im Paket,
   - das Bild kommt von i.ytimg.com (bereits als Host-Berechtigung vorhanden),
   - es werden keine Landmarken, Bilder oder Embeddings gespeichert.

   Bewertung: face-score.js. Dieser Host kümmert sich nur um Modell-Lebenszyklus,
   Bildabruf, Warteschlange, Kürzung und den Status für das Popup. */
(function () {
  'use strict';

  const api = (typeof browser !== 'undefined') ? browser : chrome;
  const root = self;
  /* Das MediaPipe-Bundle meldet Nutzungsdaten an odml.pa.googleapis.com. Die
     CSP blockiert das bereits; der Guard beendet den Aufruf vorher, damit die
     Blockade nicht als Konsolenfehler in der AMO-Validierung auftaucht. */
  const nativeFetch = root.fetch;
  if (typeof nativeFetch === 'function') {
    root.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/^https?:\/\/odml\.pa\.googleapis\.com\//.test(url)) {
        return Promise.resolve({ ok: true, status: 204, text: () => Promise.resolve('') });
      }
      return nativeFetch.call(root, input, init);
    };
  }
  const SCORE = root.YB_FACE_SCORE;
  const LIB_DIR = api.runtime.getURL('lib/mediapipe/');
  const VISION_SCRIPT = LIB_DIR + 'vision_bundle.js';
  const WASM_DIR = LIB_DIR + 'wasm';
  const MODEL_URL = LIB_DIR + 'face_landmarker.task';
  const STATUS_KEY = 'faceStatus';

  /* Nach Leerlauf die Modelle freigeben: FaceLandmarker hält mehrere
     Wasm-Modelle; zusammen mit SigLIP/PaddleOCR soll der Speicher nicht
     dauerhaft wachsen. Der nächste Treffer lädt lokal in ~1–2 s neu. */
  const IDLE_MS = 5 * 60 * 1000;
  const FETCH_TIMEOUT_MS = 8000;
  const CACHE_MAX = 500;
  const QUEUE_MAX = 200;
  const CACHE_VERSION = SCORE ? SCORE.FACE_SCORE_VERSION : 'face-score-v1';

  let landmarker = null;
  let modelPromise = null;
  let visionPromise = null;
  let generation = 0;
  let queue = Promise.resolve();
  let pendingCount = 0;
  let idleTimer = null;
  let lastError = null;
  let state = 'off';
  let initMs = 0;
  let lastScoreMs = 0;
  let lastUsedAt = 0;
  let lastSkipped = '';
  const cache = new Map();       /* videoId → Ergebnis */
  const pending = new Map();     /* videoId → laufende Promise */

  function dlog(line) {
    if (typeof root.YB_DEVLOG === 'function') {
      try { root.YB_DEVLOG(line); } catch (e) { /* Dev-Log optional */ }
    }
  }

  function saveStatus() {
    const payload = {
      state,
      model: 'face-landmarker',
      delegate: 'CPU',
      error: lastError,
      initMs,
      lastScoreMs,
      lastUsedAt,
      cacheSize: cache.size,
      lastSkipped,
      updatedAt: Date.now()
    };
    try {
      /* Chrome-Offscreen hat keinen storage-Zugriff → Dienstweg über den SW. */
      if (typeof root.YB_STATUS_SINK === 'function') root.YB_STATUS_SINK(STATUS_KEY, payload);
      else api.storage.local.set({ [STATUS_KEY]: payload });
    } catch (e) { /* Status ist optional */ }
  }

  function setState(next, err) {
    state = next;
    if (next === 'error') lastError = String((err && err.message) || err || 'unbekannt');
    else if (next === 'loading' || next === 'ready') lastError = null;
    saveStatus();
    dlog('face host: ' + state +
      (initMs ? ' init=' + initMs + 'ms' : '') +
      (lastError ? ' error=' + lastError : ''));
  }

  function markFatal(err) {
    if (err && typeof err === 'object') err.fatal = true;
    return err;
  }

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = null;
    /* Ohne geladenes Modell gibt es nichts freizugeben; besonders wichtig für
       den Skip-Pfad (Bild fehlt), der kein Modell gestartet hat. */
    if (!landmarker || !(IDLE_MS > 0)) return;
    idleTimer = setTimeout(() => {
      if (pendingCount || pending.size) { armIdle(); return; }
      disposeModel('idle');
    }, IDLE_MS);
  }

  function disposeModel(reason) {
    generation++;
    if (landmarker) {
      try { landmarker.close(); } catch (e) { /* Modell schon beendet */ }
    }
    landmarker = null;
    modelPromise = null;
    lastError = null;
    lastSkipped = '';
    clearTimeout(idleTimer);
    idleTimer = null;
    if (state !== 'off') setState('off');
    dlog('face host: Modell beendet (' + reason + ')');
  }

  /* Das UMD-Bundle wird erst geladen, wenn der Nutzer den Kanal einschaltet.
     Es setzt self.Vision und funktioniert sowohl in der Firefox-Background-
     Seite als auch im Chrome-Offscreen-Dokument ohne ES-Modul-Import. */
  function loadVisionScript() {
    if (root.Vision) return Promise.resolve(root.Vision);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = VISION_SCRIPT;
      s.onload = () => root.Vision ? resolve(root.Vision)
        : reject(markFatal(new Error('MediaPipe-Bundle ohne Vision-Export')));
      s.onerror = () => reject(markFatal(new Error('MediaPipe-Bundle konnte nicht geladen werden')));
      (document.head || document.documentElement || document.body).appendChild(s);
    });
  }

  function loadVision() {
    if (root.YB_FACE_VISION) return Promise.resolve(root.YB_FACE_VISION);
    if (root.Vision) return Promise.resolve(root.Vision);
    if (visionPromise) return visionPromise;
    visionPromise = loadVisionScript().catch(err => {
      visionPromise = null;
      throw markFatal(err);
    });
    return visionPromise;
  }

  async function ensureModel() {
    if (landmarker) return landmarker;
    if (modelPromise) return modelPromise;
    const gen = generation;
    const promise = (async () => {
      setState('loading');
      const t0 = Date.now();
      const vision = await loadVision();
      if (gen !== generation) throw markFatal(new Error('Face-Host wurde zurückgesetzt'));
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_DIR);
      if (gen !== generation) throw markFatal(new Error('Face-Host wurde zurückgesetzt'));
      const model = await vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        numFaces: 2,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputFaceBlendshapes: true
      });
      if (gen !== generation) {
        try { model.close(); } catch (e) { /* schon beendet */ }
        throw markFatal(new Error('Face-Host wurde zurückgesetzt'));
      }
      landmarker = model;
      initMs = Date.now() - t0;
      setState('ready');
      armIdle();
      return landmarker;
    })().catch(err => {
      if (modelPromise === promise) modelPromise = null;
      /* Ein Reset während des Ladens darf den Host nicht nachträglich auf
         „error“ setzen; der Reset bleibt die letzte Entscheidung. */
      if (gen !== generation) throw markFatal(new Error('Face-Host wurde zurückgesetzt'));
      setState('error', err);
      throw markFatal(err);
    });
    modelPromise = promise;
    return promise;
  }

  /* ---------- Bildbeschaffung ----------
     Nur ytimg-URLs aus einer geprüften videoId. Kein beliebiger URL-Fetch aus
     dem Content-Script (SSRF-Schutz). mqdefault ist 16:9 und reicht für den
     Detektor; hqdefault ist der Fallback für ältere/fehlende Varianten. */
  async function fetchThumb(videoId) {
    if (!SCORE || !SCORE.validVideoId(videoId)) throw new Error('Ungültige Video-ID');
    let lastStatus = 0;
    for (const quality of SCORE.THUMB_QUALITIES) {
      const url = SCORE.thumbnailUrl(videoId, quality);
      if (!url) continue;
      let res;
      let Abort = null;
      let timer = null;
      try {
        /* Ein hängender CDN-/Netzwerk-Request darf die gesamte Face-Queue
           nicht blockieren. Der Timeout gilt pro Qualitätsstufe. */
        if (typeof AbortController === 'function') {
          Abort = new AbortController();
          timer = setTimeout(() => Abort.abort(), FETCH_TIMEOUT_MS);
        }
        res = await fetch(url, {
          credentials: 'omit',
          signal: Abort ? Abort.signal : undefined
        });
      } catch (e) {
        dlog('face host: Bildabruf fehlgeschlagen (' + ((e && e.message) || e) + ')');
        continue;
      } finally {
        if (timer) clearTimeout(timer);
      }
      lastStatus = res && res.status;
      if (!res || !res.ok) continue;
      const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
      if (type && !/^image\//i.test(type)) continue;
      let bytes;
      try {
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        continue;
      }
      if (!bytes.length) continue;
      return { bytes, type };
    }
    dlog('face host: kein Vorschaubild (' + (lastStatus || '?') + ')');
    return null;
  }

  async function decodeImage(image) {
    if (!image || typeof createImageBitmap !== 'function') return null;
    try {
      return await createImageBitmap(new Blob([image.bytes], {
        type: image.type || 'application/octet-stream'
      }));
    } catch (e) {
      dlog('face host: Bild nicht dekodierbar (' + ((e && e.message) || e) + ')');
      return null;
    }
  }

  function cacheGet(key) {
    if (!cache.has(key)) return null;
    const value = cache.get(key);
    /* Map als LRU: getroffene Einträge ans Ende. */
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  function cachePut(key, value) {
    cache.set(key, value);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  async function scoreNow(videoId) {
    pendingCount += 1;
    clearTimeout(idleTimer);
    try {
      const image = await fetchThumb(videoId);
      if (!image) {
        lastSkipped = 'image';
        return { score: 0, faces: 0, faceWidth: 0, signals: null, skipped: 'image', ms: 0 };
      }
      const bitmap = await decodeImage(image);
      if (!bitmap) {
        lastSkipped = 'decode';
        return { score: 0, faces: 0, faceWidth: 0, signals: null, skipped: 'decode', ms: 0 };
      }
      try {
        const model = await ensureModel();
        const t0 = Date.now();
        const result = await Promise.resolve(model.detect(bitmap));
        const scored = SCORE.scoreResult(result);
        lastScoreMs = Date.now() - t0;
        lastUsedAt = Date.now();
        lastSkipped = '';
        dlog('face host: ' + videoId + ' score=' + scored.score.toFixed(3) +
          ' faces=' + scored.faces + ' width=' + scored.faceWidth.toFixed(3) +
          ' ' + lastScoreMs + 'ms');
        return Object.assign(scored, { ms: lastScoreMs });
      } finally {
        try { bitmap.close(); } catch (e) { /* Bitmap schon freigegeben */ }
      }
    } finally {
      pendingCount = Math.max(0, pendingCount - 1);
      armIdle();
    }
  }

  function score(videoId) {
    const id = String(videoId || '');
    if (!SCORE || !SCORE.validVideoId(id)) {
      return Promise.reject(new Error('Ungültige Video-ID'));
    }
    const key = CACHE_VERSION + '|' + id;
    const hit = cacheGet(key);
    if (hit) return Promise.resolve(Object.assign({}, hit, { cached: true }));
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= QUEUE_MAX) {
      return Promise.reject(markFatal(new Error('Face-Warteschlange voll')));
    }
    const run = queue.then(() => scoreNow(id), () => scoreNow(id));
    queue = run.catch(() => {});
    const shared = run.then(result => {
      /* Bildfehler nicht cachen: beim nächsten Sichtbarwerden erneut versuchen. */
      if (result && !result.skipped) cachePut(key, result);
      saveStatus();
      return result;
    });
    pending.set(key, shared);
    return shared.finally(() => {
      if (pending.get(key) === shared) pending.delete(key);
    });
  }

  async function prepare() {
    await ensureModel();
    return status();
  }

  function status() {
    return {
      state,
      model: 'face-landmarker',
      delegate: 'CPU',
      error: lastError,
      initMs,
      lastScoreMs,
      lastUsedAt,
      cacheSize: cache.size,
      lastSkipped,
      version: CACHE_VERSION
    };
  }

  function reset() {
    cache.clear();
    disposeModel('reset');
    saveStatus();
  }

  root.YB_FACE_HOST = { score, prepare, status, reset };
  setState('off');
})();
