/* test-sem-gpu-fallback.js — Gerätewahl des Semantik-Hosts
   (extension/semantic-host.js). Ohne Browser, mit Fake-Worker und Fake-Storage.
   Chrome (Offscreen) setzt YB_FORCE_WASM und fragt WebGPU gar nicht erst an —
   dort schreibt Chrome jeden Versuch ohne Adapter als Warnung
   („Failed to create WebGPU Context Provider“) ins Erweiterungsprotokoll.
   Firefox behält die WebGPU-Probe mit versionsgebundenem Fallback: Beim ersten
   Lauf (GPU-Adapter fehlt) wird genau einmal WebGPU probiert, der Fehlschlag
   gemerkt und auf Wasm gewechselt; danach startet die Semantik direkt in Wasm —
   auch in einem frischen Host (Neustart), ohne erneute WebGPU-Anfrage. Der
   gemerkte Wert trägt die Erweiterungsversion („wasm@1.5.7“): Ein Update
   (andere Version) verwirft das Merkmal automatisch und WebGPU wird einmal neu
   probiert. Deckt beide Speicherwege ab: Chrome-Offscreen (über den Service
   Worker) und Firefox-Background (storage.local direkt). */
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const path = require('path');

/* Fake-Timer: armIdle plant zehn Minuten — im Test nie ausführen. */
let timerSeq = 1;
const timers = new Map();
function fakeSetTimeout(fn, ms) { const id = timerSeq++; timers.set(id, { fn, ms }); return id; }
function fakeClearTimeout(id) { timers.delete(id); }

const HOST_SRC = fs.readFileSync(path.join(__dirname, '../extension/semantic-host.js'), 'utf8');

/* Fake-Worker: „webgpu“ scheitert (wie bei fehlendem GPU-Adapter), „wasm“ lädt. */
function makeWorkerClass(initDevices, textOpts) {
  return class FakeWorker {
    constructor() { this.onmessage = null; this.onerror = null; }
    postMessage(m) {
      Promise.resolve().then(() => {
        if (m.type === 'init') {
          initDevices.push(m.device);
          if (m.device === 'webgpu') {
            this.onmessage({ data: { id: m.id, type: 'error', error: 'Failed to create WebGPU Context Provider', deviceFallback: 'wasm' } });
          } else {
            this.onmessage({ data: { id: m.id, type: 'ready', device: m.device } });
          }
        } else if (m.type === 'set-texts') {
          if (textOpts) textOpts.push({ noWebgpu: !!m.noWebgpu });
          this.onmessage({ data: { id: m.id, type: 'texts-ready', embeds: [0.5, 0.5], dim: 2, labels: m.texts } });
        } else if (m.type === 'set-text-embeds') {
          this.onmessage({ data: { id: m.id, type: 'texts-ready', embeds: m.embeds, dim: m.dim, labels: m.labels } });
        } else if (m.type === 'score-image') {
          this.onmessage({ data: { id: m.id, type: 'image-scores', scores: [] } });
        }
      });
    }
    terminate() {}
  };
}

/* Baut einen Host im vm-Kontext. mode 'chrome' = Offscreen (kein storage,
   Meldungen über runtime.sendMessage an den Service Worker), mode 'firefox' =
   Background-Seite mit storage.local. opts.noManifest: runtime.getManifest
   fehlt (Chrome-Offscreen) — die Version kommt dann per fetch aus
   manifest.json. */
function makeHost(store, mode, opts) {
  const initDevices = [];
  const textOpts = [];
  const swCalls = { get: 0, set: [] };
  const sink = [];
  const sandbox = {
    console,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    Worker: makeWorkerClass(initDevices, textOpts),
    navigator: { gpu: {} }
  };
  const runtime = {
    getURL: p => 'moz-extension://test/' + p,
    sendMessage: msg => {
      if (!msg || msg.target !== 'sw') return Promise.resolve(null);
      if (msg.op === 'yb-sw-storage-get') { swCalls.get++; return Promise.resolve({ value: store[msg.key] }); }
      if (msg.op === 'yb-sw-storage-set') { store[msg.key] = msg.payload; swCalls.set.push([msg.key, msg.payload]); return Promise.resolve({ ok: true }); }
      return Promise.resolve(null);
    }
  };
  if (!(opts && opts.noManifest)) runtime.getManifest = () => ({ version: '1.5.7' });
  if (opts && opts.noManifest) {
    sandbox.fetch = () => Promise.resolve({ json: () => Promise.resolve({ version: '1.5.7' }) });
  }
  const storageLocal = {
    get: k => Promise.resolve({ [k]: store[k] }),
    set: obj => { Object.assign(store, obj); return Promise.resolve(); },
    remove: k => { delete store[k]; return Promise.resolve(); }
  };
  if (mode === 'chrome') {
    sandbox.chrome = { runtime, storage: { local: storageLocal } };
    sandbox.YB_STATUS_SINK = (k, p) => sink.push([k, p]);
    /* Offscreen.js setzt das vor semantic-host.js. */
    sandbox.YB_FORCE_WASM = true;
  } else {
    sandbox.browser = { runtime, storage: { local: storageLocal } };
  }
  sandbox.self = sandbox;
  vm.runInNewContext(HOST_SRC, sandbox);
  assert.ok(sandbox.YB_SEM_HOST && typeof sandbox.YB_SEM_HOST.ensure === 'function', 'YB_SEM_HOST muss exportiert sein');
  return { host: sandbox.YB_SEM_HOST, initDevices, textOpts, swCalls, sink };
}

