/* image.js — загрузка изображений, перцептивный хэш (dHash), сравнение */
(function () {
  'use strict';

  const HASH_W = 9, HASH_H = 8; /* dHash 8x8 -> 64 бита */

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image load failed: ' + url));
      img.src = url;
    });
  }

  function imgToGrayMatrix(img, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  }

  /**
   * dHash: для каждой строки сравниваем соседние пиксели по яркости.
   * @returns {string} 64-символьная строка '0'/'1'
   */
  function dhash(img) {
    const rgba = imgToGrayMatrix(img, HASH_W, HASH_H);
    let bits = '';
    for (let y = 0; y < HASH_H; y++) {
      for (let x = 0; x < HASH_W - 1; x++) {
        const i1 = (y * HASH_W + x) * 4;
        const i2 = (y * HASH_W + x + 1) * 4;
        const l1 = rgba[i1] * 0.299 + rgba[i1 + 1] * 0.587 + rgba[i1 + 2] * 0.114;
        const l2 = rgba[i2] * 0.299 + rgba[i2 + 1] * 0.587 + rgba[i2 + 2] * 0.114;
        bits += l1 > l2 ? '1' : '0';
      }
    }
    return bits;
  }

  function hamming(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    return d;
  }

  /**
   * Поиск наиболее похожего образца.
   * @param {string} hash хэш миниатюры
   * @param {{hash:string}[]} samples образцы из списка
   * @param {number} threshold макс. расстояние Хэмминга (0..64)
   * @returns {{sample:object,distance:number}|null}
   */
  function matchHash(hash, samples, threshold) {
    let best = null;
    for (const s of samples || []) {
      if (!s || !s.hash) continue;
      const d = hamming(hash, s.hash);
      if (d <= threshold && (!best || d < best.distance)) best = { sample: s, distance: d };
    }
    return best;
  }

  async function hashFromUrl(url) {
    const img = await loadImage(url);
    return dhash(img);
  }

  window.YB = window.YB || {};
  window.YB.image = { loadImage, dhash, hamming, matchHash, hashFromUrl };
})();
