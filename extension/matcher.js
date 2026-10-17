/* matcher.js — kontextbezogener Abgleich von Text mit der benutzerdefinierten Liste */
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
    /* Kurze Wörter werden nur vollständig verglichen: Das senkt falsche Treffer deutlich. */
    if (!fuzzy || k.length < 5 || t.length < 2) return false;
    if (t[0] !== k[0] || t[1] !== k[1]) return false;
    if (levenshtein(t, k) <= maxEditDistance(k.length)) return true;
    /* Für den Modus „Absolut kein Interesse“ bewusst kein Prefix-Matching:
       Es erzeugt gefährliche Treffer wie „auto“ → „automatic“. */
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
   * @param {string} text Titel / Kanal / OCR / Transkript
   * @param {string[]} keywords
   * @param {{fuzzy?:boolean}} opts
   * @returns {string|null} passendes Schlüsselwort
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

  /* ---- Routen je Schlüsselwort (docs/SEMANTIC_FILTER_ROUTING.md, Punkt 1) ----
     route ∈ 'title' | 'ocr' | 'image' | 'hybrid'. Eine fehlende Route bedeutet
     das bisherige Verhalten (alle Kanäle); 'hybrid' ist die kontrollierte
     Kombination (Titel + OCR + Bild). Eingabe: {text, enabled, route?}[] oder
     reine Strings (dann gelten sie für alle Kanäle). */
  const ROUTES = ['title', 'ocr', 'image', 'hybrid'];

  function routeOf(keyword) {
    const r = keyword && typeof keyword === 'object' ? keyword.route : null;
    return ROUTES.indexOf(r) >= 0 ? r : null;
  }

  function channelKeywords(keywords, channel) {
    const out = [];
    for (const kw of keywords || []) {
      const isObj = kw !== null && typeof kw === 'object';
      const text = String((isObj ? kw.text : kw) || '').trim();
      if (!text) continue;
      if (isObj && kw.enabled === false) continue;
      const route = isObj ? routeOf(kw) : null;
      if (route === null || route === 'hybrid' || route === channel) out.push(text);
    }
    return out;
  }

  /* ---- „Members only“-Badges: YouTube lokalisiert den Text. ----
     Verifiziert am 17.10.2026 an @LinusTechTips/videos:
     de „Nur für Kanalmitglieder“, ru „Только для спонсоров“,
     uk „Лише для спонсорів“, en „Members only“. Bare „sponsor“ ist bewusst
     nicht enthalten, damit „Sponsored“ nicht als Mitgliedschaft gilt. */
  const MEMBERS_ONLY_RE = /members?\s*only|member[- ]only|kanalmitglied|mitglied|только\s+для\s+спонсор|для\s+спонсор|спонсор|лише\s+для\s+спонсор|для\s+учасник|учасник|участник|член|membres?\s+uniquement|r[ée]serv[ée]e?\s+aux\s+membres|solo\s+(para\s+)?miembros|apenas\s+para\s+membros|somente\s+membros|s[óo]\s+para\s+membros|solo\s+per\s+membri|tylko\s+dla\s+cz[lł]onk[óo]w|[üu]yelere\s+[öo]zel|yaln[ıi]zca\s+[üu]yeler|メンバー限定|会员专属|僅限會員|仅限会员/i;

  function isMembersOnlyText(text) {
    return MEMBERS_ONLY_RE.test(String(text || ''));
  }

  window.YB = window.YB || {};
  window.YB.matcher = { normalize, tokenize, matchKeywords, levenshtein, channelKeywords, routeOf, isMembersOnlyText };
})();