(async () => {
  /* 1) Chrome/Offscreen, kalter Zustand: YB_FORCE_WASM verhindert die
     WebGPU-Anfrage vollständig, kein Fehlschlag wird gemerkt. */
  const store1 = {};
  const a = makeHost(store1, 'chrome');
  await a.host.ensure(['drone', 'nvidia'], 'k1');
  assert.deepStrictEqual(a.initDevices, ['wasm'], 'Chrome fragt WebGPU gar nicht erst an');
  assert.strictEqual(store1.semGpuFallback, undefined, 'kein Fallback-Merkmal nötig');
  assert.strictEqual(a.swCalls.set.length, 0, 'kein Merkmal über den SW geschrieben');
  assert.strictEqual(a.host.status().device, 'wasm', 'Gerät ist Wasm');
  assert.ok(a.textOpts.length >= 1 && a.textOpts.every(o => o.noWebgpu), 'auch der Text-Turm bleibt in Wasm');
  const ready = a.sink.filter(s => s[1] && s[1].state === 'ready').pop();
  assert.ok(ready && ready[1].device === 'wasm', 'Status zeigt Wasm');

  /* 2) Chrome-Neustart: bleibt bei Wasm, auch wenn ein altes Merkmal im
     Speicher liegt — es wird nicht mehr ausgewertet. */
  const b = makeHost({ semGpuFallback: 'wasm@1.5.7' }, 'chrome');
  await b.host.ensure(['drone', 'nvidia'], 'k1');
  assert.deepStrictEqual(b.initDevices, ['wasm'], 'keine WebGPU-Anfrage nach Neustart');
  assert.ok(b.textOpts.every(o => o.noWebgpu), 'Text-Turm startet ohne WebGPU');
  assert.strictEqual(b.host.status().device, 'wasm');

  /* 3) Firefox-Background (storage.local direkt), Merkmal gesetzt: sofort Wasm. */
  const c = makeHost({ semGpuFallback: 'wasm@1.5.7' }, 'firefox');
  await c.host.ensure(['drone'], 'k2');
  assert.deepStrictEqual(c.initDevices, ['wasm'], 'Firefox nutzt das Merkmal');
  assert.ok(c.textOpts.every(o => o.noWebgpu), 'Text-Turm ohne WebGPU (Firefox)');

  /* 4) Firefox, kalt: Probe einmal, danach Merkmal in storage.local. */
  const store4 = {};
  const d = makeHost(store4, 'firefox');
  await d.host.ensure(['drone'], 'k3');
  assert.deepStrictEqual(d.initDevices, ['webgpu', 'wasm']);
  assert.strictEqual(store4.semGpuFallback, 'wasm@1.5.7', 'Firefox merkt den Fehlschlag in storage.local');

  /* 4b) Firefox-Update (andere Version): Das alte Merkmal zählt nicht mehr,
     WebGPU wird genau einmal neu probiert und mit der neuen Version gemerkt. */
  const e = makeHost({ semGpuFallback: 'wasm@1.5.6' }, 'firefox');
  await e.host.ensure(['drone'], 'k3b');
  assert.deepStrictEqual(e.initDevices, ['webgpu', 'wasm'], 'veraltetes Merkmal → neue WebGPU-Probe');
  assert.strictEqual(e.host.status().device, 'wasm');

  /* 5) Kein navigator.gpu (z. B. Firefox ohne WebGPU): keine Probe, direkt Wasm,
     kein Merkmal nötig. */
  const devices5 = [];
  const sandbox6 = { console, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout };
  sandbox6.navigator = {};
  sandbox6.chrome = {
    runtime: { getURL: p => 'moz-extension://test/' + p, getManifest: () => ({ version: '1.5.7' }), sendMessage: () => Promise.resolve({ value: undefined }) },
    storage: { local: { get: k => Promise.resolve({ [k]: undefined }), set: () => Promise.resolve(), remove: () => Promise.resolve() } }
  };
  sandbox6.YB_STATUS_SINK = () => {};
  sandbox6.Worker = makeWorkerClass(devices5);
  sandbox6.self = sandbox6;
  vm.runInNewContext(HOST_SRC, sandbox6);
  await sandbox6.YB_SEM_HOST.ensure(['drone'], 'k4');
  assert.deepStrictEqual(devices5, ['wasm'], 'ohne navigator.gpu nur Wasm');
  assert.strictEqual(sandbox6.YB_SEM_HOST.status().device, 'wasm', 'ohne navigator.gpu direkt Wasm');

  /* 6) Chrome/Offscreen OHNE runtime.getManifest (dort nicht verfügbar):
     bleibt bei Wasm, unabhängig von einem alten Merkmal. */
  const f = makeHost({ semGpuFallback: 'wasm@1.5.7' }, 'chrome', { noManifest: true });
  await f.host.ensure(['drone'], 'k5');
  assert.deepStrictEqual(f.initDevices, ['wasm'], 'kein WebGPU trotz Version aus manifest.json');

  /* 7) Kaltstart ohne getManifest: kein Merkmal wird geschrieben. */
  const store7 = {};
  const g = makeHost(store7, 'chrome', { noManifest: true });
  await g.host.ensure(['drone'], 'k6');
  assert.deepStrictEqual(g.initDevices, ['wasm']);
  assert.strictEqual(store7.semGpuFallback, undefined, 'Chrome schreibt kein Merkmal');

  process.stdout.write('sem gpu fallback tests: OK\n');
})().catch(e => { console.error(e); process.exit(1); });
