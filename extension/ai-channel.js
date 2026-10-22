/* ai-channel.js — lokaler Kanal-Zähler für offizielle KI-Kennzeichnungen.
   DOM-frei, damit content.js und background.js dieselbe Logik nutzen und die
   Regeln ohne Browser testbar bleiben. */
(function () {
  'use strict';

  const root = (typeof self !== 'undefined') ? self : window;

  const MIN_AI_VIDEOS = 2;
  const WINDOW_MS = 180 * 24 * 60 * 60 * 1000;
  const TTL_MS = 365 * 24 * 60 * 60 * 1000;
  const MAX_VIDEOS = 10;
  const MAX_CHANNELS = 300;
  const MODES = ['off', 'badge', 'dim', 'hide'];

  function clean(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function lower(value) {
    return clean(value).toLocaleLowerCase();
  }

  function decode(value) {
    try { return decodeURIComponent(value); } catch (e) { return value; }
  }

  function normalizeHandle(value) {
    const h = clean(value);
    if (!h) return '';
    return (h.charAt(0) === '@' ? h : '@' + h).toLocaleLowerCase();
  }

  function fallbackRef(name) {
    const display = clean(name);
    return {
      key: display ? 'name:' + lower(display) : '',
      id: '',
      handle: '',
      legacy: '',
      name: display
    };
  }

  /* Link aus Karte oder Watch-Seite → stabile, möglichst starke Kennung.
     /channel/UC… ist stärker als /@handle; /c/ und /user/ sind Altformen. */
  function refFromHref(href, name) {
    const display = clean(name);
    let url = null;
    try {
      url = new URL(String(href || ''), 'https://www.youtube.com');
    } catch (e) { /* relative oder kaputte Links → Name-Fallback */ }

    if (url) {
      const host = url.hostname.toLowerCase();
      const youtube = host === 'youtube.com' || host.endsWith('.youtube.com');
      if (youtube) {
        const parts = url.pathname.split('/').filter(Boolean).map(decode);
        if (parts.length >= 2 && parts[0] === 'channel') {
          const id = clean(parts[1]);
          if (/^[A-Za-z0-9_-]{10,}$/.test(id)) {
            return { key: id, id, handle: '', legacy: '', name: display };
          }
        }
        if (parts.length >= 1 && parts[0].charAt(0) === '@') {
          const handle = normalizeHandle(parts[0]);
          if (handle.length > 1) {
            return { key: handle, id: '', handle, legacy: '', name: display };
          }
        }
        if (parts.length >= 2 && (parts[0] === 'c' || parts[0] === 'user')) {
          const legacy = 'legacy:' + lower(parts[1]);
          return { key: legacy, id: '', handle: '', legacy, name: display };
        }
      }
    }
    return fallbackRef(display);
  }

  function normalizeRef(ref) {
    const r = ref && typeof ref === 'object' ? ref : {};
    const name = clean(r.name);
    const id = clean(r.id);
    const handle = normalizeHandle(r.handle);
    const legacy = clean(r.legacy);
    let key = clean(r.key);
    if (!key) {
      if (id) key = id;
      else if (handle) key = handle;
      else if (legacy) key = legacy;
      else if (name) key = 'name:' + lower(name);
    }
    return { key, id, handle, legacy, name };
  }

  function aliasesOf(rec) {
    const a = (rec && rec.aliases) || {};
    return {
      id: clean(a.id),
      handle: normalizeHandle(a.handle),
      legacy: clean(a.legacy),
      name: clean(a.name)
    };
  }

  function weakIdentity(ref) {
    return !ref.id && !ref.handle && !ref.legacy;
  }

  function sameAlias(a, ref) {
    const rec = aliasesOf(a);
    if (rec.id && ref.id && rec.id === ref.id) return true;
    if (rec.handle && ref.handle && rec.handle === ref.handle) return true;
    if (rec.legacy && ref.legacy && rec.legacy === ref.legacy) return true;
    /* Namen sind nur ein schwacher Alias: nie zwei starke Kennungen allein
       über den Anzeigenamen zusammenführen. */
    if (rec.name && ref.name && lower(rec.name) === lower(ref.name) &&
        (weakIdentity(rec) || weakIdentity(ref))) return true;
    return false;
  }

  function findRecord(store, ref) {
    const all = store && typeof store === 'object' ? store : {};
    const key = clean(ref && ref.key);
    if (key && all[key]) return { key, rec: all[key] };
    for (const k of Object.keys(all)) {
      if (sameAlias(all[k], ref)) return { key: k, rec: all[k] };
    }
    return null;
  }

  function mergeAliases(rec, ref) {
    const a = aliasesOf(rec);
    return {
      id: a.id || ref.id || '',
      handle: a.handle || ref.handle || '',
      legacy: a.legacy || ref.legacy || '',
      name: a.name || ref.name || ''
    };
  }

  function validVideoId(videoId) {
    return /^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''));
  }

  function prune(store, now) {
    const all = store && typeof store === 'object' ? store : {};
    const entries = [];
    for (const key of Object.keys(all)) {
      const rec = all[key];
      if (!rec || typeof rec !== 'object') continue;
      const videos = (Array.isArray(rec.videos) ? rec.videos : [])
        .filter(v => v && validVideoId(v.id) && Number.isFinite(v.at) && now - v.at <= WINDOW_MS)
        .slice(-MAX_VIDEOS);
      const lastAiAt = Number.isFinite(rec.lastAiAt) ? rec.lastAiAt : (videos.length ? videos[videos.length - 1].at : 0);
      if (!videos.length || now - lastAiAt > TTL_MS) continue;
      entries.push([key, Object.assign({}, rec, {
        aliases: aliasesOf(rec),
        videos,
        lastAiAt
      })]);
    }
    entries.sort((a, b) => (b[1].lastAiAt || 0) - (a[1].lastAiAt || 0));
    const out = {};
    for (const [key, rec] of entries.slice(0, MAX_CHANNELS)) out[key] = rec;
    return out;
  }

  /* Ein offizieller KI-Befund für ein Video. Dasselbe Video zählt nur einmal;
     alte Befunde fallen nach 180 Tagen aus dem Fenster. */
  function recordHit(store, ref, videoId, now) {
    const r = normalizeRef(ref);
    const at = Number.isFinite(now) ? now : Date.now();
    if (!r.key || !validVideoId(videoId)) return prune(store, at);

    const next = Object.assign({}, store && typeof store === 'object' ? store : {});
    const found = findRecord(next, r);
    const key = found ? found.key : r.key;
    const old = found ? found.rec : {};
    const videos = (Array.isArray(old.videos) ? old.videos : [])
      .filter(v => v && validVideoId(v.id) && Number.isFinite(v.at));
    const had = videos.some(v => v.id === videoId);
    const fresh = videos.filter(v => at - v.at <= WINDOW_MS);

    if (!had) fresh.push({ id: videoId, at });
    const trimmed = fresh.slice(-MAX_VIDEOS);
    next[key] = Object.assign({}, old, {
      key,
      aliases: mergeAliases(old, r),
      videos: trimmed,
      lastAiAt: had ? (Number.isFinite(old.lastAiAt) ? old.lastAiAt : at) : at
    });
    return prune(next, at);
  }

  function isFlagged(rec, now) {
    if (!rec || typeof rec !== 'object') return false;
    const at = Number.isFinite(now) ? now : Date.now();
    const videos = (Array.isArray(rec.videos) ? rec.videos : [])
      .filter(v => v && validVideoId(v.id) && Number.isFinite(v.at) && at - v.at <= WINDOW_MS);
    return videos.length >= MIN_AI_VIDEOS;
  }

  function allowed(feedback, ref, videoId) {
    const f = feedback && typeof feedback === 'object' ? feedback : {};
    if (videoId && f.allowVideos && f.allowVideos[videoId]) return true;
    const allow = f.allowChannels && typeof f.allowChannels === 'object' ? f.allowChannels : {};
    const r = normalizeRef(ref);
    if (r.key && allow[r.key]) return true;
    if (r.id && allow[r.id]) return true;
    if (r.handle && allow[r.handle]) return true;
    if (r.legacy && allow[r.legacy]) return true;
    return false;
  }

  /* Liefert 'off' | 'badge' | 'dim' | 'hide'. Die offizielle Kennzeichnung
     bleibt die einzige Quelle; diese Entscheidung gilt nur für Karten, deren
     Kanal bereits mehrere offizielle Befunde hat. */
  function decision(store, ref, settings, feedback, videoId, now) {
    const s = settings && typeof settings === 'object' ? settings : {};
    if (!s.hideAiGenerated) return 'off';
    const mode = MODES.includes(s.aiChannelMode) ? s.aiChannelMode : 'off';
    if (mode === 'off') return 'off';
    if (allowed(feedback, ref, videoId)) return 'off';
    const found = findRecord(store, normalizeRef(ref));
    return found && isFlagged(found.rec, now) ? mode : 'off';
  }

  const TEXTS = {
    de: {
      mark: 'KI?',
      aria: 'Kanal mit wiederholter offizieller KI-Kennzeichnung',
      hint: 'Mehrere Videos dieses Kanals wurden von YouTube offiziell als KI erstellt gekennzeichnet.'
    },
    en: {
      mark: 'AI?',
      aria: 'Channel with repeated official AI labels',
      hint: 'Several videos from this channel were officially labelled by YouTube as made with AI.'
    },
    ru: {
      mark: 'ИИ?',
      aria: 'Канал с повторной официальной маркировкой ИИ',
      hint: 'Несколько видео этого канала официально помечены YouTube как созданные с помощью ИИ.'
    },
    uk: {
      mark: 'ШІ?',
      aria: 'Канал із повторним офіційним маркуванням ШІ',
      hint: 'Кілька відео цього каналу офіційно позначені YouTube як створені за допомогою ШІ.'
    }
  };

  function badgeText(lang) {
    return TEXTS[lang] || TEXTS.en;
  }

  root.YB = root.YB || {};
  root.YB.aiChannel = {
    MIN_AI_VIDEOS,
    WINDOW_MS,
    TTL_MS,
    MAX_VIDEOS,
    MAX_CHANNELS,
    MODES,
    refFromHref,
    normalizeRef,
    findRecord,
    recordHit,
    isFlagged,
    allowed,
    decision,
    prune,
    badgeText
  };
})();
