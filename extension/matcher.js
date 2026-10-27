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

  /* Wort-Treffer sind exakt: keine Tippfehler- oder Stammtoleranz.
     Schreibweisen und Mehrzahlformen müssen ausdrücklich in der Liste stehen
     (Tesla/Teslas, Drohne/drone, машина/машины). */
  function tokensMatch(textTokens, kwTokens) {
    if (!kwTokens.length || kwTokens.length > textTokens.length) return false;
    for (let i = 0; i + kwTokens.length <= textTokens.length; i++) {
      let ok = true;
      for (let j = 0; j < kwTokens.length; j++) {
        if (textTokens[i + j] !== kwTokens[j]) {
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
   * @returns {string|null} passendes Schlüsselwort
   */
  function matchKeywords(text, keywords) {
    const textTokens = tokenize(text);
    if (!textTokens.length) return null;
    for (const raw of keywords || []) {
      const kwTokens = tokenize(raw);
      if (!kwTokens.length) continue;
      if (tokensMatch(textTokens, kwTokens)) return raw;
    }
    return null;
  }

  /* ---- Freigaben (Ausnahmen) ----
     Eine Ausnahme gilt nur für ihr Schlüsselwort. Es gibt keine globale
     Freigabeliste: Andere Wörter der Liste treffen weiterhin.
     Kurze Begriffe (< 4 Zeichen) treffen nur ein ganzes Wort; längere auch
     Wortstämme (теннис → теннисист, tennis → tennisplayer). Phrasen werden
     als Wortfolge verglichen, das letzte Wort darf ebenfalls ein Stamm sein
     (No Tesla → No Teslas). */
  function addTerm(out, value) {
    const s = String(value == null ? '' : value).trim();
    const n = normalize(s);
    if (!n) return;
    if (!out.some(x => normalize(x) === n)) out.push(s);
  }

  function normalizeExceptions(value) {
    const out = [];
    if (Array.isArray(value)) value.forEach(v => addTerm(out, v));
    else if (typeof value === 'string') value.split(/[\n,;]+/).forEach(v => addTerm(out, v));
    return out;
  }

  function exceptionsOf(keyword) {
    if (keyword && typeof keyword === 'object') return normalizeExceptions(keyword.exceptions);
    return [];
  }

  function termMatches(textTokens, needleTokens) {
    if (!needleTokens.length || needleTokens.length > textTokens.length) return false;
    if (needleTokens.length === 1) {
      const k = needleTokens[0];
      if (k.length < 4) return textTokens.includes(k);
      return textTokens.some(t => t.includes(k));
    }
    /* Phrase: alle Wörter exakt, das letzte ab 4 Zeichen als Stamm. */
    const last = needleTokens.length - 1;
    for (let i = 0; i + needleTokens.length <= textTokens.length; i++) {
      let ok = true;
      for (let j = 0; j < needleTokens.length; j++) {
        const t = textTokens[i + j];
        const k = needleTokens[j];
        if (j === last && k.length >= 4) {
          if (!t.startsWith(k)) { ok = false; break; }
        } else if (t !== k) {
          ok = false; break;
        }
      }
      if (ok) return true;
    }
    return false;
  }

  function firstException(text, exceptions) {
    const hay = tokenize(text);
    if (!hay.length) return null;
    for (const raw of normalizeExceptions(exceptions)) {
      if (termMatches(hay, tokenize(raw))) return raw;
    }
    return null;
  }

  function exceptionMatches(text, exceptions) {
    return firstException(text, exceptions) !== null;
  }

  /* ---- Routen je Schlüsselwort (docs/SEMANTIC_FILTER_ROUTING.md, Punkt 1) ----
     route ∈ 'text' | 'title' | 'ocr' | 'image' | 'hybrid'. Eine fehlende Route
     bedeutet das bisherige Verhalten (alle Kanäle); 'text' ist die reine
     Textspur (Titel, Kanal, OCR, Transkript) ohne SigLIP, 'hybrid' die alte
     Kombination (Titel + OCR + Bild). Eingabe: {text, enabled, route?}[] oder
     reine Strings (dann gelten sie für alle Kanäle). */
  const ROUTES = ['text', 'title', 'ocr', 'image', 'hybrid'];

  function routeOf(keyword) {
    const r = keyword && typeof keyword === 'object' ? keyword.route : null;
    return ROUTES.indexOf(r) >= 0 ? r : null;
  }

  /* Gilt eine Route in diesem Kanal? 'speech' ist ein reiner Textkanal:
     title/ocr/image-Einträge gehören dort nicht hinein. */
  function routeApplies(route, channel) {
    if (route === null || route === 'hybrid') return true;
    if (route === 'text') return channel === 'title' || channel === 'ocr' || channel === 'speech';
    if (channel === 'speech') return false;
    return route === channel;
  }

  function entryMeta(kw, entry) {
    if (kw && typeof kw === 'object') {
      if (kw.group) entry.group = String(kw.group);
      if (kw.label) entry.label = String(kw.label);
      if (kw.prompt) entry.prompt = true;
    }
    return entry;
  }

  function channelEntries(keywords, channel) {
    const out = [];
    for (const kw of keywords || []) {
      const isObj = kw !== null && typeof kw === 'object';
      const text = String((isObj ? kw.text : kw) || '').trim();
      if (!text) continue;
      if (isObj && kw.enabled === false) continue;
      const route = isObj ? routeOf(kw) : null;
      if (routeApplies(route, channel)) {
        out.push(entryMeta(kw, { text, exceptions: exceptionsOf(kw) }));
      }
    }
    return out;
  }

  function channelKeywords(keywords, channel) {
    return channelEntries(keywords, channel).map(e => e.text);
  }

  /* Erste Trefferzeile, deren Ausnahmen im Kontext NICHT zutreffen.
     contextText enthält je nach Kanal Titel + Kanal (+ OCR/Transkript). */
  function matchEntries(text, entries, opts) {
    opts = opts || {};
    const textTokens = tokenize(text);
    if (!textTokens.length) return null;
    const ctx = opts.contextText === undefined ? text : opts.contextText;
    for (const entry of entries || []) {
      const isObj = entry !== null && typeof entry === 'object';
      const raw = String((isObj ? entry.text : entry) || '').trim();
      if (!raw) continue;
      const kwTokens = tokenize(raw);
      if (!kwTokens.length) continue;
      if (!tokensMatch(textTokens, kwTokens)) continue;
      const ex = isObj ? normalizeExceptions(entry.exceptions) : [];
      if (firstException(ctx, ex)) continue;
      return entryMeta(entry, { text: raw, exceptions: ex });
    }
    return null;
  }

  /* Entfernt Konzepte, die für diese Karte freigegeben sind, aus den
     SigLIP-Scores. Die Margin wird danach nur unter aktiven Konzepten
     berechnet, damit eine Freigabe keinen echten Treffer verdrängt. */
  function activeScores(scores, entries, contextText) {
    const allowed = new Set();
    for (const entry of entries || []) {
      const isObj = entry !== null && typeof entry === 'object';
      const text = String((isObj ? entry.text : entry) || '').trim();
      if (!text) continue;
      const ex = isObj ? normalizeExceptions(entry.exceptions) : [];
      if (ex.length && firstException(contextText, ex)) allowed.add(normalize(text));
    }
    if (!allowed.size) return Array.isArray(scores) ? scores : [];
    return (Array.isArray(scores) ? scores : [])
      .filter(s => !allowed.has(normalize(s && s.text)));
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

  /* ---- KI-Hinweis-Badge („AI disclosure“): YouTube lokalisiert den kurzen
     Text und die Langfassung. Verifiziert am 18.10.2026 an
     watch?v=wFAvZSefhnE in vier Sprachen:
     en „AI“ / „AI: Content was made with AI“,
     de „KI“ / „KI-Hinweis: Inhalt wurde mit KI erstellt“,
     ru „ИИ“ / „ИИ: контент создан с помощью ИИ“,
     uk „ШІ“ / „ШІ: контент створено за допомогою штучного інтелекту“.
     Der kurze Token zählt nur als ganzes Feld („AI news“ im Titel nie);
     geprüft werden ohnehin nur Badge-Knoten, nie Titel oder Fließtext. */
  const AI_BADGE_TOKEN_RE = /^(ai|ki|ии|ші)$/i;
  const AI_BADGE_PHRASE_RE = /made with ai|mit ki erstellt|создан\w*\s+с\s+помощью\s+ии|створено за допомогою штучного інтелекту/i;

  function isAiBadgeText(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return false;
    return AI_BADGE_TOKEN_RE.test(s) || AI_BADGE_PHRASE_RE.test(s);
  }

  window.YB = window.YB || {};
  window.YB.matcher = {
    normalize, tokenize, matchKeywords,
    channelKeywords, channelEntries, matchEntries, routeOf, routeApplies,
    normalizeExceptions, exceptionsOf,
    firstException, exceptionMatches, termMatches, activeScores,
    isMembersOnlyText, isAiBadgeText
  };
})();
