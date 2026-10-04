/* matcher.js — контекстное сопоставление текста с пользователями заданным списком */
(function () {
  'use strict';

  function normalize(str) {
    return String(str || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[’'`]/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .replace(/-+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenize(str) {
    const n = normalize(str);
    return n ? n.split(' ').filter(Boolean) : [];
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m || !n) return m || n;
    if (Math.abs(m - n) > 3) return Math.max(m, n);
    let prev = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      let rowMin = cur[0];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > 3) return rowMin;
      prev = cur;
    }
    return prev[n];
  }

  function maxEditDistance(len) {
    if (len <= 4) return 0;
    if (len <= 6) return 1;
    if (len <= 10) return 2;
    return 3;
  }

  function tokenMatches(t, k, fuzzy) {
    if (t === k) return true;
    /* Короткие слова сопоставляем только целиком: это заметно снижает ложные совпадения. */
    if (!fuzzy || k.length < 5 || t.length < 2) return false;
    if (t[0] !== k[0] || t[1] !== k[1]) return false;
    if (levenshtein(t, k) <= maxEditDistance(k.length)) return true;
    /* Для режима «абсолютно неинтересно» не используем prefix-match:
       он даёт опасные совпадения вроде «auto» → «automatic». */
    return false;
  }

  function tokensMatch(textTokens, kwTokens, fuzzy) {
    if (!kwTokens.length || kwTokens.length > textTokens.length) return false;
    for (let i = 0; i + kwTokens.length <= textTokens.length; i++) {
      let ok = true;
      for (let j = 0; j < kwTokens.length; j++) {
        if (!tokenMatches(textTokens[i + j], kwTokens[j], fuzzy)) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }

  /**
   * @param {string} text заголовок / канал / OCR / расшифровка
   * @param {string[]} keywords
   * @param {{fuzzy?:boolean}} opts
   * @returns {string|null} совпавшее ключевое слово
   */
  function matchKeywords(text, keywords, opts) {
    opts = opts || {};
    const textTokens = tokenize(text);
    if (!textTokens.length) return null;
    for (const raw of keywords || []) {
      const kwTokens = tokenize(raw);
      if (!kwTokens.length) continue;
      if (tokensMatch(textTokens, kwTokens, opts.fuzzy !== false)) return raw;
    }
    return null;
  }

  window.YB = window.YB || {};
  window.YB.matcher = { normalize, tokenize, matchKeywords, levenshtein };
})();
