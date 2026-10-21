/* test-background-route.js — Nachrichtenrouting in background.js ohne Browser.
   Prüft beide Wege:
   - Firefox: self.YB_ROUTES ist da → direkter Aufruf, Antwort via sendResponse;
   - Chrome: keine Routen → Statusabfragen kalt beantworten, sonst das
     Offscreen-Dokument starten und dorthin weiterreichen. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');

/* Objekte entstehen teils in der vm-Instanz; deepStrictEqual prüft auch den
   Prototyp — für Vergleiche in die Host-Welt normalisieren. */
const plain = x => JSON.parse(JSON.stringify(x));

function makeSandbox({ routes, chromeMode, shotApis, shotTab, folderStore }) {
  const calls = { offscreen: 0, sends: [], badge: [], storageSets: [], downloads: [], permissions: [] };
  const listeners = { message: null, download: null };
  const state = {};
  let contexts = [];
  const api = {
    runtime: {
      onMessage: { addListener: fn => { listeners.message = fn; } },
      sendMessage: msg => { calls.sends.push(msg); return Promise.resolve({ ok: true, route: msg.route, from: 'offscreen' }); },
      getContexts: chromeMode ? (() => Promise.resolve(contexts)) : undefined,
      getManifest: () => ({ manifest_version: chromeMode ? 3 : 2 })
    },
    storage: {
      local: {
        get: keys => {
          if (typeof keys === 'string') return Promise.resolve({ [keys]: state[keys] });
          if (Array.isArray(keys)) return Promise.resolve(keys.reduce((o, k) => (o[k] = state[k], o), {}));
          return Promise.resolve(Object.assign({}, state));
        },
        set: obj => { calls.storageSets.push(obj); Object.assign(state, obj); return Promise.resolve(); }
      },
      onChanged: { addListener: () => {} }
    },
    tabs: { onUpdated: { addListener: () => {} }, sendMessage: () => Promise.resolve() },
    browserAction: { setBadgeText: o => calls.badge.push(o) }
  };
  if (shotApis) {
    const tab = Object.assign({ id: 7, windowId: 1, active: true, cookieStoreId: 'firefox-default' }, shotTab || {});
    api.permissions = { contains: req => { calls.permissions.push(req); return Promise.resolve(true); } };
    api.tabs.query = () => Promise.resolve([tab]);
    api.tabs.get = id => Promise.resolve(Object.assign({}, tab, { id }));
    api.tabs.captureTab = () => Promise.resolve('data:image/jpeg;base64,AAAA');
    api.downloads = {
      download: opts => { calls.downloads.push(opts); return Promise.resolve(41); },
      search: () => Promise.resolve([{ id: 41, state: 'complete' }]),
      onChanged: {
        addListener: fn => { listeners.download = fn; },
        removeListener: () => {}
      }
    };
  }
  if (chromeMode) {
    api.offscreen = {
      createDocument: () => {
        calls.offscreen++;
        contexts = [{ contextType: 'OFFSCREEN_DOCUMENT' }];
        return Promise.resolve();
      }
    };
  }
  const sandbox = { self: { YB_ROUTES: routes }, console, setTimeout, clearTimeout, URL };
  if (folderStore) sandbox.self.YB = { folder: folderStore };
  if (shotApis) vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'shots.js'), 'utf8'), sandbox);
  if (chromeMode) sandbox.chrome = api; else sandbox.browser = api;
  vm.runInNewContext(SRC, sandbox, { filename: 'background.js' });
  assert.strictEqual(typeof listeners.message, 'function', 'onMessage wurde registriert');
  return { calls, listener: listeners.message };
}

/* Ruft den Listener wie der Browser: sendResponse kommt synchron oder später
   (return true hält den Kanal offen). */
function ask(listener, msg, timeoutMs = 2000, sender = {}) {
  return new Promise((resolve, reject) => {
    let answered = false;
    const timer = setTimeout(() => { if (!answered) reject(new Error('keine Antwort auf ' + msg.type)); }, timeoutMs);
    const ret = listener(msg, sender, value => { answered = true; clearTimeout(timer); resolve({ ret: true, value }); });
    if (ret !== true) { clearTimeout(timer); resolve({ ret, value: undefined }); }
  });
}

