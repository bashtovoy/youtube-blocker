/* promo.js — mehrstufige Erkennung von YouTube-eigenen Werbekarten.
   Statt fester DOM-Selektoren zählen mehrere unabhängige Signale zusammen:
   Textmarker (Badge/CTA/Preis), Struktur (externe Links, fehlende Metadaten)
   und bekannte Werbe-Container. Erst ab der Regelschwelle wird ausgeblendet —
   ein geändertes YouTube-Layout macht damit höchstens ein Signal unbrauchbar,
   nicht die ganze Erkennung. Die Regeln liegen in promo-rules.js. */
(function () {
  'use strict';

  const R = window.YB && window.YB.promoRules;
  if (!R) return;

  function compile(list) {
    const out = [];
    for (const p of list || []) {
      /* 'u' für Unicode-Wortgrenzen (\p{L}); ohne das wären Muster mit
         \p{…} ungültig und würden still übersprungen. */
      try { out.push(new RegExp(p, 'iu')); } catch (e) { /* defektes Muster überspringen */ }
    }
    return out;
  }

  const BADGE_RE = compile(R.badgePatterns);
  const CTA_RE = compile(R.ctaPatterns);
  /* Dieselben CTA-Muster ohne ^-Anker: für den Rückfall auf den Kartentext,
     in dem die Aufforderung nicht am Anfang steht („… empfiehlt … Jetzt testen“). */
  const CTA_ANY_RE = compile((R.ctaPatterns || []).map(p => String(p).replace(/^\^/, '')));
  const PRICE_RE = compile(R.pricePatterns);
  const SUSPECT_RE = compile(R.suspectPatterns);

  /* Interne Hosts: alles, was zur YouTube-/Google-Video-Infrastruktur gehört. */
  const INTERNAL_RE = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|ytimg\.com|googlevideo\.com|googleusercontent\.com|gstatic\.com|google\.com)$/i;

  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function anyMatch(patterns, text) {
    const s = normalize(text);
    if (!s) return false;
    for (const re of patterns) if (re.test(s)) return true;
    return false;
  }

  function classifyBadge(text) { return anyMatch(BADGE_RE, text); }
  function classifyCta(text) { return anyMatch(CTA_RE, text); }
  function classifyCtaAnywhere(text) { return anyMatch(CTA_ANY_RE, text); }
  function classifyPrice(text) { return anyMatch(PRICE_RE, text); }

  /* Wörter, die auf ein unbekanntes Werbeformat hindeuten (nur Diagnose). */
  function suspectWords(text) {
    const s = normalize(text);
    if (!s) return [];
    const out = [];
    for (const re of SUSPECT_RE) {
      const m = s.match(re);
      if (m && m[0]) out.push(m[0]);
    }
    return Array.from(new Set(out)).slice(0, 8);
  }

  function defaultBase() {
    try {
      if (typeof location !== 'undefined' && location.origin) return location.origin;
    } catch (e) { /* kein Dokument (Tests) */ }
    return 'https://www.youtube.com';
  }

  /* Externe Ziele erkennen — organische Karten verlinken auf /watch, /shorts,
     /channel usw.; Werbekarten führen auf eine beworbene Seite. Auch der
     YouTube-Redirect-Wrapper (/redirect?q=…) wird aufgelöst. */
  function isInternalHref(href, base) {
    const raw = String(href || '').trim();
    if (!raw || raw.startsWith('#') || /^(javascript|data|blob|mailto|tel):/i.test(raw)) return true;
    let u;
    try { u = new URL(raw, base || defaultBase()); } catch (e) { return true; }
    if (!/^https?:$/i.test(u.protocol)) return true;
    if (!INTERNAL_RE.test(u.hostname)) return false;
    const q = u.searchParams.get('q');
    if (q && /(^|\.)youtube\.com$/i.test(u.hostname)) {
      try {
        const inner = new URL(q);
        return INTERNAL_RE.test(inner.hostname);
      } catch (e) { return true; }
    }
    return true;
  }

  function hostOf(href, base) {
    try { return new URL(String(href || ''), base || defaultBase()).hostname; } catch (e) { return ''; }
  }

  function safeQuery(root, selectors) {
    const sel = Array.isArray(selectors) ? selectors.join(', ') : String(selectors || '');
    if (!sel || !root || !root.querySelectorAll) return [];
    try { return Array.from(root.querySelectorAll(sel)); } catch (e) { return []; }
  }

  function externalHosts(item, base) {
    const out = [];
    for (const a of safeQuery(item, ['a[href]'])) {
      const href = a.getAttribute && a.getAttribute('href');
      if (!href || isInternalHref(href, base)) continue;
      const h = hostOf(href, base);
      if (h && !out.includes(h)) out.push(h);
      if (out.length >= 8) break;
    }
    return out;
  }

  /* Kartentext ohne den Videotitel: So zählen nur Badge-/Metazeilen, nie ein
     Titel wie „YouTube empfiehlt …“ oder „Попробовать за 0 грн“. */
  function cardText(item, title) {
    let t = normalize(item && item.textContent);
    const nt = normalize(title);
    if (nt) t = t.split(nt).join(' ');
    return t;
  }

  function computeScore(signals) {
    let n = 0;
    for (const s of signals || []) n += Number(s.weight) || 0;
    return n;
  }

  function markerTexts(item) {
    const out = [];
    for (const el of safeQuery(item, R.markerSelectors)) {
      const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length <= 80) out.push(t);
      if (out.length >= 10) break;
    }
    return Array.from(new Set(out)).slice(0, 6);
  }

  function analyze(item, opts) {
    opts = opts || {};
    const base = opts.base || defaultBase();
    const title = opts.title || '';
    const full = cardText(item, title);
    const signals = [];
    const add = (id, weight, detail) => signals.push({
      id,
      weight,
      detail: String(detail || '').slice(0, 100)
    });

    /* 1) Werbe-Badge: erst in Badge-Knoten, dann als Rückfall im Kartentext
          (fängt neue Wrapper auf, ohne dass ein Selektor bekannt sein muss). */
    let badge = '';
    for (const el of safeQuery(item, R.badgeSelectors)) {
      const fields = [
        el.textContent,
        el.getAttribute && el.getAttribute('aria-label'),
        el.getAttribute && el.getAttribute('title')
      ];
      for (const f of fields) {
        if (f && classifyBadge(f)) { badge = String(f).slice(0, 100); break; }
      }
      if (badge) break;
    }
    if (!badge && classifyBadge(full)) badge = 'text';
    if (badge) add('badge', R.weights.badge, badge);

    /* 2) Bekannter Werbe-Container (die Karte selbst oder darin). */
    const containerSel = (R.containers || []).join(', ');
    let container = '';
    try {
      if (containerSel && item.matches && item.matches(containerSel)) container = 'self';
    } catch (e) { /* ungültiger Selektor */ }
    if (!container && containerSel && item.querySelector) {
      const c = item.querySelector(containerSel);
      if (c) container = String(c.tagName || 'container').toLowerCase();
    }
    if (container) add('container', R.weights.container, container);

    /* 3) Externes Ziel in der Karte. */
    const hosts = externalHosts(item, base);
    if (hosts.length) add('external', R.weights.external, hosts.join(', '));

    /* 4) Handlungsaufforderung — bevorzugt in Button-Knoten. */
    const ctas = [];
    for (const el of safeQuery(item, R.ctaSelectors)) {
      const t = normalize(el.textContent);
      if (t && t.length <= 80 && classifyCta(t)) ctas.push(t);
      if (ctas.length >= 3) break;
    }
    if (!ctas.length && classifyCtaAnywhere(full)) ctas.push('text');
    if (ctas.length) add('cta', R.weights.cta, ctas[0]);

    /* 5) Preis-/Gratis-Marker. */
    if (classifyPrice(full)) add('price', R.weights.price, 'price');

    /* 6) Fehlende übliche Metadaten (Dauer/Aufrufe/Datum) — nur schwaches Signal. */
    const hasDuration = /\b\d{1,3}:\d{2}\b/.test(full);
    const hasMeta = hasDuration ||
      /\b\d[\d.,]*\s*(k|m|b|mio|тыс|млн|млрд|views?|aufrufe|просмотр)/i.test(full) ||
      /\b\d+\s*(d|h|min|day|days|hour|hours|week|weeks|month|months|year|years|дн|ч|мин|нед|мес|год|лет|назад|ago|vor)/i.test(full);
    if (!hasMeta) add('noMeta', R.weights.noMeta, '');

    const score = computeScore(signals);
    const isHit = score >= R.threshold;
    return {
      isHit,
      score,
      signals,
      hosts,
      suspects: isHit ? [] : suspectWords(full),
      texts: isHit ? [] : markerTexts(item),
      rulesVersion: R.version || 0
    };
  }

  function hashString(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /* Kompakter Fingerabdruck für den lokalen Diagnosebericht (keine Netzaktion). */
  function fingerprint(info, item, opts) {
    opts = opts || {};
    info = info || {};
    const title = String(opts.title || '').slice(0, 80);
    const signals = (info.signals || []).map(s => s.id);
    const suspects = (info.suspects || []).slice(0, 8);
    const texts = (info.texts || []).slice(0, 6);
    const hosts = (info.hosts || []).slice(0, 5);
    const base = [
      item && item.tagName,
      signals.join(','),
      suspects.join('|'),
      texts.join('|'),
      hosts.join(',')
    ].join('#');
    return {
      hash: hashString(base),
      at: new Date().toISOString(),
      score: Number(info.score) || 0,
      signals,
      suspects,
      texts,
      hosts,
      tag: (item && item.tagName) || '',
      title,
      rulesVersion: info.rulesVersion || R.version || 0
    };
  }

  /* Klingelspeicher: neuester Eintrag vorn, Duplikate (gleicher Hash) und
     mehr als `max` Einträge werden verworfen. */
  function addSuspect(list, entry, max) {
    const out = Array.isArray(list) ? list.slice() : [];
    if (!entry || !entry.hash) return out;
    if (out.some(e => e && e.hash === entry.hash)) return out;
    out.unshift(entry);
    const cap = Math.max(1, Number(max) || R.suspectsMax || 50);
    return out.slice(0, cap);
  }

  window.YB = window.YB || {};
  window.YB.promo = {
    version: R.version || 0,
    analyze,
    computeScore,
    classifyBadge,
    classifyCta,
    classifyCtaAnywhere,
    classifyPrice,
    suspectWords,
    isInternalHref,
    hostOf,
    externalHosts,
    cardText,
    markerTexts,
    fingerprint,
    addSuspect,
    hashString
  };
})();
