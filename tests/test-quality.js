/* test-quality.js — erzwungene Videoqualität.
   Teil 1 prüft die reinen Regeln (extension/quality-rules.js), Teil 2 den
   MAIN-World-Controller (extension/quality.js) in einer VM mit gefälschtem
   Player, DOM und Timeruhr. Kein Browser, kein Netz. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'extension');
const RULES_SRC = fs.readFileSync(path.join(ROOT, 'quality-rules.js'), 'utf8');
const QUALITY_SRC = fs.readFileSync(path.join(ROOT, 'quality.js'), 'utf8');

/* ---------- 1) Reine Regeln ---------- */

const ruleSandbox = {};
vm.createContext(ruleSandbox);
vm.runInContext(RULES_SRC, ruleSandbox);
const Q = ruleSandbox.YBQualityRules;
assert.ok(Q, 'quality-rules.js muss YBQualityRules exportieren');

assert.strictEqual(Q.DEFAULT_QUALITY, 'hd1080', 'Default ist 1080p');
assert.strictEqual(Q.OFF, 'off');
assert.strictEqual(Q.MAX, 'max');
for (const id of ['off', 'max', 'highres', 'hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny']) {
  assert.ok(Q.QUALITY_IDS.includes(id), 'QUALITY_IDS fehlt ' + id);
}
assert.strictEqual(new Set(Q.QUALITY_IDS).size, Q.QUALITY_IDS.length, 'QUALITY_IDS ohne Duplikate');

/* Normalisierung: IDs, Anzeigenamen, Alias und Auto-Schreibweisen. */
assert.strictEqual(Q.normalize('hd1080'), 'hd1080');
assert.strictEqual(Q.normalize('1080p'), 'hd1080');
assert.strictEqual(Q.normalize('HD720'), 'hd720');
assert.strictEqual(Q.normalize('hd4320'), 'highres', 'Alias für 4320p');
assert.strictEqual(Q.normalize('highres'), 'highres');
assert.strictEqual(Q.normalize('auto'), 'off');
assert.strictEqual(Q.normalize('AUTO'), 'off');
assert.strictEqual(Q.normalize('off'), 'off');
assert.strictEqual(Q.normalize('max'), 'max');
assert.strictEqual(Q.normalize(''), 'hd1080', 'leer → Standard');
assert.strictEqual(Q.normalize(null), 'hd1080');
assert.strictEqual(Q.normalize(null, Q.OFF), 'off', 'Default kann überschrieben werden');
assert.strictEqual(Q.normalize('bogus'), 'hd1080', 'Unbekannt → Standard');
assert.strictEqual(Q.normalize('bogus', '720p'), 'hd720', 'Unbekannt → normalisierter Fallback');

assert.strictEqual(Q.rankOf('highres'), 4320);
assert.strictEqual(Q.rankOf('hd4320'), 4320);
assert.strictEqual(Q.rankOf('hd1080'), 1080);
assert.strictEqual(Q.rankOf('off'), 0);
assert.strictEqual(Q.rankOf('bogus'), 0);
assert.strictEqual(Q.labelOf('hd4320'), '4320p');
assert.strictEqual(Q.labelOf('1080p'), '1080p');
assert.strictEqual(Q.labelOf('off'), '');

assert.strictEqual(Q.sameQuality('hd4320', 'highres'), true, 'Alias ist dieselbe Stufe');
assert.strictEqual(Q.sameQuality('hd1080', '1080p'), true);
assert.strictEqual(Q.sameQuality('hd1080', 'hd720'), false);
assert.strictEqual(Q.sameQuality('max', 'max'), true);
assert.strictEqual(Q.sameQuality('max', 'hd1080'), false);
assert.strictEqual(Q.sameQuality('auto', 'off'), true);

/* Auflösung: genau, nächstkleiner, kleinste/höchste verfügbare Stufe. */
assert.strictEqual(Q.resolveQuality('hd1080', ['hd1080', 'hd720', 'medium']), 'hd1080');
assert.strictEqual(Q.resolveQuality('hd1440', ['hd1080', 'hd720']), 'hd1080', 'nächstkleinere Stufe');
assert.strictEqual(Q.resolveQuality('tiny', ['hd1080', 'hd720']), 'hd720', 'keine kleinere → kleinste verfügbare');
assert.strictEqual(Q.resolveQuality('max', ['hd2160', 'hd1080', 'hd720']), 'hd2160');
assert.strictEqual(Q.resolveQuality('off', ['hd1080']), null);
assert.strictEqual(Q.resolveQuality('hd1080', []), null);
assert.strictEqual(Q.resolveQuality('hd1080', ['auto', '1080p', 'hd1080', 'bogus']), 'hd1080',
  'Auto/Unbekannt/Duplikate werden gefiltert');

