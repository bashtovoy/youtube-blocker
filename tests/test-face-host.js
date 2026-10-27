/* test-face-host.js — MediaPipe-Host ohne Browser/Netz.
   Prüft den Lebenszyklus (laden, bereit, Leerlauf/Reset), Bildabruf mit
   hqdefault-Fallback, Cache/Deduplizierung, Skip bei fehlendem Bild und den
   fatalen Modellfehler. Die echten MediaPipe-Dateien werden nicht geladen;
   YB_FACE_VISION liefert einen deterministischen Ersatz. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'extension');
const SCORE_SRC = fs.readFileSync(path.join(ROOT, 'face-score.js'), 'utf8');
const HOST_SRC = fs.readFileSync(path.join(ROOT, 'face-host.js'), 'utf8');

const ID = 'quzTROdLmU4';
const SHOCK = {
  faceLandmarks: [[{ x: 0.2, y: 0.2 }, { x: 0.75, y: 0.8 }]],
  faceBlendshapes: [{
    categories: [
      { categoryName: 'jawOpen', score: 0.95 },
      { categoryName: 'browInnerUp', score: 0.95 },
      { categoryName: 'eyeWideLeft', score: 0.95 },
      { categoryName: 'eyeWideRight', score: 0.95 }
    ]
  }]
};

function response(status, bytes, type) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => (String(name).toLowerCase() === 'content-type' ? type || 'image/jpeg' : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
}

function makeHost(opts = {}) {
  const stats = {
    fetch: [], create: 0, detect: 0, close: 0, bitmaps: 0, bitmapClose: 0,
    concurrent: 0, maxConcurrent: 0
  };
  const sink = [];
  const state = { fetchImpl: null, detectResult: SHOCK, failCreate: false, createGate: null };
  const model = {
    detect() {
      stats.detect++;
      stats.concurrent++;
      stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.concurrent);
      try {
        if (opts.detectThrows) throw new Error('detect kaputt');
        return state.detectResult;
      } finally {
        stats.concurrent--;
      }
    },
    close() { stats.close++; }
  };
  const vision = {
    FilesetResolver: { forVisionTasks: async dir => ({ dir }) },
    FaceLandmarker: {
      createFromOptions: async (fileset, options) => {
        stats.create++;
        if (state.failCreate) throw new Error('Modell kaputt');
        if (state.createGate) await state.createGate;
        assert.ok(String(fileset.dir).includes('mediapipe'), 'FilesetResolver bekommt das lokale Wasm-Verzeichnis');
        assert.strictEqual(options.runningMode, 'IMAGE');
        assert.strictEqual(options.numFaces, 2);
        assert.strictEqual(options.baseOptions.delegate, 'CPU');
        assert.strictEqual(options.outputFaceBlendshapes, true);
        return model;
      }
    }
  };

  const sandbox = {
    console,
    setTimeout, clearTimeout, Promise, Date, Math, Uint8Array, Number, String,
    Blob: class { constructor(parts, o) { this.parts = parts; this.type = o && o.type; } },
    self: null,
    chrome: {
      runtime: { getURL: rel => 'test://extension/' + rel },
      storage: { local: { set: async () => {} } }
    },
    document: {
      createElement: () => ({ set src(v) {}, set onload(fn) {}, set onerror(fn) {} }),
      head: { appendChild: () => {} }
    },
    fetch: async url => {
      stats.fetch.push(String(url));
      if (state.fetchImpl) return state.fetchImpl(String(url));
      return response(200, new Uint8Array([1, 2, 3]), 'image/jpeg');
    },
    createImageBitmap: async () => {
      stats.bitmaps++;
      return { close() { stats.bitmapClose++; } };
    }
  };
  sandbox.self = sandbox;
  sandbox.YB_FACE_VISION = vision;
  sandbox.YB_STATUS_SINK = (key, payload) => sink.push({ key, payload: JSON.parse(JSON.stringify(payload)) });
  vm.createContext(sandbox);
  vm.runInContext(SCORE_SRC, sandbox, { filename: 'face-score.js' });
  vm.runInContext(HOST_SRC, sandbox, { filename: 'face-host.js' });
  return { host: sandbox.YB_FACE_HOST, stats, sink, state, sandbox };
}

(async () => {
  /* ---- 1) Score, Cache, Prepare, Reset ---- */
  {
    const { host, stats, sink } = makeHost();
    assert.ok(host, 'face-host.js muss YB_FACE_HOST exportieren');
    assert.strictEqual(host.status().state, 'off');
    const r = await host.score(ID);
    assert.ok(r.score > 0.85, 'Schock-Score: ' + r.score);
    assert.strictEqual(r.skipped, undefined);
    assert.strictEqual(r.cached, undefined);
    assert.strictEqual(stats.fetch.length, 1);
    assert.strictEqual(stats.fetch[0], 'https://i.ytimg.com/vi/' + ID + '/mqdefault.jpg');
    assert.strictEqual(stats.create, 1);
    assert.strictEqual(stats.detect, 1);
    assert.strictEqual(stats.bitmaps, 1);
    assert.strictEqual(stats.bitmapClose, 1, 'Bitmap wird nach dem Detect freigegeben');
    assert.strictEqual(host.status().state, 'ready');
    assert.strictEqual(host.status().cacheSize, 1);
    assert.ok(sink.some(s => s.payload.state === 'ready' && s.payload.model === 'face-landmarker'));

    const again = await host.score(ID);
    assert.strictEqual(again.cached, true);
    assert.strictEqual(stats.fetch.length, 1, 'Cache verhindert zweiten Bildabruf');
    assert.strictEqual(stats.detect, 1, 'Cache verhindert zweite Inferenz');

    const prepared = await host.prepare();
    assert.strictEqual(prepared.state, 'ready');
    assert.strictEqual(stats.create, 1, 'prepare nutzt das vorhandene Modell');

    host.reset();
    assert.strictEqual(host.status().state, 'off');
    assert.strictEqual(host.status().cacheSize, 0);
    assert.strictEqual(stats.close, 1, 'Reset schließt das Modell');
  }

  /* ---- 2) Deduplizierung und Serialisierung ---- */
  {
    const { host, stats } = makeHost();
    const [a, b] = await Promise.all([host.score(ID), host.score(ID)]);
    assert.ok(a.score > 0.8);
    assert.ok(b.score > 0.8);
    assert.strictEqual(stats.fetch.length, 1, 'gleiche videoId wird dedupliziert');
    assert.strictEqual(stats.create, 1);
    assert.strictEqual(stats.detect, 1);

    const other = 'aaaaaaaaaaa';
    const [c, d] = await Promise.all([host.score(other), host.score('bbbbbbbbbbb')]);
    assert.ok(c.score > 0.8 && d.score > 0.8);
    assert.strictEqual(stats.maxConcurrent, 1, 'Inferenzen laufen nacheinander');
    assert.strictEqual(stats.create, 1, 'Modell wird nur einmal erzeugt');
    assert.strictEqual(host.status().cacheSize, 3);
    host.reset();
  }

  /* ---- 3) hqdefault-Fallback und fehlendes Bild ---- */
  {
    const { host, stats, state } = makeHost();
    state.fetchImpl = async url => url.includes('/mqdefault.jpg')
      ? response(404, new Uint8Array([0]), 'text/plain')
      : response(200, new Uint8Array([4, 5, 6]), 'image/jpeg');
    const r = await host.score(ID);
    assert.ok(r.score > 0.8);
    assert.deepStrictEqual(stats.fetch, [
      'https://i.ytimg.com/vi/' + ID + '/mqdefault.jpg',
      'https://i.ytimg.com/vi/' + ID + '/hqdefault.jpg'
    ]);
    assert.strictEqual(stats.create, 1);

    const missing = makeHost();
    missing.state.fetchImpl = async () => response(404, new Uint8Array([0]), 'text/plain');
    const skip = await missing.host.score(ID);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(skip)),
      { score: 0, faces: 0, faceWidth: 0, signals: null, skipped: 'image', ms: 0 });
    assert.strictEqual(missing.stats.create, 0, 'ohne Bild wird das Modell nicht geladen');
    assert.strictEqual(missing.host.status().cacheSize, 0, 'Skip wird nicht gecacht');
    host.reset();
    missing.host.reset();
  }

  /* ---- 4) Ungültige ID und Modellfehler ---- */
  {
    const { host, stats } = makeHost();
    await assert.rejects(() => host.score('bad'), /Ungültige Video-ID/);
    assert.strictEqual(stats.fetch.length, 0);

    const broken = makeHost();
    broken.state.failCreate = true;
    await assert.rejects(() => broken.host.score(ID), err => err.fatal === true && /Modell kaputt/.test(err.message));
    assert.strictEqual(broken.host.status().state, 'error');
    assert.ok(/Modell kaputt/.test(broken.host.status().error));
    assert.strictEqual(broken.stats.bitmapClose, 1, 'Bitmap wird auch bei Modellfehler geschlossen');
    host.reset();
    broken.host.reset();
  }

  /* ---- 5) Detect-Fehler: Karte wird übersprungen, Host bleibt bedienbar ---- */
  {
    const { host, stats } = makeHost({ detectThrows: true });
    await assert.rejects(() => host.score(ID), /detect kaputt/);
    assert.strictEqual(host.status().state, 'ready', 'ein Bildfehler tötet das Modell nicht');
    assert.strictEqual(stats.bitmapClose, 1);
    host.reset();
  }

  /* ---- 6) Reset während des Modellladens bleibt die letzte Entscheidung ---- */
  {
    const { host, stats, state } = makeHost();
    let release;
    state.createGate = new Promise(resolve => { release = resolve; });
    const loading = host.score(ID);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.strictEqual(host.status().state, 'loading');
    host.reset();
    release();
    await assert.rejects(() => loading, /zurückgesetzt/);
    assert.strictEqual(host.status().state, 'off', 'Reset wird nicht durch einen späten Fehler überschrieben');
    assert.strictEqual(stats.close, 1, 'das nach dem Reset fertige Modell wird geschlossen');
  }

  /* ---- 7) host-routes.js: einheitliche Fehlerform und Operationen ---- */
  {
    const { host, sandbox } = makeHost();
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'host-routes.js'), 'utf8'), sandbox, { filename: 'host-routes.js' });
    assert.ok(sandbox.YB_ROUTES && typeof sandbox.YB_ROUTES.face === 'function');
    const st = await sandbox.YB_ROUTES.face({ op: 'status' });
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.status.state, 'off');
    const prep = await sandbox.YB_ROUTES.face({ op: 'prepare' });
    assert.strictEqual(prep.ok, true);
    assert.strictEqual(prep.status.state, 'ready');
    const scored = await sandbox.YB_ROUTES.face({ op: 'score', videoId: ID });
    assert.strictEqual(scored.ok, true);
    assert.ok(scored.result.score > 0.8);
    const bad = await sandbox.YB_ROUTES.face({ op: 'nope' });
    assert.strictEqual(bad.ok, false);
    assert.ok(/Unbekannte Face-Operation/.test(bad.error));
    host.reset();
  }

  /* ---- 8) MediaPipe-Telemetrie wird lokal beendet, bevor die CSP greift ---- */
  {
    const { stats, sandbox } = makeHost();
    const blocked = await sandbox.fetch('https://odml.pa.googleapis.com/v1/log', {
      method: 'POST',
      body: new Uint8Array([1, 2, 3])
    });
    assert.strictEqual(blocked.status, 204);
    assert.strictEqual(stats.fetch.length, 0, 'kein Netzversuch an odml');
    const thumb = await sandbox.fetch('https://i.ytimg.com/vi/' + ID + '/mqdefault.jpg');
    assert.strictEqual(thumb.status, 200);
    assert.strictEqual(stats.fetch.length, 1, 'andere URLs laufen weiter über fetch');
  }

  console.log('face-host tests: OK');
})().catch(e => { console.error(e); process.exit(1); });
