/* quality-rules.js — reine Regeln für die erzwungene Videoqualität.
   Kein DOM, kein Player: dieselbe Logik läuft im Popup, im Content-Skript,
   im MAIN-World-Controller und in den Node-Tests. */
(function () {
  'use strict';

  const DEFAULT_QUALITY = 'hd1080';
  const OFF = 'off';
  const MAX = 'max';

  /* YouTube-Qualitätskennungen. `highres` ist die kanonische 4320p-Kennung;
     `hd4320` kommt in einigen Clients/Exporten als Alias vor. */
  const LEVELS = [
    { id: 'highres', label: '4320p', rank: 4320, aliases: ['hd4320'] },
    { id: 'hd2880', label: '2880p', rank: 2880, aliases: [] },
    { id: 'hd2160', label: '2160p', rank: 2160, aliases: [] },
    { id: 'hd1440', label: '1440p', rank: 1440, aliases: [] },
    { id: 'hd1080', label: '1080p', rank: 1080, aliases: [] },
    { id: 'hd720', label: '720p', rank: 720, aliases: [] },
    { id: 'large', label: '480p', rank: 480, aliases: [] },
    { id: 'medium', label: '360p', rank: 360, aliases: [] },
    { id: 'small', label: '240p', rank: 240, aliases: [] },
    { id: 'tiny', label: '144p', rank: 144, aliases: [] }
  ];

  const LEVEL_BY_ID = new Map();
  const ALIAS_TO_ID = new Map();
  for (const level of LEVELS) {
    LEVEL_BY_ID.set(level.id, level);
    ALIAS_TO_ID.set(level.id, level.id);
    ALIAS_TO_ID.set(level.label, level.id);
    for (const alias of level.aliases) ALIAS_TO_ID.set(alias, level.id);
  }

  const QUALITY_IDS = [OFF, MAX, ...LEVELS.map(level => level.id)];

  function canonicalId(value) {
    if (value === null || value === undefined) return '';
    const s = String(value).trim().toLowerCase();
    if (!s) return '';
    if (s === 'auto' || s === OFF) return OFF;
    return ALIAS_TO_ID.get(s) || '';
  }

  function normalize(value, fallback) {
    const fb = fallback === undefined ? DEFAULT_QUALITY : fallback;
    if (value === null || value === undefined) {
      return fb === OFF || fb === MAX ? fb : (canonicalId(fb) || DEFAULT_QUALITY);
    }
    const s = String(value).trim().toLowerCase();
    if (s === OFF) return OFF;
    if (s === MAX) return MAX;
    const id = canonicalId(s);
    if (id) return id;
    return fb === OFF || fb === MAX ? fb : (canonicalId(fb) || DEFAULT_QUALITY);
  }

  function rankOf(value) {
    const id = canonicalId(value);
    if (!id || id === OFF) return 0;
    const level = LEVEL_BY_ID.get(id);
    return level ? level.rank : 0;
  }

  function labelOf(value) {
    const id = canonicalId(value);
    if (!id || id === OFF) return '';
    const level = LEVEL_BY_ID.get(id);
    return level ? level.label : '';
  }

  function sameQuality(a, b) {
    if (a === MAX || b === MAX) return a === b;
    const ca = canonicalId(a);
    const cb = canonicalId(b);
    if (!ca || !cb || ca === OFF || cb === OFF) return ca === cb;
    return rankOf(ca) === rankOf(cb);
  }

  function availableLevels(levels) {
    if (!Array.isArray(levels)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of levels) {
      const id = canonicalId(raw);
      if (!id || id === OFF) continue;
      const level = LEVEL_BY_ID.get(id);
      if (!level || seen.has(level.rank)) continue;
      seen.add(level.rank);
      out.push(level);
    }
    out.sort((a, b) => b.rank - a.rank);
    return out;
  }

  /* Liefert die tatsächlich zu setzende YouTube-Kennung. Bei einer festen
     Wunschqualität wird die nächstkleinere verfügbare Stufe gewählt; gibt es
     keine kleinere, die kleinste vorhandene. `max` nimmt die höchste Stufe. */
  function resolveQuality(target, levels) {
    const wanted = normalize(target);
    if (wanted === OFF) return null;
    const available = availableLevels(levels);
    if (!available.length) return null;
    if (wanted === MAX) return available[0].id;
    const wantedRank = rankOf(wanted);
    const lower = available.find(level => level.rank <= wantedRank);
    if (lower) return lower.id;
    return available[available.length - 1].id;
  }

  function isWatchPath(pathname) {
    const path = String(pathname || '');
    return path === '/watch' || path.startsWith('/live/');
  }

  function isQualityHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return host === 'www.youtube.com' || host === 'youtube.com';
  }

  const api = {
    DEFAULT_QUALITY,
    OFF,
    MAX,
    LEVELS: Object.freeze(LEVELS.map(level => Object.freeze({
      id: level.id,
      label: level.label,
      rank: level.rank,
      aliases: Object.freeze(level.aliases.slice())
    }))),
    QUALITY_IDS: Object.freeze(QUALITY_IDS),
    canonicalId,
    normalize,
    rankOf,
    labelOf,
    sameQuality,
    resolveQuality,
    isWatchPath,
    isQualityHost
  };
  Object.freeze(api);

  globalThis.YBQualityRules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
