/* semantic-host.js — SigLIP-Worker-Host im privilegierten Kontext (Background-Seite).
   Warum nicht im Content-Script: YouTube erzwingt Trusted Types + CSP
   (`require-trusted-types-for 'script'`), dadurch schlägt `new Worker(...)` aus
   Content-Scripts synchron fehl ("Worker constructor: Sink type mismatch ... blocked by CSP").
   Die Background-Seite unterliegt den Seitenrichtlinien nicht. Content-Scripts sprechen
   nur noch per runtime.sendMessage mit diesem Host.
   Für Chrome MV3 später unverändert in ein Offscreen-Dokument übernehmbar. */
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
  let idleTimer = null;
  let queue = Promise.resolve();
  let preparePromise = null;
  /* Scores pro Bild-URL + Wortlisten-Version cachen (Dedupe über Karten/Tabs/Rescans). */
  const scoreCache = new Map();
  const SCORE_CACHE_MAX = 200;

  function dlog(line) {
    if (typeof self.YB_DEVLOG === 'function') { try { self.YB_DEVLOG(line); } catch (e) { /* Dev-Log optional */ } }
  }

  function saveStatus() {
    try {
      api.storage.local.set({
        [STATUS_KEY]: { state, device, error: lastError, initMs, lastScoreMs, updatedAt: Date.now() }
      });
    } catch (e) { /* Status ist optional */ }
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

  function terminateWorker(reason) {
    if (worker) { try { worker.terminate(); } catch (e) { /* schon tot */ } }
    worker = null;
    initPromise = null;
    textsKey = null;
    workerHasTexts = false;
    device = null;
    errorKey = null;
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
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.type === 'ready') p.resolve(m);
      else if (m.type === 'texts-ready') p.resolve(m);
      else if (m.type === 'image-scores') p.resolve(m.scores);
      else {
        const err = new Error(m.error || 'Semantik-Worker-Fehler');
        if (p.type === 'init') markFatal(err);
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
      const res = await request('init', {
        device: self.navigator && self.navigator.gpu ? 'webgpu' : 'wasm'
      });
      device = res.device || null;
      initMs = Date.now() - t0;
      setState('ready');
      return res;
    })().catch(err => {
      initPromise = null;
      markFatal(err);
      setState('error', err.message);
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
            tasks.push(request('set-texts', { texts: lastTexts }).then(res => {
              textCache = {
                key: lastKey,
                embeds: res.embeds,
                dim: res.dim,
                labels: Array.isArray(res.labels) ? res.labels : lastTexts
              };
              workerHasTexts = true;
              textsKey = lastKey;
              scoreCache.clear();
            }));
          }
        }
        await Promise.all(tasks);
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
    return { state, device, error: lastError, initMs, lastScoreMs, lastUsedAt };
  }

  self.YB_SEM_HOST = { ensure, score, status, reset: () => terminateWorker('reset') };
})();