/* Geltungsbereich: nur Watch und Live, nur www/youtube.com. */
assert.strictEqual(Q.isWatchPath('/watch'), true);
assert.strictEqual(Q.isWatchPath('/live/abc123'), true);
assert.strictEqual(Q.isWatchPath('/live/abc123/'), true);
assert.strictEqual(Q.isWatchPath('/'), false);
assert.strictEqual(Q.isWatchPath('/watchlater'), false);
assert.strictEqual(Q.isWatchPath('/shorts/abc'), false);
assert.strictEqual(Q.isWatchPath('/live'), false);
assert.strictEqual(Q.isQualityHost('www.youtube.com'), true);
assert.strictEqual(Q.isQualityHost('youtube.com'), true);
assert.strictEqual(Q.isQualityHost('music.youtube.com'), false);
assert.strictEqual(Q.isQualityHost('m.youtube.com'), false);
assert.strictEqual(Q.isQualityHost('youtube.com.evil.test'), false);

/* ---------- 2) MAIN-World-Controller ---------- */

function makePlayer(opts) {
  const o = opts || {};
  const p = {
    videoId: o.videoId || 'vid1',
    current: o.current || 'hd720',
    preferred: o.preferred || '',
    levels: o.levels ? o.levels.slice() : ['hd1080', 'hd720', 'medium'],
    ad: !!o.ad,
    calls: [],
    classList: { contains: cls => p.ad && cls === 'ad-showing' },
    getVideoData: () => ({ video_id: p.videoId }),
    getAvailableQualityLevels: () => p.levels.slice(),
    getPlaybackQuality: () => p.current,
    getPreferredQuality: () => p.preferred,
    getAdState: () => (p.ad ? 1 : 0),
    setPlaybackQualityRange: (a, b) => {
      p.calls.push([a, b]);
      p.current = a;
      p.preferred = a;
    }
  };
  return p;
}

