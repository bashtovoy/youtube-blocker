/* test-reinject-health.js — Selbstheilung verwaister Content-Scripts in offenen
   YouTube-Tabs (Nachreichen in extension/background.js). Reine Logik, ohne Browser:
   background.js läuft in einer vm mit gemocktem `api` (Chrome/MV3-Form). Geprüft wird,
   wann ein Nachfassen läuft (Drossel, Notbremse, neue Extension-Sitzung, Versionswechsel)
   und in welche Tabs injiziert wird. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
const VERSION = '1.5.9';
const MIN = 60 * 1000;

function makeSandbox({ store = {}, session = {}, withSession = true, tabs = [], alive = {} } = {}) {
  const calls = { inject: [], logs: [], warns: [] };
  const local = { ...store };
  const sess = { ...session };
  const pick = (src, keys) => {
    if (keys == null) return { ...src };
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of list) if (k in src) out[k] = src[k];
    return out;
  };
  const api = {
    runtime: {
      getManifest: () => ({ version: VERSION, content_scripts: [{ js: ['matcher.js', 'content.js'] }] }),
      onMessage: { addListener: () => {} }
    },
    storage: {
      local: {
        get: keys => Promise.resolve(pick(local, keys)),
        set: obj => { Object.assign(local, obj); return Promise.resolve(); }
      },
      onChanged: { addListener: () => {} }
    },
    tabs: {
      onUpdated: { addListener: () => {} },
      query: () => Promise.resolve(tabs),
      sendMessage: tabId => {
        if (alive[tabId]) return Promise.resolve({ version: alive[tabId] });
        return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
      }
    },
    scripting: {
      executeScript: arg => { calls.inject.push(arg); return Promise.resolve(); }
    },
    browserAction: { setBadgeText: () => {} }
  };
  if (withSession) {
    api.storage.session = {
      get: keys => Promise.resolve(pick(sess, keys)),
      set: obj => { Object.assign(sess, obj); return Promise.resolve(); }
    };
  }
  const consoleStub = {
    log: (...a) => calls.logs.push(a.join(' ')),
    warn: (...a) => calls.warns.push(a.join(' ')),
    error: (...a) => calls.warns.push(a.join(' '))
  };
  const sandbox = { self: {}, console: consoleStub, setTimeout, clearTimeout, URL };
  sandbox.chrome = api;
  vm.runInNewContext(SRC, sandbox, { filename: 'background.js' });
  return { calls, local: () => local, sess: () => sess };
}

const settle = () => new Promise(r => setTimeout(r, 25));

(async () => {
  const now = Date.now();

  /* 1. Drossel: gleiche Version, Prüfung eben erst gelaufen, Sitzungs-Marker da →
     kein Nachfassen, auch wenn der Tab in Wahrheit längst verwaist ist. */
  {
    const sb = makeSandbox({
      store: { contentScriptVersion: VERSION, contentCheckedAt: now - 60 * 1000 },
      session: { contentSessionAt: now - 60 * 60 * 1000 },
      tabs: [{ id: 1, status: 'complete' }]
    });
    await settle();
    assert.strictEqual(sb.calls.inject.length, 0, 'innerhalb der Drossel ohne neue Sitzung — still');
    assert.strictEqual(sb.local().contentCheckedAt, now - 60 * 1000, 'Zeitstempel bleibt unangetastet');
  }

  /* 2. Frische Extension-Sitzung (Chrome leert storage.session bei Reload/Update/
     Neustart) → sofortiges Nachfassen trotz Drossel: toter Tab wird geheilt. */
  {
    const t0 = Date.now();
    const sb = makeSandbox({
      store: { contentScriptVersion: VERSION, contentCheckedAt: now - 60 * 1000 },
      session: {},
      tabs: [{ id: 1, status: 'complete' }]
    });
    await settle();
    assert.strictEqual(sb.calls.inject.length, 1, 'neue Sitzung heilt sofort');
    assert.deepStrictEqual(sb.calls.inject[0].files, ['matcher.js', 'content.js']);
    assert.strictEqual(sb.calls.inject[0].target.tabId, 1);
    assert.ok(sb.sess().contentSessionAt >= t0, 'Sitzungs-Marker gesetzt');
    assert.ok(sb.local().contentCheckedAt >= t0, 'Prüfzeit aktualisiert');
    assert.ok(sb.calls.logs.some(l => l.includes('reinjected into 1')), 'Injektion protokolliert');
  }

  /* 3. Gesunde Tabs (antworten mit laufender Version) bleiben unangetastet;
     nur der Prüfzeitstempel wandert weiter. */
  {
    const t0 = Date.now();
    const sb = makeSandbox({
      store: { contentScriptVersion: VERSION, contentCheckedAt: now - 5 * MIN },
      session: { contentSessionAt: now - 60 * 60 * 1000 },
      tabs: [{ id: 1, status: 'complete' }, { id: 2, status: 'complete' }],
      alive: { 1: VERSION, 2: VERSION }
    });
    await settle();
    assert.strictEqual(sb.calls.inject.length, 0, 'gesunde Tabs werden nicht angefasst');
    assert.ok(sb.local().contentCheckedAt >= t0);
  }

  /* 4. Abgelaufene Drossel: Injektion nur in den wachen, verwaisten Tab —
     ladende und schlafende Tabs werden übersprungen. */
  {
    const sb = makeSandbox({
      store: { contentScriptVersion: VERSION, contentCheckedAt: now - 5 * MIN },
      session: { contentSessionAt: now - 60 * 60 * 1000 },
      tabs: [{ id: 1, status: 'complete' }, { id: 2, status: 'loading' }, { id: 3, discarded: true }]
    });
    await settle();
    assert.deepStrictEqual(sb.calls.inject.map(c => c.target.tabId), [1]);
  }

  /* 5. Notbremse: Prüfung liegt keine 30 s zurück → kein zweiter Lauf,
     selbst wenn die Sitzung frisch wirkt. */
  {
    const sb = makeSandbox({
      store: { contentScriptVersion: VERSION, contentCheckedAt: now - 5 * 1000 },
      session: {},
      tabs: [{ id: 1, status: 'complete' }]
    });
    await settle();
    assert.strictEqual(sb.calls.inject.length, 0, 'enge Doppelläufe sind gesperrt');
  }

  /* 6. Versionswechsel (echtes Update): heilt sofort, egal wie frisch die letzte Prüfung war. */
  {
    const sb = makeSandbox({
      store: { contentScriptVersion: '1.5.8', contentCheckedAt: now - 60 * 1000 },
      session: { contentSessionAt: now - 60 * 1000 },
      tabs: [{ id: 1, status: 'complete' }]
    });
    await settle();
    assert.strictEqual(sb.calls.inject.length, 1, 'neue Version heilt sofort');
    assert.strictEqual(sb.local().contentScriptVersion, VERSION);
  }

  /* 7. Firefox-Form (kein storage.session): innerhalb der Drossel — still … */
  {
    const sb = makeSandbox({
      withSession: false,
      store: { contentScriptVersion: VERSION, contentCheckedAt: now - 60 * 1000 },
      tabs: [{ id: 1, status: 'complete' }]
    });
    await settle();
    assert.strictEqual(sb.calls.inject.length, 0);
  }

  /* 8. … und nach Ablauf des Intervalls heilt das Nachfassen auch ohne Sitzungs-Marker. */
  {
    const sb = makeSandbox({
      withSession: false,
      store: { contentScriptVersion: VERSION, contentCheckedAt: now - 5 * MIN },
      tabs: [{ id: 1, status: 'complete' }]
    });
    await settle();
    assert.strictEqual(sb.calls.inject.length, 1);
  }

  console.log('test-reinject-health: OK');
})().catch(e => { console.error(e); process.exit(1); });
