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

function makeSandbox({ routes, chromeMode }) {
  const calls = { offscreen: 0, sends: [], badge: [], storageSets: [] };
  const listeners = { message: null };
  let contexts = [];
  const api = {
    runtime: {
      onMessage: { addListener: fn => { listeners.message = fn; } },
      sendMessage: msg => { calls.sends.push(msg); return Promise.resolve({ ok: true, route: msg.route, from: 'offscreen' }); },
      getContexts: chromeMode ? (() => Promise.resolve(contexts)) : undefined
    },
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: obj => { calls.storageSets.push(obj); return Promise.resolve(); }
      },
      onChanged: { addListener: () => {} }
    },
    tabs: { onUpdated: { addListener: () => {} }, sendMessage: () => Promise.resolve() },
    browserAction: { setBadgeText: o => calls.badge.push(o) }
  };
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
  if (chromeMode) sandbox.chrome = api; else sandbox.browser = api;
  vm.runInNewContext(SRC, sandbox, { filename: 'background.js' });
  assert.strictEqual(typeof listeners.message, 'function', 'onMessage wurde registriert');
  return { calls, listener: listeners.message };
}

/* Ruft den Listener wie der Browser: sendResponse kommt synchron oder später
   (return true hält den Kanal offen). */
function ask(listener, msg, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    let answered = false;
    const timer = setTimeout(() => { if (!answered) reject(new Error('keine Antwort auf ' + msg.type)); }, timeoutMs);
    const ret = listener(msg, {}, value => { answered = true; clearTimeout(timer); resolve({ ret: true, value }); });
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

  console.log('test-background-route: OK');
})().catch(e => { console.error(e); process.exit(1); });