function makeHarness(opts) {
  const o = opts || {};
  const attrs = new Map();
  if (o.setting !== undefined && o.setting !== null) {
    attrs.set('data-yb-video-quality', o.setting);
  }
  const player = o.player || makePlayer(o);
  let clock = 0;
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();
  const docListeners = new Map();
  const winListeners = new Map();
  const observers = [];

  const docEl = {
    getAttribute: key => (attrs.has(key) ? attrs.get(key) : null),
    setAttribute: (key, value) => { attrs.set(key, String(value)); },
    removeAttribute: key => { attrs.delete(key); }
  };
  const document = {
    documentElement: docEl,
    getElementById: id => (id === 'movie_player' ? player : null),
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      const set = docListeners.get(type);
      if (set) set.delete(fn);
    }
  };
  const window = {
    addEventListener: (type, fn) => {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      const set = winListeners.get(type);
      if (set) set.delete(fn);
    }
  };
  const sandbox = {
    console,
    location: {
      hostname: o.hostname || 'www.youtube.com',
      pathname: o.pathname || '/watch',
      search: o.search || '?v=vid1',
      href: o.href || ('https://' + (o.hostname || 'www.youtube.com') + (o.pathname || '/watch') + (o.search || '?v=vid1'))
    },
    document,
    window,
    MutationObserver: class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
      notify() { if (!this.disconnected) this.cb([]); }
    },
    setTimeout: (fn, delay) => {
      const id = nextId++;
      timeouts.set(id, { fn, at: clock + (Number(delay) || 0) });
      return id;
    },
    clearTimeout: id => { timeouts.delete(id); },
    setInterval: (fn, delay) => {
      const id = nextId++;
      intervals.set(id, { fn, delay: Number(delay) || 0, next: clock + (Number(delay) || 0) });
      return id;
    },
    clearInterval: id => { intervals.delete(id); },
    Date: { now: () => clock },
    URL,
    JSON
  };
  vm.createContext(sandbox);
  vm.runInContext(RULES_SRC, sandbox);
  vm.runInContext(QUALITY_SRC, sandbox);

  function advance(ms) {
    const target = clock + (Number(ms) || 0);
    let guard = 0;
    for (;;) {
      if (++guard > 10000) throw new Error('Timer-Schleife im Test');
      let best = null;
      let kind = '';
      let id = null;
      for (const [tid, t] of timeouts) {
        if (t.at <= target && (!best || t.at < best.at)) { best = t; kind = 'timeout'; id = tid; }
      }
      for (const [iid, i] of intervals) {
        if (i.next <= target && (!best || i.next < best.at)) {
          best = { at: i.next, fn: i.fn };
          kind = 'interval';
          id = iid;
        }
      }
      if (!best) break;
      clock = Math.max(clock, best.at);
      if (kind === 'timeout') timeouts.delete(id);
      else intervals.get(id).next = clock + intervals.get(id).delay;
      best.fn();
    }
    clock = target;
  }

  function dispatch(type, event, map) {
    const set = (map || docListeners).get(type);
    if (!set) return;
    for (const fn of Array.from(set)) fn(event || {});
  }

  function setSetting(value) {
    if (value === null || value === undefined) attrs.delete('data-yb-video-quality');
    else attrs.set('data-yb-video-quality', String(value));
    for (const obs of observers) obs.notify();
  }

  function status() {
    const raw = attrs.get('data-yb-quality-status');
    return raw ? JSON.parse(raw) : null;
  }

  return {
    sandbox,
    player,
    attrs,
    advance,
    status,
    setSetting,
    dispatchDocument: (type, event) => dispatch(type, event, docListeners),
    dispatchWindow: (type, event) => dispatch(type, event, winListeners),
    observer: () => observers[observers.length - 1],
    api: sandbox.__YB_QUALITY__
  };
}

/* 2a. Start auf /watch: Wunschqualität wird gesetzt, Status ist aktiv. */
{
  const h = makeHarness({ setting: 'hd1080', player: makePlayer({ current: 'hd720', levels: ['hd1080', 'hd720'] }) });
  assert.ok(h.api && h.api.version === '1.9.0', 'Controller meldet Version 1.9.0');
  h.advance(0);
  assert.deepStrictEqual(h.player.calls, [['hd1080', 'hd1080']]);
  const st = h.status();
  assert.strictEqual(st.mode, 'active');
  assert.strictEqual(st.actual, 'hd1080');
  assert.strictEqual(st.videoId, 'vid1');
  assert.strictEqual(st.manual, false);
}

/* 2b. Nicht verfügbare Wunschstufe → nächstkleinere, Status „fallback“. */
{
  const h = makeHarness({ setting: 'hd2160', player: makePlayer({ levels: ['hd1080', 'hd720'] }) });
  h.advance(0);
  assert.deepStrictEqual(h.player.calls, [['hd1080', 'hd1080']]);
  const st = h.status();
  assert.strictEqual(st.mode, 'fallback');
  assert.strictEqual(st.requested, 'hd2160');
  assert.strictEqual(st.actual, 'hd1080');
}

/* 2c. `max` wählt die höchste verfügbare Stufe ohne Fallback-Warnung. */
{
  const h = makeHarness({ setting: 'max', player: makePlayer({ levels: ['hd2160', 'hd1080', 'hd720'] }) });
  h.advance(0);
  assert.deepStrictEqual(h.player.calls, [['hd2160', 'hd2160']]);
  assert.strictEqual(h.status().mode, 'active');
}

/* 2d. Shorts/Startseite bleiben unangetastet (kein Player-Zugriff, Status idle). */
for (const pathname of ['/', '/shorts/abc', '/feed/subscriptions']) {
  const h = makeHarness({ setting: 'hd1080', pathname, href: 'https://www.youtube.com' + pathname });
  h.advance(0);
  assert.deepStrictEqual(h.player.calls, [], pathname + ': kein Eingriff');
  assert.strictEqual(h.status().mode, 'idle');
}

