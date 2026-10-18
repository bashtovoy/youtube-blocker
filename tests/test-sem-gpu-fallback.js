/* test-sem-gpu-fallback.js — WebGPU-Fallback-Merkmal des Semantik-Hosts
   (extension/semantic-host.js). Ohne Browser, mit Fake-Worker und Fake-Storage:
   Beim ersten Lauf (GPU-Adapter fehlt) wird genau einmal WebGPU probiert, der
   Fehlschlag gemerkt und auf Wasm gewechselt; danach startet die Semantik direkt
   in Wasm — auch in einem frischen Host (Neustart), ohne erneute WebGPU-Anfrage.
   Der gemerkte Wert trägt die Erweiterungsversion („wasm@1.5.7“): Ein Update
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
  } else {
    sandbox.browser = { runtime, storage: { local: storageLocal } };
  }
  sandbox.self = sandbox;
  vm.runInNewContext(HOST_SRC, sandbox);
  assert.ok(sandbox.YB_SEM_HOST && typeof sandbox.YB_SEM_HOST.ensure === 'function', 'YB_SEM_HOST muss exportiert sein');
  return { host: sandbox.YB_SEM_HOST, initDevices, textOpts, swCalls, sink };
}

(async () => {
  /* 1) Chrome/Offscreen, kalter Zustand: genau eine WebGPU-Probe, dann Wasm,
     Fehlschlag wird über den Service Worker gemerkt. */
  const store1 = {};
  const a = makeHost(store1, 'chrome');
  await a.host.ensure(['drone', 'nvidia'], 'k1');
  assert.deepStrictEqual(a.initDevices, ['webgpu', 'wasm'], 'erst WebGPU-Probe, dann Wasm');
  assert.strictEqual(store1.semGpuFallback, 'wasm@1.5.7', 'Fehlschlag gemerkt (storage, mit Version)');
  assert.ok(a.swCalls.set.some(c => c[0] === 'semGpuFallback' && c[1] === 'wasm@1.5.7'), 'Merkmal über den SW geschrieben');
  assert.strictEqual(a.host.status().device, 'wasm', 'Gerät ist Wasm');
  const ready = a.sink.filter(s => s[1] && s[1].state === 'ready').pop();
  assert.ok(ready && ready[1].device === 'wasm', 'Status zeigt Wasm');

  /* 2) Neustart (frischer Host, gemerktes Merkmal): sofort Wasm, keine
     WebGPU-Anfrage mehr — auch der parallele Text-Turm bleibt in Wasm. */
  const b = makeHost(store1, 'chrome');
  await b.host.ensure(['drone', 'nvidia'], 'k1');
  assert.deepStrictEqual(b.initDevices, ['wasm'], 'keine erneute WebGPU-Anfrage');
  assert.ok(b.swCalls.get > 0, 'Merkmal wurde aus dem Speicher gelesen');
  assert.ok(b.textOpts.length >= 1 && b.textOpts.every(o => o.noWebgpu), 'Text-Turm startet ohne WebGPU');
  assert.strictEqual(b.host.status().device, 'wasm');

  /* 3) Firefox-Background (storage.local direkt), Merkmal gesetzt: sofort Wasm. */
  const c = makeHost({ semGpuFallback: 'wasm@1.5.7' }, 'firefox');
  await c.host.ensure(['drone'], 'k2');
  assert.deepStrictEqual(c.initDevices, ['wasm'], 'Firefox nutzt das Merkmal ebenfalls');
  assert.ok(c.textOpts.every(o => o.noWebgpu), 'Text-Turm ohne WebGPU (Firefox)');

  /* 4) Firefox, kalt: Probe einmal, danach Merkmal in storage.local. */
  const store4 = {};
  const d = makeHost(store4, 'firefox');
  await d.host.ensure(['drone'], 'k3');
  assert.deepStrictEqual(d.initDevices, ['webgpu', 'wasm']);
  assert.strictEqual(store4.semGpuFallback, 'wasm@1.5.7', 'Firefox merkt den Fehlschlag in storage.local');

  /* 4b) Update (andere Version): Das alte Merkmal zählt nicht mehr, WebGPU wird
     genau einmal neu probiert und mit der neuen Version gemerkt. */
  const e = makeHost({ semGpuFallback: 'wasm@1.5.6' }, 'chrome');
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

  /* 6) Chrome/Offscreen OHNE runtime.getManifest (dort nicht verfügbar): Die
     Version kommt aus dem manifest.json der Erweiterung — das Merkmal gilt
     damit weiterhin, kein erneuter WebGPU-Versuch. */
  const f = makeHost({ semGpuFallback: 'wasm@1.5.7' }, 'chrome', { noManifest: true });
  await f.host.ensure(['drone'], 'k5');
  assert.deepStrictEqual(f.initDevices, ['wasm'], 'Version aus manifest.json → Merkmal gültig');

  /* 7) Kaltstart ohne getManifest: Merkmal wird mit der Version aus
     manifest.json geschrieben. */
  const store7 = {};
  const g = makeHost(store7, 'chrome', { noManifest: true });
  await g.host.ensure(['drone'], 'k6');
  assert.deepStrictEqual(g.initDevices, ['webgpu', 'wasm']);
  assert.strictEqual(store7.semGpuFallback, 'wasm@1.5.7', 'Version aus manifest.json im Merkmal');

  process.stdout.write('sem gpu fallback tests: OK\n');
})().catch(e => { console.error(e); process.exit(1); });
