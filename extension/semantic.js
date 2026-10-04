/* semantic.js — local semantic image matching (SigLIP), no network at runtime */
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
      if (m.type === 'embedding') p.resolve(m.vector);
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
      const result = await request('init', { device: navigator.gpu ? 'webgpu' : 'wasm' });
      return result;
    } catch (e) {
      ready = null;
      throw e;
    }
  }

  async function embed(source) {
    await init();
    return request('embed', { source });
  }

  function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return -1;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
  }

  function bestMatch(vector, samples, threshold) {
    let best = null;
    const min = Number.isFinite(Number(threshold)) ? Number(threshold) : 0.82;
    for (const sample of samples || []) {
      if (!Array.isArray(sample.embedding) || !sample.embedding.length) continue;
      const score = cosine(vector, sample.embedding);
      if (!best || score > best.score) best = { sample, score };
    }
    return best && best.score >= min ? best : null;
  }

  async function embedSamples(samples, onProgress) {
    const out = [];
    for (let i = 0; i < (samples || []).length; i++) {
      const s = samples[i];
      if (!Array.isArray(s.embedding) || s.embedding.length < 100) {
        s.embedding = await embed(s.dataUrl);
      }
      out.push(s);
      if (onProgress) onProgress(i + 1, samples.length);
    }
    return out;
  }

  window.YB = window.YB || {};
  window.YB.semantic = {
    modelDir: MODEL_DIR,
    init, embed, cosine, bestMatch, embedSamples
  };
})();
