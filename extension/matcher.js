/* matcher.js — сопоставление текста с списком ключевых слов */
(function () {
  'use strict';

  function normalize(str) {
    return String(str || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* Логическое расстояние (для опечаток в ключевых словах) */
  function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m || !n) return m || n;
    let prev = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
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

  /* Токен-уровневое нечёткое сравнение */
  function tokensMatch(textTokens, kwTokens, fuzzy) {
    if (kwTokens.length > textTokens.length) return false;
    for (let i = 0; i + kwTokens.length <= textTokens.length; i++) {
      let ok = true;
      for (let j = 0; j < kwTokens.length; j++) {
        const t = textTokens[i + j], k = kwTokens[j];
        if (t === k) continue;
        if (!fuzzy) { ok = false; break; }
        /* первые 2 символы совпадают + расстояние в пределах нормы */
        if (t.length >= 2 && k.length >= 2 && t[0] === k[0] && t[1] === k[1] &&
            levenshtein(t, k) <= maxEditDistance(k.length)) continue;
        if (k.length >= 5 && t.startsWith(k)) continue; /* префикс */
        ok = false;
        break;
      }
      if (ok) return true;
    }
    return false;
  }

  /**
   * @param {string} text  заголовок / текст OCR / расшифровка
   * @param {string[]} keywords
   * @param {{fuzzy?:boolean}} opts
   * @returns {string|null} первое совпавшее ключевое слово
   */
  function matchKeywords(text, keywords, opts) {
    opts = opts || {};
    const normText = normalize(text);
    if (!normText) return null;
    const textTokens = normText.split(' ');
    for (const raw of keywords || []) {
      const kw = normalize(raw);
      if (!kw) continue;
      const kwTokens = kw.split(' ');
      /* быстрое точное вхождение подстроки */
      if (normText.includes(kw)) return raw;
      if (tokensMatch(textTokens, kwTokens, opts.fuzzy !== false)) return raw;
    }
    return null;
  }

  window.YB = window.YB || {};
  window.YB.matcher = { normalize, matchKeywords, levenshtein };
})();
