/* lexicon.js — Datenmodell der Begriffsmatrix (ein Konzept = eine Zeile).
   Wird von content.js, Popup, Import-Tab und lexicon.html VOR den jeweiligen
   UI-Skripten geladen. Das Modul kennt keine Oberfläche und keinen Storage:
   es normalisiert Gruppen, expandiert sie für die Textkanäle und erzeugt pro
   Gruppe genau einen SigLIP-Prompt.

   Quelle der Wahrheit ist `storage.local.lexicon`; `storage.local.keywords`
   bleibt als flaches, altes Format erhalten (Kompatibilität und Export). */
(function () {
  'use strict';

  const ROUTES = ['auto', 'text', 'title', 'ocr', 'image', 'hybrid'];

  function normalizeText(value) {
    const m = window.YB && window.YB.matcher;
    if (m && typeof m.normalize === 'function') return m.normalize(value);
    return String(value == null ? '' : value).toLowerCase().trim();
  }

  function normalizeExceptions(value) {
    const m = window.YB && window.YB.matcher;
    if (m && typeof m.normalizeExceptions === 'function') return m.normalizeExceptions(value);
    if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean);
    return String(value == null ? '' : value).split(/[\n,;]+/).map(v => v.trim()).filter(Boolean);
  }

  function normalizeRoute(value) {
    const r = String(value == null ? '' : value).trim();
    return ROUTES.indexOf(r) >= 0 ? r : 'auto';
  }

  function slugify(value) {
    let s = String(value == null ? '' : value);
    try { s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* alte Umgebungen */ }
    return s.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  }

  function uniqueId(base, used) {
    const root = base || 'group';
    let id = root;
    let n = 2;
    while (used.has(id)) id = root + '-' + n++;
    used.add(id);
    return id;
  }

  function pushUnique(list, value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return;
    const n = normalizeText(text);
    if (!n) return;
    if (!list.some(x => normalizeText(x) === n)) list.push(text);
  }

  function normalizeGroup(raw, index, used) {
    const isObj = raw !== null && typeof raw === 'object';
    const g = isObj ? raw : {};
    const label = String(g.label || g.name || (typeof raw === 'string' ? raw : '') || '').trim();
    const id = uniqueId(slugify(g.id || label) || ('group-' + (index + 1)), used);
    const variants = [];
    const source = Array.isArray(g.variants) ? g.variants
      : (Array.isArray(g.words) ? g.words : []);
    source.forEach(v => pushUnique(variants, typeof v === 'string' ? v : (v && v.text)));
    const exceptions = [];
    normalizeExceptions(g.exceptions).forEach(v => pushUnique(exceptions, v));
    const prompt = String(g.prompt || '').trim() || label || id;
    return {
      id,
      label: label || id,
      enabled: g.enabled !== false,
      route: normalizeRoute(g.route),
      prompt,
      variants,
      exceptions
    };
  }

  /* Akzeptiert das gespeicherte Array, alte Einzelobjekte und defensiv auch
     eine JSON-Zeichenkette. Leere Gruppen ohne Varianten und ohne Prompt
     werden verworfen. */
  function normalizeLexicon(value) {
    let list = value;
    if (typeof list === 'string') {
      try { list = JSON.parse(list); } catch (e) { list = []; }
    }
    if (!Array.isArray(list)) return [];
    const used = new Set();
    const out = [];
    list.forEach((raw, i) => {
      const g = normalizeGroup(raw, i, used);
      if (!g.variants.length && !g.prompt) return;
      out.push(g);
    });
    return out;
  }

  /* Kanäle, in denen eine Route wirksam ist. 'text' ist die reine Textspur
     (Titel, Kanal, OCR, Transkript) ohne SigLIP; 'hybrid' bleibt die alte
     Kombination aus allen Kanälen. */
  function routeApplies(route, channel) {
    if (route === 'auto' || route === 'hybrid') return true;
    if (route === 'text') return channel === 'title' || channel === 'ocr' || channel === 'speech';
    if (channel === 'speech') return false;
    return route === channel;
  }

  /* Flache Einträge für den Matcher. Bildkanal: genau ein Prompt pro Gruppe,
     damit Synonyme (Дрон/Drone/Dron) nicht gegeneinander antreten. */
  function entriesFor(lexicon, channel) {
    const out = [];
    const usedPrompts = new Set();
    (lexicon || []).forEach(g => {
      if (!g || g.enabled === false) return;
      const route = normalizeRoute(g.route);
      if (!routeApplies(route, channel)) return;
      const exceptions = normalizeExceptions(g.exceptions);
      if (channel === 'image') {
        const prompt = String(g.prompt || g.label || '').trim();
        if (!prompt) return;
        const key = normalizeText(prompt);
        if (!key || usedPrompts.has(key)) return;
        usedPrompts.add(key);
        out.push({ text: prompt, exceptions, group: g.id, label: g.label, prompt: true });
        return;
      }
      (g.variants || []).forEach(v => {
        const text = String(v || '').trim();
        if (!text) return;
        out.push({ text, exceptions, group: g.id, label: g.label });
      });
    });
    return out;
  }

  /* Flaches Altformat für storage.keywords und für alte Versionen/Exporte.
     Eine Gruppe mit enabled=false liefert ihre Varianten deaktiviert. */
  function toKeywords(lexicon) {
    const out = [];
    const seen = new Set();
    (lexicon || []).forEach(g => {
      if (!g) return;
      const route = normalizeRoute(g.route);
      const exceptions = normalizeExceptions(g.exceptions);
      (g.variants || []).forEach(v => {
        const text = String(v || '').trim();
        if (!text) return;
        const n = normalizeText(text);
        if (!n || seen.has(n)) return;
        seen.add(n);
        const o = { text, enabled: g.enabled !== false };
        if (route !== 'auto') o.route = route;
        if (exceptions.length) o.exceptions = exceptions;
        out.push(o);
      });
    });
    return out;
  }

  function cloneGroup(g) {
    return {
      id: g.id,
      label: g.label,
      enabled: g.enabled !== false,
      route: normalizeRoute(g.route),
      prompt: g.prompt,
      variants: (g.variants || []).slice(),
      exceptions: (g.exceptions || []).slice()
    };
  }

  function mergeExceptions(target, extra) {
    normalizeExceptions(extra).forEach(v => pushUnique(target, v));
    return target;
  }

  /* Migration des alten flachen keywords-Arrays in die Matrix.
     - bekannte Variante → passende Vorlage, alle kuratierten Varianten kommen mit;
     - unbekannte Wörter → eigene Einzelgruppe (nichts geht verloren);
     - Ausnahmen und enabled-Zustand werden übernommen.
     Vorlagen, zu denen kein Wort passt, werden NICHT angelegt. */
  function migrate(keywords, templates) {
    const list = Array.isArray(keywords) ? keywords : [];
    const tpl = normalizeLexicon(templates || []);
    const index = new Map();
    tpl.forEach((g, gi) => {
      (g.variants || []).forEach(v => {
        const n = normalizeText(v);
        if (n && !index.has(n)) index.set(n, gi);
      });
    });

    const buckets = new Map();   /* Vorlagenindex → Zustand */
    const singles = [];
    list.forEach(raw => {
      const isObj = raw !== null && typeof raw === 'object';
      const text = String((isObj ? raw.text : raw) || '').trim();
      if (!text) return;
      const enabled = isObj ? raw.enabled !== false : true;
      const route = normalizeRoute(isObj ? raw.route : '');
      const exceptions = normalizeExceptions(isObj ? raw.exceptions : null);
      const n = normalizeText(text);
      const gi = index.get(n);
      if (gi === undefined) {
        singles.push({
          id: '',
          label: text,
          enabled,
          route,
          prompt: text,
          variants: [text],
          exceptions
        });
        return;
      }
      let b = buckets.get(gi);
      if (!b) {
        b = { group: cloneGroup(tpl[gi]), anyEnabled: false, routes: new Set() };
        buckets.set(gi, b);
      }
      b.anyEnabled = b.anyEnabled || enabled;
      if (route !== 'auto') b.routes.add(route);
      pushUnique(b.group.variants, text);
      mergeExceptions(b.group.exceptions, exceptions);
    });

    const out = [];
    tpl.forEach((g, gi) => {
      const b = buckets.get(gi);
      if (!b) return;
      b.group.enabled = b.anyEnabled;
      if (b.routes.size === 1 && b.group.route === 'auto') {
        b.group.route = Array.from(b.routes)[0];
      }
      out.push(b.group);
    });
    out.push(...singles);
    return {
      lexicon: normalizeLexicon(out),
      unmatched: singles.length,
      matchedGroups: buckets.size
    };
  }

  function createGroup(label, lexicon) {
    const text = String(label || '').trim();
    const used = new Set((lexicon || []).map(g => g && g.id).filter(Boolean));
    const id = uniqueId(slugify(text) || 'group', used);
    return {
      id,
      label: text || id,
      enabled: true,
      route: 'auto',
      prompt: (text || id).toLowerCase(),
      variants: text ? [text] : [],
      exceptions: []
    };
  }

  function findVariant(lexicon, text) {
    const n = normalizeText(text);
    if (!n) return null;
    for (const g of lexicon || []) {
      if ((g.variants || []).some(v => normalizeText(v) === n)) return g;
    }
    return null;
  }

  function duplicateVariants(lexicon) {
    const first = new Map();
    const dups = [];
    (lexicon || []).forEach(g => {
      (g.variants || []).forEach(v => {
        const n = normalizeText(v);
        if (!n) return;
        if (first.has(n) && first.get(n) !== g.id) {
          dups.push({ text: v, group: g.id, first: first.get(n) });
        } else if (!first.has(n)) {
          first.set(n, g.id);
        }
      });
    });
    return dups;
  }

  function stats(lexicon) {
    const groups = (lexicon || []).length;
    const variants = (lexicon || []).reduce((n, g) => n + ((g.variants || []).length), 0);
    const enabled = (lexicon || []).filter(g => g.enabled !== false).length;
    return { groups, variants, enabled };
  }

  window.YB = window.YB || {};
  window.YB.lexicon = {
    ROUTES,
    normalizeText,
    normalizeRoute,
    normalizeLexicon,
    entriesFor,
    routeApplies,
    toKeywords,
    migrate,
    createGroup,
    findVariant,
    duplicateVariants,
    stats,
    slugify
  };
})();
