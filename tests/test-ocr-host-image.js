/* test-ocr-host-image.js — Bildbeschaffung, Sprachrouting und Lifecycle des
   PaddleOCR-Hosts (extension/ocr-host.js). Ohne Browser, über vm mit Fakes:
   AVIF/JPEG/WebP werden als ImageBitmap an Paddle übergeben; 404/HTML und
   kaputte Bilder werden still übersprungen; Modell- und ORT-Pfade bleiben
   lokal; „eng+rus“ wählt anhand des Titel-/Kanalhinweises en oder eslav. */
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const path = require('path');

/* Fake-Timer: armIdle plant zehn Minuten — im Test nie ausführen. */
let timerSeq = 1;
const timers = new Map();
function fakeSetTimeout(fn, ms) { const id = timerSeq++; timers.set(id, { fn, ms }); return id; }
function fakeClearTimeout(id) { timers.delete(id); }

class FakeBlob {
  constructor(parts, opts) { this.parts = parts || []; this.type = (opts && opts.type) || ''; }
  async arrayBuffer() {
    const p = this.parts[0];
    if (p instanceof ArrayBuffer) return p;
    if (p && p.buffer) return p.buffer.slice(p.byteOffset || 0, (p.byteOffset || 0) + p.byteLength);
    return p;
  }
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 9, 8, 7, 6]);
const AVIF_BYTES = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
const JPEG_BYTES = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4, 5, 6, 7, 8]);
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

let nextResponse = null;
const fetchCalls = [];
function okResponse(type, bytes, status) {
  return {
    ok: status === undefined ? true : status < 400,
    status: status || 200,
    headers: { get: name => (String(name).toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
}
function fakeFetch(url, opts) {
  fetchCalls.push({ url, opts });
  return Promise.resolve(nextResponse(url));
}

let bitmapFails = false;
const bitmapBlobs = [];
async function fakeCreateImageBitmap(blob) {
  bitmapBlobs.push(blob);
  if (bitmapFails) throw new Error('Bild nicht dekodierbar');
  return { width: 480, height: 270, closed: false, close() { this.closed = true; } };
}

const scripts = [];
const sandbox = {
  browser: { runtime: { getURL: p => 'moz-extension://test/' + p } },
  document: {
    createElement(tag) {
      if (tag === 'script') return { src: '', onload: null, onerror: null };
      return {};
    },
    head: {
      appendChild(node) {
        scripts.push(node.src);
        /* Das echte Bundle setzt globalThis.PaddleOCR beim Ausführen. */
        sandbox.PaddleOCR = Paddle;
        if (typeof node.onload === 'function') node.onload();
      }
    },
    documentElement: { appendChild() {} }
  },
  fetch: fakeFetch,
  createImageBitmap: fakeCreateImageBitmap,
  Blob: FakeBlob,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  console
};

/* PaddleOCR-Fake: zeichnet die Erstellungsoptionen und die Pipeline auf, die
   tatsächlich erkennt. Jede erzeugte Instanz bekommt einen eigenen Namen. */
const createCalls = [];
const predictions = [];
const disposed = [];
let recognizeResult = {
  items: [
    { text: 'RÖCONIZED THUMBNAIL TEXT', score: 0.97 },
    { text: '', score: 0.1 },
    { text: 'SECOND LINE', score: 0.93 }
  ]
};
let predictError = null;
const Paddle = {
  async create(options) {
    createCalls.push(options);
    const name = options.textRecognitionModelName;
    return {
      async predict(image) {
        predictions.push({ name, image });
        if (predictError) throw predictError;
        return [recognizeResult];
      },
      async dispose() { disposed.push(name); }
    };
  }
};
sandbox.self = sandbox;
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '../extension/ocr-host.js'), 'utf8'),
  sandbox
);
const host = sandbox.YB_OCR_HOST;
assert.ok(host && typeof host.recognize === 'function', 'YB_OCR_HOST muss exportiert sein');

