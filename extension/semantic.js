/* semantic.js — local SigLIP text → image semantic matching */
(function () {
  'use strict';

  const api = (typeof browser !== 'undefined') ? browser : chrome;
  const MODEL_DIR = 'models/siglip-base-patch16-224/';
  const workerUrl = api.runtime.getURL('semantic-worker.js');
  let worker = null, seq = 0, ready = null;
  const pending = new Map();

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(workerUrl, { type: 'module' });
    worker.onmessage = e => {
      const m = e.data || {};
      if (m.type === 'ready') {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); p.resolve(m); }
        if (ready) ready.resolve(m);
        return;
      }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.type === 'texts-ready') p.resolve(m.labels);
      else if (m.type === 'image-scores') p.resolve(m.scores);
      else p.reject(new Error(m.error || 'semantic worker error'));
    };
    worker.onerror = e => {
      const err = new Error(e.message || 'semantic worker failed');
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      if (ready) ready.reject(err);
      ready = null;
    };
    return worker;
  }

  function request(type, payload) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ensureWorker().postMessage({ type, id, ...payload });
    });
  }

  async function init() {
    if (ready) return ready.promise;
    ensureWorker();
    let resolve, reject;
    const promise = new Promise((r, j) => { resolve = r; reject = j; });
    ready = { promise, resolve, reject };
    try {
      return await request('init', { device: navigator.gpu ? 'webgpu' : 'wasm' });
    } catch (e) {
      ready = null;
      throw e;
    }
  }

  async function setTexts(texts) {
    await init();
    return request('set-texts', { texts });
  }

  async function scoreImage(source) {
    await init();
    return request('score-image', { source });
  }

  function bestTextMatch(scores, threshold) {
    const min = Number.isFinite(Number(threshold)) ? Number(threshold) : 0.15;
    let best = null;
    for (const item of scores || []) {
      if (!item?.text || !Number.isFinite(item.score)) continue;
      if (!best || item.score > best.score) best = item;
    }
    return best && best.score >= min ? best : null;
  }

  window.YB = window.YB || {};
  window.YB.semantic = {
    modelDir: MODEL_DIR,
    init,
    setTexts,
    scoreImage,
    bestTextMatch
  };
})();