/* 2e. Werbung pausiert die Steuerung; danach greift sie wieder. */
{
  const h = makeHarness({ setting: 'hd1080', player: makePlayer({ ad: true }) });
  h.advance(0);
  assert.deepStrictEqual(h.player.calls, [], 'während Werbung wird nicht gesetzt');
  assert.strictEqual(h.status().mode, 'ad');
  h.player.ad = false;
  h.advance(2000);
  assert.deepStrictEqual(h.player.calls, [['hd1080', 'hd1080']]);
  assert.strictEqual(h.status().mode, 'active');
}

/* 2f. Manuelle Auswahl im Player-Menü bleibt bis zum nächsten Video erhalten. */
{
  const h = makeHarness({ setting: 'hd1080', player: makePlayer({ current: 'hd720' }) });
  h.advance(0);
  assert.deepStrictEqual(h.player.calls, [['hd1080', 'hd1080']]);

  /* Menüklick, danach wählt der Nutzer 720p. */
  h.dispatchDocument('click', { target: { closest: () => ({}) } });
  h.player.preferred = 'hd720';
  h.player.current = 'hd720';
  h.advance(260);
  assert.strictEqual(h.status().mode, 'manual');
  assert.strictEqual(h.status().actual, 'hd720');

  const callsAfterManual = h.player.calls.length;
  h.advance(4000);   /* mehrere Watchdog-Runden */
  assert.strictEqual(h.player.calls.length, callsAfterManual, 'manuelle Wahl wird nicht überschrieben');
  assert.strictEqual(h.status().mode, 'manual');

  /* Nächstes Video: erneute Durchsetzung. */
  h.player.videoId = 'vid2';
  h.player.current = 'hd720';
  h.player.preferred = 'hd720';
  h.advance(2000);
  assert.deepStrictEqual(h.player.calls[h.player.calls.length - 1], ['hd1080', 'hd1080']);
  assert.strictEqual(h.status().mode, 'active');
  assert.strictEqual(h.status().videoId, 'vid2');
}

/* 2g. Umschalten auf „off“ setzt YouTube zurück auf Auto. */
{
  const h = makeHarness({ setting: 'hd1080' });
  h.advance(0);
  assert.deepStrictEqual(h.player.calls, [['hd1080', 'hd1080']]);
  h.setSetting('off');
  h.advance(0);
  assert.deepStrictEqual(h.player.calls[h.player.calls.length - 1], ['auto', 'auto']);
  assert.strictEqual(h.status().mode, 'off');
  assert.strictEqual(h.status().setting, 'off');
}

/* 2h. Einstellungswechsel per DOM-Attribut (Content-Skript → MAIN-Welt). */
{
  const h = makeHarness({ setting: 'hd1080' });
  h.advance(0);
  h.setSetting('720p');
  h.advance(0);
  assert.deepStrictEqual(h.player.calls[h.player.calls.length - 1], ['hd720', 'hd720']);
  assert.strictEqual(h.status().mode, 'active');
}

/* 2i. Fehlende Player-API: still warten statt Ausnahme (fail open). */
{
  const player = makePlayer();
  delete player.setPlaybackQualityRange;
  const h = makeHarness({ setting: 'hd1080', player });
  assert.doesNotThrow(() => h.advance(0));
  assert.strictEqual(h.status().mode, 'waiting');
}

/* 2j. Fehlendes Attribut: kein Eingriff; nach dem Publizieren greift die Steuerung. */
{
  const h = makeHarness({ setting: null });
  h.advance(0);
  assert.deepStrictEqual(h.player.calls, []);
  assert.strictEqual(h.status(), null);
  h.setSetting('hd1080');
  h.advance(0);
  assert.deepStrictEqual(h.player.calls, [['hd1080', 'hd1080']]);
}

/* 2k. Doppel-Injektion beendet die alte Instanz (keine zwei Watchdogs). */
{
  const h = makeHarness({ setting: 'hd1080' });
  const oldApi = h.api;
  h.advance(0);
  const oldCalls = h.player.calls.length;
  vm.runInContext(QUALITY_SRC, h.sandbox);
  assert.notStrictEqual(h.sandbox.__YB_QUALITY__, oldApi, 'neue Instanz ersetzt die alte');
  h.advance(4000);
  assert.strictEqual(h.player.calls.length, oldCalls + 1, 'nur die neue Instanz setzt die Qualität erneut');
}

console.log('test-quality: OK');