const plain = o => JSON.parse(JSON.stringify(o));
const tick = () => new Promise(r => setImmediate(r));

(async () => {
  let st = host.status();
  assert.strictEqual(st.state, 'off', 'vor dem ersten Lauf ist der Host aus');
  assert.deepStrictEqual(plain(st.langs), []);
  assert.strictEqual(st.error, null);

  /* 1) Vorwärmen: „eng+rus“ initialisiert beide Pipelines wirklich. */
  st = await host.prepare('eng+rus');
  assert.strictEqual(st.state, 'ready', 'nach prepare ist der Host bereit');
  assert.strictEqual(st.loading, false);
  assert.strictEqual(st.error, null);
  assert.deepStrictEqual(plain(st.langs), ['eng', 'rus'], 'beide Modelle sind geladen');
  assert.strictEqual(scripts.length, 1, 'das SDK-Bundle wird genau einmal geladen');
  assert.ok(scripts[0].endsWith('/lib/paddle.bundle.js'), 'SDK kommt aus lib/');
  assert.strictEqual(createCalls.length, 2, 'en und eslav werden getrennt erstellt');
  assert.deepStrictEqual(createCalls.map(c => c.textRecognitionModelName), [
    'en_PP-OCRv5_mobile_rec',
    'eslav_PP-OCRv5_mobile_rec'
  ]);
  for (const c of createCalls) {
    assert.strictEqual(c.textDetectionModelName, 'PP-OCRv5_mobile_det');
    assert.ok(c.textDetectionModelAsset.url.startsWith('moz-extension://test/lib/'),
      'Detektor bleibt lokal');
    assert.ok(c.textDetectionModelAsset.url.endsWith('/ppocrv5_mobile_det.tar'));
    assert.ok(c.textRecognitionModelAsset.url.startsWith('moz-extension://test/lib/'),
      'Erkenner bleibt lokal');
    assert.strictEqual(c.ortOptions.backend, 'wasm', 'keine WebGPU-Anfrage');
    assert.strictEqual(c.ortOptions.wasmPaths, 'moz-extension://test/lib/', 'ORT-WASM bleibt lokal');
    assert.strictEqual(c.ortOptions.numThreads, 1);
  }
  assert.ok(createCalls[0].textRecognitionModelAsset.url.endsWith('/en_ppocrv5_mobile_rec.tar'));
  assert.ok(createCalls[1].textRecognitionModelAsset.url.endsWith('/eslav_ppocrv5_mobile_rec.tar'));

  /* 2) AVIF (echte ytimg-Lieferung): der Browser dekodiert, Paddle bekommt
     ein ImageBitmap; es gibt keinen weißen Rand und keinen Maskenlauf. */
  nextResponse = () => okResponse('image/avif', AVIF_BYTES);
  let out = await host.recognize('https://i.ytimg.com/vi/x/hq720.jpg?sqp=1&rs=2', 'eng+rus');
  assert.strictEqual(out.text, 'RÖCONIZED THUMBNAIL TEXT\nSECOND LINE', 'Zeilen werden verbunden');
  assert.ok(Number.isFinite(out.ms), 'Laufzeit wird gemeldet');
  assert.strictEqual(predictions.length, 1, 'genau eine Paddle-Erkennung');
  assert.strictEqual(predictions[0].name, 'en_PP-OCRv5_mobile_rec', 'lateinischer Hinweis → en');
  assert.strictEqual(predictions[0].image.width, 480, 'ImageBitmap wird direkt übergeben');
  assert.strictEqual(predictions[0].image.closed, true, 'ImageBitmap wird geschlossen');
  assert.ok(bitmapBlobs.some(b => b.type === 'image/avif'), 'Browser dekodiert AVIF');

  /* 3) JPEG und WebP laufen ohne zusätzliche Konvertierung durch. */
  nextResponse = () => okResponse('image/jpeg', JPEG_BYTES);
  out = await host.recognize('https://i.ytimg.com/vi/y/hqdefault.jpg', 'eng+rus');
  assert.strictEqual(out.text, 'RÖCONIZED THUMBNAIL TEXT\nSECOND LINE');
  nextResponse = () => okResponse('image/webp', WEBP_BYTES);
  out = await host.recognize('https://i.ytimg.com/vi_webp/z/hqdefault.webp', 'eng+rus');
  assert.strictEqual(out.text, 'RÖCONIZED THUMBNAIL TEXT\nSECOND LINE');

  /* 4) 404: stiller Skip, kein Modellaufruf, kein negativer Cache. */
  const predictBefore404 = predictions.length;
  nextResponse = () => okResponse('text/html', new Uint8Array([60, 104, 116, 109, 108, 62]), 404);
  out = await host.recognize('https://i.ytimg.com/vi/gone/hq720.jpg', 'eng+rus');
  assert.deepStrictEqual(plain(out), { text: '', skipped: true }, '404 → leerer Text statt Fehler');
  assert.strictEqual(predictions.length, predictBefore404, 'Paddle wurde nicht belastet');
  nextResponse = () => okResponse('image/jpeg', JPEG_BYTES);
  out = await host.recognize('https://i.ytimg.com/vi/gone/hq720.jpg', 'eng+rus');
  assert.strictEqual(out.text, 'RÖCONIZED THUMBNAIL TEXT\nSECOND LINE', 'derselbe URL wird erneut versucht');

  /* 5) HTML unter 200: ebenfalls Skip. */
  nextResponse = () => okResponse('text/html; charset=utf-8', new Uint8Array([60, 33, 68, 79, 67, 84, 89, 80, 69, 62]));
  out = await host.recognize('https://i.ytimg.com/vi/html/hq720.jpg', 'eng+rus');
  assert.deepStrictEqual(plain(out), { text: '', skipped: true }, 'HTML-Antwort → Skip');

  /* 6) Nicht dekodierbares Bild: Skip ohne Ausnahme. */
  bitmapFails = true;
  nextResponse = () => okResponse('image/avif', AVIF_BYTES);
  out = await host.recognize('https://i.ytimg.com/vi/broken/hq720.jpg', 'eng+rus');
  assert.deepStrictEqual(plain(out), { text: '', skipped: true }, 'kaputtes Bild → Skip statt Fehler');
  bitmapFails = false;

  /* 7) Cache: ein bereits erkannter URL+Sprache-Hinweis-Treffer geht nicht
     erneut raus. */
  const fetchesBefore = fetchCalls.length;
  const predictsBeforeCache = predictions.length;
  out = await host.recognize('https://i.ytimg.com/vi/y/hqdefault.jpg', 'eng+rus');
  assert.strictEqual(out.cached, true, 'Cache-Treffer');
  assert.strictEqual(fetchCalls.length, fetchesBefore, 'kein erneuter Bildabruf');
  assert.strictEqual(predictions.length, predictsBeforeCache, 'keine erneute Erkennung');

  /* 8) Abruf-Fehler (Netz weg): Skip statt Ausnahme. */
  nextResponse = () => { throw new Error('netz weg'); };
  out = await host.recognize('https://i.ytimg.com/vi/offline/hq720.jpg', 'eng+rus');
  assert.deepStrictEqual(plain(out), { text: '', skipped: true }, 'Netzfehler → Skip');

  /* 9) Leere Zeilen werden verworfen; die Reihenfolge bleibt erhalten. */
  recognizeResult = { items: [{ text: '  A  ' }, { text: '' }, { text: 'B' }] };
  nextResponse = () => okResponse('image/jpeg', JPEG_BYTES);
  out = await host.recognize('https://i.ytimg.com/vi/lines/hq720.jpg', 'eng');
  assert.strictEqual(out.text, 'A\nB');

  /* 10) Sprachwahl:
     - „rus“ → eslav,
     - „eng+rus“ mit kyrillischem Hinweis → eslav,
     - „eng+rus“ mit lateinischem Hinweis → en. */
  recognizeResult = { items: [{ text: 'ПРИВЕТ МИР' }] };
  const predictionsBeforeRu = predictions.length;
  nextResponse = () => okResponse('image/jpeg', JPEG_BYTES);
  out = await host.recognize('https://i.ytimg.com/vi/ru/hq720.jpg', 'eng+rus', 'Привет, это русский заголовок');
  assert.strictEqual(out.text, 'ПРИВЕТ МИР');
  assert.strictEqual(predictions.length, predictionsBeforeRu + 1);
  assert.strictEqual(predictions[predictions.length - 1].name, 'eslav_PP-OCRv5_mobile_rec');
  assert.deepStrictEqual(plain(host.status().langs), ['eng', 'rus'], 'beide Pipelines bleiben geladen');
  assert.strictEqual(createCalls.length, 2, 'kein erneutes Erstellen nach prepare');

  const predictionsBeforeEn = predictions.length;
  nextResponse = () => okResponse('image/jpeg', JPEG_BYTES);
  out = await host.recognize('https://i.ytimg.com/vi/en/hq720.jpg', 'eng+rus', 'Cloud Codes');
  assert.strictEqual(predictions[predictions.length - 1].name, 'en_PP-OCRv5_mobile_rec');
  assert.strictEqual(predictions.length, predictionsBeforeEn + 1);

  const predictionsBeforeRusOnly = predictions.length;
  nextResponse = () => okResponse('image/jpeg', JPEG_BYTES);
  await host.recognize('https://i.ytimg.com/vi/ru-only/hq720.jpg', 'rus');
  assert.strictEqual(predictions[predictions.length - 1].name, 'eslav_PP-OCRv5_mobile_rec');
  assert.strictEqual(predictions.length, predictionsBeforeRusOnly + 1);

  const predictionsBeforeEngOnly = predictions.length;
  nextResponse = () => okResponse('image/jpeg', JPEG_BYTES);
  await host.recognize('https://i.ytimg.com/vi/en-only/hq720.jpg', 'eng');
  assert.strictEqual(predictions[predictions.length - 1].name, 'en_PP-OCRv5_mobile_rec');
  assert.strictEqual(predictions.length, predictionsBeforeEngOnly + 1);

  /* 11) Zwei Erkennungsfehler in Folge verwerfen die Pipelines; der nächste
     Aufruf initialisiert sie neu. */
  const disposedBeforeErrors = disposed.length;
  predictError = new Error('Paddle-Lauf fehlgeschlagen');
  nextResponse = () => okResponse('image/jpeg', JPEG_BYTES);
  await assert.rejects(host.recognize('https://i.ytimg.com/vi/e1/hq720.jpg', 'eng'), /Paddle-Lauf fehlgeschlagen/);
  await assert.rejects(host.recognize('https://i.ytimg.com/vi/e2/hq720.jpg', 'eng'), /Paddle-Lauf fehlgeschlagen/);
  assert.ok(disposed.length > disposedBeforeErrors, 'nach zwei Fehlern werden die Pipelines verworfen');
  assert.strictEqual(host.status().state, 'off', 'nach dem Verwerfen ist der Host aus');
  predictError = null;
  recognizeResult = { items: [{ text: 'WIEDER DA' }] };
  nextResponse = () => okResponse('image/jpeg', JPEG_BYTES);
  out = await host.recognize('https://i.ytimg.com/vi/e3/hq720.jpg', 'eng');
  assert.strictEqual(out.text, 'WIEDER DA', 'nächster Aufruf initialisiert neu');
  assert.strictEqual(host.status().state, 'ready');

  /* 12) reset beendet die Pipelines; der Status ist danach aus. */
  const disposedBeforeReset = disposed.length;
  await host.prepare('eng+rus');
  host.reset();
  assert.strictEqual(host.status().state, 'off');
  assert.ok(disposed.length > disposedBeforeReset, 'reset ruft dispose() auf');

  process.stdout.write('ocr-host image tests: OK\n');
})().catch(e => { console.error(e); process.exit(1); });