(async () => {
  /* --- Firefox: Route vorhanden → direkt beantworten --- */
  {
    const routeOps = [];
    const { calls, listener } = makeSandbox({
      routes: {
        sem: async m => { routeOps.push(m.op); return { ok: true, status: { state: 'off', via: 'route' } }; },
        ocr: async () => ({ ok: true, status: { ready: false } })
      }
    });
    const r = await ask(listener, { type: 'ybsem', op: 'status' });
    assert.strictEqual(r.ret, true, 'asynchroner Kanal bleibt offen');
    assert.deepStrictEqual(plain(r.value), { ok: true, status: { state: 'off', via: 'route' } });
    assert.deepStrictEqual(routeOps, ['status']);
    assert.strictEqual(calls.offscreen, 0, 'Firefox startet kein Offscreen-Dokument');
    assert.strictEqual(calls.sends.length, 0);
  }

  /* --- Firefox: ybget antwortet synchron --- */
  {
    const { listener } = makeSandbox({ routes: { sem: async () => ({ ok: true }) } });
    const r = await ask(listener, { type: 'ybget' });
    assert.deepStrictEqual(plain(r.value), { keywords: [], settings: {} });
  }

  /* --- Fehlerform bleibt {ok:false, error} --- */
  {
    const { listener } = makeSandbox({ routes: { sem: async () => { throw new Error('boom'); } } });
    const r = await ask(listener, { type: 'ybsem', op: 'ensure', texts: [] });
    assert.deepStrictEqual(plain(r.value), { ok: false, error: 'boom' });
  }

  /* --- Chrome kalt: Statusabfrage ohne Offscreen-Dokument beantworten --- */
  {
    const { calls, listener } = makeSandbox({ routes: undefined, chromeMode: true });
    const r = await ask(listener, { type: 'ybsem', op: 'status' });
    assert.strictEqual(r.value.ok, true);
    assert.strictEqual(r.value.status.state, 'off');
    const o = await ask(listener, { type: 'ybocr', op: 'status' });
    assert.strictEqual(o.value.ok, true);
    assert.strictEqual(o.value.status.state, 'off', 'OCR-Host meldet kalt „aus“');
    assert.deepStrictEqual(plain(o.value.status.langs), []);
    assert.strictEqual(calls.offscreen, 0, 'kalte Statusabfrage startet kein Dokument');
  }

  /* --- Chrome: ensure startet das Offscreen-Dokument und reicht weiter --- */
  {
    const { calls, listener } = makeSandbox({ routes: undefined, chromeMode: true });
    const r = await ask(listener, { type: 'ybsem', op: 'ensure', texts: ['Дрон'], key: 'k' });
    assert.strictEqual(calls.offscreen, 1, 'Offscreen-Dokument wurde erstellt');
    assert.deepStrictEqual(plain(calls.sends[0]), { target: 'offscreen', route: 'sem', msg: { type: 'ybsem', op: 'ensure', texts: ['Дрон'], key: 'k' } });
    assert.strictEqual(r.value.from, 'offscreen');
    const o = await ask(listener, { type: 'ybocr', op: 'recognize', url: 'u', langs: 'eng' });
    assert.strictEqual(calls.sends[1].route, 'ocr');
    assert.strictEqual(o.value.ok, true);
  }

  /* --- Statusmeldung aus dem Offscreen-Dokument landet in storage --- */
  {
    const { calls, listener } = makeSandbox({ routes: undefined, chromeMode: true });
    await ask(listener, { target: 'sw', op: 'yb-sw-storage-set', key: 'semStatus', payload: { state: 'off' } });
    assert.deepStrictEqual(plain(calls.storageSets[0]), { semStatus: { state: 'off' } });
  }

  /* --- Badge startet mit Zählerstand aus storage --- */
  {
    const { calls } = makeSandbox({ routes: {}, chromeMode: false });
    await new Promise(r => setTimeout(r, 10));
    assert.deepStrictEqual(plain(calls.badge[0]), { text: '' });
  }

  /* --- Manuelle Testaufnahme: Aufnahme, Download, letzter Status --- */
  {
    const { calls, listener } = makeSandbox({ routes: {}, chromeMode: false, shotApis: true });
    const r = await ask(listener, { type: 'ybshot-test', tabId: 7 });
    assert.strictEqual(r.ret, true, 'Testaufnahme antwortet asynchron');
    assert.strictEqual(r.value.ok, true);
    assert.match(r.value.file, /^YouTube Blocker\/\d{4}-\d{2}-\d{2}\/\d{6}_test_test\.jpg$/);
    assert.strictEqual(r.value.incognito, false);
    assert.strictEqual(calls.downloads.length, 1);
    assert.match(calls.downloads[0].url, /^data:image\/jpeg;base64,/);
    assert.strictEqual(calls.downloads[0].incognito, undefined, 'normaler Kontext ohne incognito');
    const shot = calls.storageSets.map(x => x.lastShot).filter(Boolean).pop();
    assert.ok(shot, 'lastShot wurde gespeichert');
    assert.strictEqual(shot.status, 'saved');
    assert.strictEqual(shot.source, 'manual');
    assert.strictEqual(shot.file, r.value.file);
  }

  /* --- Privates Fenster: Download und Status als incognito markieren --- */
  {
    const { calls, listener } = makeSandbox({
      routes: {}, chromeMode: false, shotApis: true,
      shotTab: { id: 8, cookieStoreId: 'firefox-private', incognito: true }
    });
    const r = await ask(listener, { type: 'ybshot-test', tabId: 8 });
    assert.strictEqual(r.value.ok, true);
    assert.strictEqual(r.value.incognito, true);
    assert.strictEqual(calls.downloads.length, 1);
    assert.strictEqual(calls.downloads[0].incognito, true, 'privater Download');
    const shot = calls.storageSets.map(x => x.lastShot).filter(Boolean).pop();
    assert.ok(shot, 'lastShot für privat gespeichert');
    assert.strictEqual(shot.incognito, true);
    assert.strictEqual(shot.status, 'saved');
  }

  /* --- Chrome ohne Ordner: Testaufnahme wird vorgemerkt, kein Download --- */
  {
    const stored = [];
    const folder = {
      storeSupported: () => true,
      saveOrQueue: async (dataUrl, file, meta) => {
        stored.push({ file, meta });
        return { ok: false, pending: true, reason: 'no-folder' };
      },
      flushPending: async () => ({ ok: true, saved: 1, failed: 0, lastSaved: 'YouTube Blocker/2026-10-21/neu.jpg', pending: 0 })
    };
    const { calls, listener } = makeSandbox({
      routes: {}, chromeMode: true, shotApis: true, folderStore: folder
    });
    const r = await ask(listener, { type: 'ybshot-test', tabId: 7 });
    assert.strictEqual(r.value.ok, true);
    assert.strictEqual(r.value.target, 'folder');
    assert.strictEqual(r.value.pending, true, 'ohne Ordner wird die Aufnahme vorgemerkt');
    assert.strictEqual(r.value.error, 'no-folder');
    assert.strictEqual(calls.downloads.length, 0, 'kein downloads.download als Ersatz');
    assert.deepStrictEqual(plain(calls.permissions[0]), { origins: ['<all_urls>'] },
      'Chrome fragt nur die Aufnahme-Hostberechtigung ab, nicht downloads');
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].meta.source, 'manual');
    const pendingShot = calls.storageSets.map(x => x.lastShot).filter(Boolean).pop();
    assert.strictEqual(pendingShot.status, 'pending');
    assert.strictEqual(pendingShot.pending, true);

    const flush = await ask(listener, { type: 'ybshot-folder-flush' });
    assert.strictEqual(flush.value.ok, true);
    assert.strictEqual(flush.value.saved, 1);
    const savedShot = calls.storageSets.map(x => x.lastShot).filter(Boolean).pop();
    assert.strictEqual(savedShot.status, 'saved');
    assert.strictEqual(savedShot.pending, false);
    assert.strictEqual(savedShot.file, 'YouTube Blocker/2026-10-21/neu.jpg');
  }

  /* --- Nur der tatsächlich geschriebene Warteeintrag wird „saved“ --- */
  {
    const folder = {
      storeSupported: () => true,
      saveOrQueue: async () => ({ ok: false, pending: true, reason: 'no-folder', id: 42 }),
      flushPending: async () => ({
        ok: true, saved: 1, failed: 0, savedIds: [7],
        lastSaved: 'YouTube Blocker/2026-10-21/aelter.jpg', pending: 1
      })
    };
    const { calls, listener } = makeSandbox({
      routes: {}, chromeMode: true, shotApis: true, folderStore: folder
    });
    await ask(listener, { type: 'ybshot-test', tabId: 7 });
    const pendingBefore = calls.storageSets.map(x => x.lastShot).filter(Boolean).pop();
    assert.strictEqual(pendingBefore.pendingId, 42);
    await ask(listener, { type: 'ybshot-folder-flush' });
    const stillPending = calls.storageSets.map(x => x.lastShot).filter(Boolean).pop();
    assert.strictEqual(stillPending.status, 'pending', 'fremder Warteeintrag darf den Status nicht überschreiben');
    assert.strictEqual(stillPending.pendingId, 42);
  }

  /* --- Popup schreibt selbst: ybshot-folder-note zieht nur den Status nach --- */
  {
    const folder = {
      storeSupported: () => true,
      saveOrQueue: async () => ({ ok: false, pending: true, reason: 'no-folder', id: 42 }),
      flushPending: async () => ({ ok: false, reason: 'permission', saved: 0, failed: 0, pending: 1 })
    };
    const { calls, listener } = makeSandbox({
      routes: {}, chromeMode: true, shotApis: true, folderStore: folder
    });
    await ask(listener, { type: 'ybshot-test', tabId: 7 });
    const before = calls.storageSets.map(x => x.lastShot).filter(Boolean).pop();
    assert.strictEqual(before.status, 'pending');
    assert.strictEqual(before.pendingId, 42);
    const r = await ask(listener, {
      type: 'ybshot-folder-note', saved: 1, savedIds: [42],
      lastSaved: 'YouTube Blocker/2026-10-21/frisch.jpg'
    });
    assert.strictEqual(r.value.ok, true, 'Statusmeldung des Popups wird bestätigt');
    const after = calls.storageSets.map(x => x.lastShot).filter(Boolean).pop();
    assert.strictEqual(after.status, 'saved');
    assert.strictEqual(after.pending, false);
    assert.strictEqual(after.pendingId, null);
    assert.strictEqual(after.file, 'YouTube Blocker/2026-10-21/frisch.jpg');
  }

  /* --- ybshot-folder-note ohne passende Kennung lässt den Status stehen --- */
  {
    const folder = {
      storeSupported: () => true,
      saveOrQueue: async () => ({ ok: false, pending: true, reason: 'no-folder', id: 42 }),
      flushPending: async () => ({ ok: true, saved: 0, failed: 0, pending: 1 })
    };
    const { calls, listener } = makeSandbox({
      routes: {}, chromeMode: true, shotApis: true, folderStore: folder
    });
    await ask(listener, { type: 'ybshot-test', tabId: 7 });
    const r = await ask(listener, {
      type: 'ybshot-folder-note', saved: 1, savedIds: [7],
      lastSaved: 'YouTube Blocker/2026-10-21/fremd.jpg'
    });
    assert.strictEqual(r.value.ok, true);
    const shot = calls.storageSets.map(x => x.lastShot).filter(Boolean).pop();
    assert.strictEqual(shot.status, 'pending', 'fremder Eintrag darf den Status nicht zu „saved“ machen');
    assert.strictEqual(shot.pendingId, 42);
  }

  /* --- Chrome ohne folder-store darf niemals auf downloads zurückfallen --- */
  {
    const { calls, listener } = makeSandbox({ routes: {}, chromeMode: true, shotApis: true });
    const r = await ask(listener, { type: 'ybshot-test', tabId: 7 });
    assert.strictEqual(r.value.ok, false);
    assert.strictEqual(r.value.error, 'folder-api');
    assert.strictEqual(calls.downloads.length, 0, 'kein stiller Download-Fallback in Chrome');
  }

  /* --- Automatische Aufnahme im privaten Fenster --- */
  {
    const { calls, listener } = makeSandbox({ routes: {}, chromeMode: false, shotApis: true });
    const sender = { tab: { id: 9, windowId: 1, active: false, cookieStoreId: 'firefox-private', incognito: true } };
    const r = await ask(listener, {
      type: 'ybshot', videoId: 'privabc1234', reason: 'title', visible: true, partial: true,
      rect: { x: 10, y: 20, w: 300, h: 170 }, scroll: { x: 0, y: 0 }, viewport: { w: 1280, h: 900 }
    }, 2000, sender);
    assert.strictEqual(r.value.ok, true);
    assert.strictEqual(r.value.incognito, true);
    assert.strictEqual(calls.downloads[0].incognito, true, 'privater Auto-Download');
    const shot = calls.storageSets.map(x => x.lastShot).filter(Boolean).pop();
    assert.ok(shot, 'lastShot für private Auto-Aufnahme gespeichert');
    assert.strictEqual(shot.source, 'auto');
    assert.strictEqual(shot.incognito, true);
    assert.strictEqual(shot.videoId, 'privabc1234');
    assert.strictEqual(shot.status, 'saved');
    assert.strictEqual(shot.partial, true, 'teilweise sichtbarer Ausschnitt wird markiert');
  }

  console.log('test-background-route: OK');
})().catch(e => { console.error(e); process.exit(1); });
