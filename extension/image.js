/* image.js — dHash + pHash для устойчивого сравнения миниатюр */
(function () {
  'use strict';

  const HASH_W = 9, HASH_H = 8;

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image load failed: ' + url));
      img.src = url;
    });
  }

  function pixels(img, w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  }

  function lum(r, g, b) {
    return r * 0.299 + g * 0.587 + b * 0.114;
  }

  function dhash(img) {
    const w = HASH_W, h = HASH_H;
    const rgba = pixels(img, w, h);
    let bits = '';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w - 1; x++) {
        const i1 = (y * w + x) * 4;
        const i2 = (y * w + x + 1) * 4;
        bits += lum(rgba[i1], rgba[i1 + 1], rgba[i1 + 2]) >
          lum(rgba[i2], rgba[i2 + 1], rgba[i2 + 2]) ? '1' : '0';
      }
    }
    return bits;
  }

  /* pHash: низкочастотный 8×8 блок 2D-DCT, 64 бита. */
  function phash(img) {
    const N = 16;
    const rgba = pixels(img, N, N);
    const gray = new Float64Array(N * N);
    for (let i = 0; i < N * N; i++) {
      const j = i * 4;
      gray[i] = lum(rgba[j], rgba[j + 1], rgba[j + 2]);
    }
    const c = new Float64Array(64);
    const factor = Math.PI / (2 * N);
    for (let u = 0; u < 8; u++) {
      for (let v = 0; v < 8; v++) {
        let sum = 0;
        for (let y = 0; y < N; y++) {
          const cy = Math.cos((2 * y + 1) * u * factor);
          for (let x = 0; x < N; x++) {
            sum += gray[y * N + x] * cy * Math.cos((2 * x + 1) * v * factor);
          }
        }
        c[u * 8 + v] = sum;
      }
    }
    const vals = Array.from(c.slice(1));
    const sorted = vals.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    let bits = '';
    for (let i = 0; i < 64; i++) bits += c[i] >= median ? '1' : '0';
    return bits;
  }

  function hamming(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    return d;
  }

  function descriptor(img) {
    return { hash: dhash(img), phash: phash(img) };
  }

  /**
   * Сначала используем быстрый dHash. Если он чуть менее близок, pHash
   * помогает сохранить совпадение при небольшом кадрировании/изменении цвета.
   */
  function matchHash(desc, samples, threshold) {
    const dThreshold = Math.max(0, Number(threshold) || 0);
    let best = null;
    for (const s of samples || []) {
      if (!s || !s.hash) continue;
      const d = hamming(desc.hash, s.hash);
      const p = desc.phash && s.phash ? hamming(desc.phash, s.phash) : Infinity;
      const dOk = d <= dThreshold;
      /* pHash alone is too permissive for an «absolutely unwanted» list.
         Use it as a tolerance layer only when dHash is also reasonably close. */
      const pOk = Number.isFinite(p) && p <= Math.min(10, dThreshold + 2) && d <= dThreshold + 4;
      if (!dOk && !pOk) continue;
      const score = dOk ? d + 0.15 * Math.min(p, 64) : d + 0.65 * p;
      if (!best || score < best.score) {
        best = { sample: s, distance: d, phashDistance: p, score };
      }
    }
    return best;
  }

  async function descriptorFromUrl(url) {
    return descriptor(await loadImage(url));
  }

  async function hashFromUrl(url) {
    return (await descriptorFromUrl(url)).hash;
  }

  window.YB = window.YB || {};
  window.YB.image = { loadImage, dhash, phash, descriptor, hamming, matchHash, descriptorFromUrl, hashFromUrl };
})();
