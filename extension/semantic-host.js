/* semantic-host.js — SigLIP-Worker-Host im privilegierten Kontext
   (Firefox: Background-Seite; Chrome MV3: Offscreen-Dokument, siehe offscreen.js).
   Warum nicht im Content-Script: YouTube erzwingt Trusted Types + CSP
   (`require-trusted-types-for 'script'`), dadurch schlägt `new Worker(...)` aus
   Content-Scripts synchron fehl ("Worker constructor: Sink type mismatch ... blocked by CSP").
   Der privilegierte Kontext unterliegt den Seitenrichtlinien nicht. Content-Scripts sprechen
   nur noch per runtime.sendMessage mit diesem Host. */
(function () {
  'use strict';

  const api = (typeof browser !== 'undefined') ? browser : chrome;
  const WORKER_URL = api.runtime.getURL('semantic-worker.js');
  const STATUS_KEY = 'semStatus';
  /* Worker nach Leerlauf beenden → Speicher der wasm-Inferenz wird freigegeben.
     Nächster Treffer initialisiert lazy neu (Modell liegt lokal, ~1–3 s). */
  const IDLE_MS = 10 * 60 * 1000;

  let worker = null;
  let seq = 0;
  const pending = new Map();
  let initPromise = null;
  let textsKey = null;
  let lastTexts = [];
  let lastKey = '';
  /* Text-Embeddings überleben den Worker-Abbau im Host: Nach einem Idle-
     Teardown werden sie zurückgespielt (set-text-embeds) statt erneut
     berechnet (spart den vollen Text-Lauf inkl. 218-MB-Modell). */
  let textCache = null;        /* { key, embeds, dim, labels } */
  let workerHasTexts = false;
  let state = 'off';
  let device = null;
  let lastError = null;
  let errorKey = null;
  let initMs = 0;
  let lastScoreMs = 0;
  let lastUsedAt = 0;
  /* true = Modelldateien liegen (im Browser-Cache bzw. wurden geladen) und der
     Kanal startet nach einem Neustart ohne erneuten Download; null = unbekannt. */
  let filesCached = null;
  let idleTimer = null;
  let queue = Promise.resolve();
  let preparePromise = null;
  /* Erstbezug der Modell-Dateien: Fortschritt für das Popup mitführen. */
  let dl = null;
  let lastDlSaveAt = 0;
  let dlStartedLogged = false;
  /* Scores pro Bild-URL + Wortlisten-Version cachen (Dedupe über Karten/Tabs/Rescans). */
  const scoreCache = new Map();
  const SCORE_CACHE_MAX = 200;

  function dlog(line) {
    if (typeof self.YB_DEVLOG === 'function') { try { self.YB_DEVLOG(line); } catch (e) { /* Dev-Log optional */ } }
  }

  function saveStatus() {
    const payload = { state, device, error: lastError, initMs, lastScoreMs, updatedAt: Date.now(), dl, cached: filesCached };
    try {
      /* Chrome-Offscreen hat keinen storage-Zugriff → Dienstweg über den Service Worker. */
      if (typeof self.YB_STATUS_SINK === 'function') self.YB_STATUS_SINK(STATUS_KEY, payload);
      else api.storage.local.set({ [STATUS_KEY]: payload });
    } catch (e) { /* Status ist optional */ }
  }

  /* Downloadfortschritt (Erstbezug): im Popup sichtbar; Speichern gedrosselt,
     damit nicht jedes Häppchen in storage.local schreibt. */
  function onProgress(m) {
    const pct = Number.isFinite(Number(m.progress)) ? Math.max(0, Math.min(100, Number(m.progress))) : 0;
    dl = {
      phase: m.phase || '',
      file: String(m.file || ''),
      loaded: m.loaded || 0,
      total: m.total || 0,
      progress: pct,
      status: m.status || 'progress'
    };
    if (!dlStartedLogged) {
      dlStartedLogged = true;
      dlog('sem host: modell-dateien laden (Erstbezug einmalig von HF, danach Browser-Cache)');
    }
    if (state !== 'loading') setState('loading');
    if (Date.now() - lastDlSaveAt > 400) {
      lastDlSaveAt = Date.now();
      saveStatus();
    }
  }

  function setState(next, err) {
    state = next;
    lastError = next === 'error' ? (err || lastError) : null;
    saveStatus();
    dlog('sem host: ' + state
      + (device ? ' device=' + device : '')
      + (initMs ? ' init=' + initMs + 'ms' : '')
      + (lastError ? ' error=' + lastError : ''));
  }

  function markFatal(err) {
    if (err && typeof err === 'object') err.fatal = true;
    return err;
  }

  function armIdle() {
    clearTimeout(idleTimer);
    if (!(IDLE_MS > 0)) return;
    idleTimer = setTimeout(() => {
      if (pending.size) { armIdle(); return; }   /* noch eine Anfrage unterwegs */
      terminateWorker('idle');
    }, IDLE_MS);
  }

  function terminateWorker(reason, keepInit) {
    if (worker) { try { worker.terminate(); } catch (e) { /* schon tot */ } }
    worker = null;
    if (!keepInit) initPromise = null;
    textsKey = null;
    workerHasTexts = false;
    device = null;
    errorKey = null;
    dl = null;
    dlStartedLogged = false;
    if (state !== 'off') setState('off');
    dlog('sem host: worker beendet (' + reason + ')');
  }

  function rejectAll(err) {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(WORKER_URL, { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'progress') { onProgress(m); return; }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.type === 'ready') p.resolve(m);
      else if (m.type === 'texts-ready') p.resolve(m);
      else if (m.type === 'image-scores') p.resolve(m.scores);
      else {
        const err = new Error(m.error || 'Semantik-Worker-Fehler');
        if (m.retryable) err.retryable = true;
        if (m.deviceFallback) err.deviceFallback = m.deviceFallback;
        /* Netz-/Downloadfehler sind wiederholbar → Kanal bleibt aktiv. */
        if (p.type === 'init' && !err.retryable && !err.deviceFallback) markFatal(err);
        p.reject(err);
      }
    };
    worker.onerror = (e) => {
      const err = markFatal(new Error((e && e.message) || 'Semantik-Worker fehlgeschlagen'));
      const w = worker;
      worker = null;
      initPromise = null;
      textsKey = null;
      workerHasTexts = false;
      device = null;
      errorKey = lastKey || null;
      rejectAll(err);
      if (w) { try { w.terminate(); } catch (e2) { /* schon tot */ } }
      setState('error', err.message);
    };
    return worker;
  }

  function request(type, payload) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      let w;
      try { w = ensureWorker(); } catch (e) { reject(markFatal(e)); return; }
      pending.set(id, { resolve, reject, type });
      w.postMessage({ type, id, ...payload });
    });
  }

  async function init() {
    if (initPromise) return initPromise;
    setState('loading');
    const t0 = Date.now();
    initPromise = (async () => {
      const guess = (self.navigator && self.navigator.gpu) ? 'webgpu' : 'wasm';
      let res;
      try {
        res = await request('init', { device: guess });
      } catch (err) {
        /* Meldet der Worker einen nötigen Gerätewechsel (etwa kein GPU-Adapter),
           braucht der Wasm-Versuch einen frischen Worker: Der gescheiterte
           WebGPU-Versuch beschädigt den ONNX-Zustand dauerhaft. Laufende
           Anfragen (der parallele Text-Turm) werden als workerLost gemeldet
           und nach dem Wechsel wiederholt. */
        if (!err || !err.deviceFallback || guess === err.deviceFallback) throw err;
        dlog('sem host: Gerätewechsel ' + guess + '→' + err.deviceFallback + ' (frischer Worker)');
        for (const [id, p] of pending) {
          pending.delete(id);
          const lost = new Error('Worker während Gerätewechsel ersetzt');
          lost.workerLost = true;
          p.reject(lost);
        }
        terminateWorker('Gerätewechsel', true);
        res = await request('init', { device: err.deviceFallback });
      }
      device = res.device || null;
      initMs = Date.now() - t0;
      /* Türme geladen (Cache, lokale Dateien oder Erstbezug) → Bestand ist da;
         nach einem Neustart darf die Statusanzeige grün bleiben. */
      filesCached = true;
      return res;
    })().catch(err => {
      initPromise = null;
      if (err && err.retryable) {
        /* Erstbezug/Netz: nicht fatal — der nächste Versuch startet erneut. */
        dlog('sem host: init wiederholbar fehlgeschlagen (' + err.message + ')');
        setState('off');
      } else {
        markFatal(err);
        setState('error', err.message);
      }
      throw err;
    });
    return initPromise;
  }

  /* Modell bereit + Texte gesetzt (nach Idle-Abbau transparent erneut).
     Single-Flight: mehrere Karten/Tabs dürfen prepare nicht parallel auslösen.
     init() und set-texts laufen parallel (getrennte Türme); bei warmem
     textCache werden die Embeddings nur zurückgespielt. */
  async function prepare() {
    if (state === 'error' && errorKey === lastKey) {
      throw markFatal(new Error(lastError || 'Semantik nicht verfügbar'));
    }
    if (preparePromise) return preparePromise;
    preparePromise = (async () => {
      try {
        const tasks = [init()];
        if (!workerHasTexts || textsKey !== lastKey) {
          if (textCache && textCache.key === lastKey) {
            tasks.push(request('set-text-embeds', {
              embeds: textCache.embeds,
              dim: textCache.dim,
              labels: textCache.labels
            }).then(() => {
              workerHasTexts = true;
              textsKey = lastKey;
            }));
          } else {
            const runSetTexts = () => request('set-texts', { texts: lastTexts }).then(res => {
              textCache = {
                key: lastKey,
                embeds: res.embeds,
                dim: res.dim,
                labels: Array.isArray(res.labels) ? res.labels : lastTexts
              };
              workerHasTexts = true;
              textsKey = lastKey;
              scoreCache.clear();
            });
            tasks.push(runSetTexts().catch(err => {
              /* Der parallele init() hat bei einem Gerätewechsel den Worker
                 ersetzt — auf dem frischen Worker einmal wiederholen. */
              if (err && err.workerLost) return runSetTexts();
              throw err;
            }));
          }
        }
        await Promise.all(tasks);
        /* Die Text-Turm-Aufgabe kann den Status nach init() wieder auf
           „loading“ gesetzt haben (Downloadfortschritt) — hier sauber
           abschließen, sonst bliebe das Popup bei „lädt“ hängen. */
        if (state !== 'ready') setState('ready');
        errorKey = null;
      } catch (e) {
        if (e && e.fatal) {
          errorKey = lastKey;
          if (state !== 'error') setState('error', e.message);
        }
        armIdle();
        throw e;
      } finally {
        preparePromise = null;
      }
      lastUsedAt = Date.now();
      armIdle();
    })();
    return preparePromise;
  }

  async function ensure(texts, key) {
    lastTexts = (texts || []).map(String);
    lastKey = key || lastTexts.join('\u0001');
    await prepare();
    return true;
  }

  async function score(url) {
    if (!lastKey) throw new Error('Semantik: Textkonzepte sind noch nicht gesetzt');
    const cacheKey = lastKey + '\u0001' + url;
    if (scoreCache.has(cacheKey)) return scoreCache.get(cacheKey);
    await prepare();
    const run = queue.then(async () => {
      const t0 = Date.now();
      const scores = await request('score-image', { source: url });
      lastScoreMs = Date.now() - t0;
      lastUsedAt = Date.now();
      saveStatus();
      scoreCache.set(cacheKey, scores);
      while (scoreCache.size > SCORE_CACHE_MAX) scoreCache.delete(scoreCache.keys().next().value);
      let top = -Infinity, topText = '';
      for (const s of scores || []) {
        if (s && Number.isFinite(s.cos) && s.cos > top) { top = s.cos; topText = s.text || ''; }
      }
      if (!Number.isFinite(top)) top = 0;
      dlog('sem score ' + lastScoreMs + 'ms top=' + top.toFixed(3) + (topText ? ' (' + topText + ')' : ''));
      armIdle();
      return scores;
    });
    queue = run.catch(() => {});
    return run;
  }

  function status() {
    return { state, device, error: lastError, initMs, lastScoreMs, lastUsedAt, dl, cached: filesCached };
  }

  self.YB_SEM_HOST = { ensure, score, status, reset: () => terminateWorker('reset') };

  /* Status sofort beim Start veröffentlichen: Vor der ersten Bildprüfung gibt es
     sonst gar keinen semStatus-Eintrag und die Statuszeile im Popup bliebe leer
     (state „off“ → Hinweistext statt leerer Zeile, siehe popup.js). */
  saveStatus();

  /* Zusätzlich prüfen, ob der Modellbestand schon im Browser-Cache liegt:
     Nach einem Neustart (Browser oder Erweiterung) gab es sonst weder „ready“
     noch lastUsedAt — die Anzeige blieb grau, obwohl die Modelle ohne erneuten
     Download startbereit sind (Ergebnis → Feld „cached“). */
  if (self.YB_MODEL_CACHE) {
    self.YB_MODEL_CACHE.check().then(ok => {
      if (ok === null) return;   /* nicht prüfbar → Zustand unbekannt lassen */
      filesCached = ok;
      saveStatus();
    }).catch(() => { /* Status ist optional */ });
  }
})();
