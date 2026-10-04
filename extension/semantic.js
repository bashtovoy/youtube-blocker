/* semantic.js — local SigLIP text ↔ image semantic matching */
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
      if (m.type === 'image-embedding') p.resolve(m.vector);
      else if (m.type === 'text-embeddings') p.resolve(m.vectors);
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

  async function embedImage(source) {
    await init();
    return request('embed-image', { source });
  }

  async function embedTexts(texts) {
    await init();
    return request('embed-texts', { texts });
  }

  function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return -1;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
  }

  function bestTextMatch(imageVector, textEntries, threshold) {
    const min = Number.isFinite(Number(threshold)) ? Number(threshold) : 0.30;
    let best = null;
    for (const entry of textEntries || []) {
      if (!entry?.vector || !entry.text) continue;
      const score = cosine(imageVector, entry.vector);
      if (!best || score > best.score) best = { text: entry.text, score };
    }
    return best && best.score >= min ? best : null;
  }

  window.YB = window.YB || {};
  window.YB.semantic = {
    modelDir: MODEL_DIR,
    init,
    embed: embedImage,
    embedImage,
    embedTexts,
    cosine,
    bestTextMatch
  };
})();