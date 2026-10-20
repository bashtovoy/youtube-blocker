/* test-ocr-host-image.js — Bildbeschaffung und mehrstufige Erkennung des
   OCR-Hosts (extension/ocr-host.js). Ohne Browser, über vm mit Fakes:
   AVIF-Bytes (ytimg liefert hq720-URLs so) werden über den Browser zu PNG
   gewandelt; JPEG/PNG/WebP laufen unverändert durch; 404/HTML und kaputte
   Bilder werden still übersprungen (kein Fehler, kein Cache). Zusätzlich:
   PSM 11, Sprachwahl nach Titel/Kanal und der tiefe Lauf mit Masken. */
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

/* fetch-Fake: liefert die nächste geplante Antwort. */
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

/* createImageBitmap/Canvas-Fakes: merken sich, was konvertiert wurde. */
let bitmapFails = false;
let lastBitmapBlob = null;
async function fakeCreateImageBitmap(blob) {
  lastBitmapBlob = blob;
  if (bitmapFails) throw new Error('Bild nicht dekodierbar');
  return { width: 4, height: 2, closed: false, close() { this.closed = true; } };
}
const canvasCalls = [];
function makePixels(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    const band = ((i / 4) % 4);
    /* Dunkelrot mit weicher Kante: die frühere strenge Rot-Schwelle hat
       genau solche Pixel verworfen; die lockere Maske muss sie behalten. */
    const rgb = band === 0 ? [100, 70, 70] : band === 1 ? [240, 240, 240] : band === 2 ? [10, 10, 10] : [128, 128, 128];
    data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}
function makeCanvas() {
  const canvas = {
    width: 0, height: 0,
    getContext(kind) {
      canvasCalls.push(kind);
      return {
        drawImage() {},
        getImageData(x, y, w, h) { return makePixels(w, h); },
        createImageData(w, h) { return makePixels(w, h); },
        putImageData(image) { canvas.lastImage = image; }
      };
    },
    toBlob(cb, type) { canvasCalls.push('toBlob:' + type); cb(new FakeBlob([PNG_BYTES], { type })); }
  };
  return canvas;
}
const document = {
  createElement(tag) {
    if (tag === 'script') return { src: '', onload: null, onerror: null };
    if (tag === 'canvas') return makeCanvas();
    return {};
  },
  head: { appendChild(node) { if (node && typeof node.onload === 'function') node.onload(); } },
  documentElement: { appendChild() {} }
};

/* Tesseract-Fake: zeichnet auf, welche Bytes/Canvases der „Kern“ bekommt. */
const recognized = [];
const loadedLangs = [];
const initializedLangs = [];
const paramCalls = [];
let terminated = 0;
let recognizeResult = { data: { text: 'RECOGNIZED THUMBNAIL TEXT', confidence: 91 } };
const fakeWorker = {
  async loadLanguage(lang) { loadedLangs.push(lang); },
  async initialize(lang) { initializedLangs.push(lang); },
  async setParameters(params) { paramCalls.push(params); },
  recognize(image) { recognized.push(image); return Promise.resolve(recognizeResult); },
  terminate() { terminated++; }
};
let createWorkerOpts = null;
let created = 0;
const Tesseract = { createWorker: async opts => { createWorkerOpts = opts; created++; return fakeWorker; } };

const sandbox = {
  browser: { runtime: { getURL: p => 'moz-extension://test/' + p } },
  document,
  fetch: fakeFetch,
  createImageBitmap: fakeCreateImageBitmap,
  Blob: FakeBlob,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  console,
  Tesseract
};
sandbox.self = sandbox;
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '../extension/ocr-host.js'), 'utf8'),
  sandbox
);
const host = sandbox.YB_OCR_HOST;
assert.ok(host && typeof host.recognize === 'function', 'YB_OCR_HOST muss exportiert sein');

const arr = u8 => Array.from(u8);
/* Objekte aus dem vm-Kontext haben fremde Prototypen → für Vergleiche
   in einfache Objekte des Testkontexts wandeln. */
const plain = o => JSON.parse(JSON.stringify(o));

(async () => {
  let st = host.status();
  assert.strictEqual(st.state, 'off', 'vor dem ersten Lauf ist der Host aus');
  assert.deepStrictEqual(plain(st.langs), []);

  /* 1) AVIF (echte ytimg-Lieferung): wird über Canvas zu PNG gewandelt. */
  nextResponse = () => okResponse('image/avif', AVIF_BYTES);
  let out = await host.recognize('https://i.ytimg.com/vi/x/hq720.jpg?sqp=1&rs=2', 'eng+rus');
  assert.strictEqual(out.text, 'RECOGNIZED THUMBNAIL TEXT', 'Text kommt durch');
  assert.ok(Number.isFinite(out.ms), 'Laufzeit wird gemeldet');
  assert.strictEqual(recognized.length, 1, 'der Kern bekam genau ein Bild');
  assert.deepStrictEqual(arr(recognized[0]), arr(PNG_BYTES), 'AVIF → PNG-Bytes für Tesseract');
  assert.strictEqual(lastBitmapBlob.type, 'image/avif', 'Browser dekodiert die Original-Bytes');
  assert.ok(canvasCalls.includes('2d') && canvasCalls.includes('toBlob:image/png'), 'Canvas-Weg wurde benutzt');
  assert.ok(createWorkerOpts && String(createWorkerOpts.workerPath).endsWith('/ocr-worker.js'),
    'Worker startet über den Filter-Einstieg ocr-worker.js');
  assert.ok(String(createWorkerOpts.corePath).endsWith('/lib/'), 'Kern kommt aus lib/');
  assert.strictEqual(paramCalls[0].tessedit_pageseg_mode, '11', 'PSM 11 wird gesetzt');
  assert.deepStrictEqual(loadedLangs, ['eng'], 'ohne kyrillischen Hinweis nur eng');
  assert.deepStrictEqual(initializedLangs, ['eng']);

  /* 2) JPEG: geht unverändert (ohne Canvas) an den Kern. */
  const canvasBefore = canvasCalls.length;
  nextResponse = () => okResponse('image/jpeg', JPEG_BYTES);
  out = await host.recognize('https://i.ytimg.com/vi/y/hqdefault.jpg', 'eng+rus');
  assert.strictEqual(out.text, 'RECOGNIZED THUMBNAIL TEXT');
  assert.deepStrictEqual(arr(recognized[recognized.length - 1]), arr(JPEG_BYTES), 'JPEG bleibt unverändert');
  assert.strictEqual(canvasCalls.length, canvasBefore, 'keine Konvertierung nötig');

  /* 3) WebP: ebenfalls direkt lesbar. */
  nextResponse = () => okResponse('image/webp', WEBP_BYTES);
  await host.recognize('https://i.ytimg.com/vi_webp/z/hqdefault.webp', 'eng+rus');
  assert.deepStrictEqual(arr(recognized[recognized.length - 1]), arr(WEBP_BYTES), 'WebP bleibt unverändert');

  /* 4) 404: stiller Skip, kein Aufruf des Kerns, kein Cache. */
  const recognizedBefore = recognized.length;
  nextResponse = () => okResponse('text/html', new Uint8Array([60, 104, 116, 109, 108, 62]), 404);
  out = await host.recognize('https://i.ytimg.com/vi/gone/hq720.jpg', 'eng+rus');
  assert.deepStrictEqual(plain(out), { text: '', skipped: true }, '404 → leerer Text statt Fehler');
  assert.strictEqual(recognized.length, recognizedBefore, 'der Kern wurde nicht belastet');
  /* Derselbe URL später erneut: kein negativer Cache — zweiter Versuch erlaubt. */
  nextResponse = () => okResponse('image/jpeg', JPEG_BYTES);
  out = await host.recognize('https://i.ytimg.com/vi/gone/hq720.jpg', 'eng+rus');
  assert.strictEqual(out.text, 'RECOGNIZED THUMBNAIL TEXT', 'nach Netz-Recovery liefert derselbe URL Text');

  /* 5) HTML unter 200: ebenfalls Skip (kein Bild). */
  nextResponse = () => okResponse('text/html; charset=utf-8', new Uint8Array([60, 33, 68, 79, 67, 84, 89, 80, 69, 62]));
  out = await host.recognize('https://i.ytimg.com/vi/html/hq720.jpg', 'eng+rus');
  assert.deepStrictEqual(plain(out), { text: '', skipped: true }, 'HTML-Antwort → Skip');

  /* 6) Nicht dekodierbares AVIF: Skip ohne Ausnahme, ohne Protokoll-Spam. */
  bitmapFails = true;
  nextResponse = () => okResponse('image/avif', AVIF_BYTES);
  out = await host.recognize('https://i.ytimg.com/vi/broken/hq720.jpg', 'eng+rus');
  assert.deepStrictEqual(plain(out), { text: '', skipped: true }, 'kaputtes Bild → Skip statt Fehler');
  bitmapFails = false;

  /* 7) Cache: ein bereits erkannter URL+Sprache-Treffer geht nicht erneut raus. */
  const fetchesBefore = fetchCalls.length;
  out = await host.recognize('https://i.ytimg.com/vi/y/hqdefault.jpg', 'eng+rus');
  assert.strictEqual(out.cached, true, 'Cache-Treffer');
  assert.strictEqual(fetchCalls.length, fetchesBefore, 'kein erneuter Bildabruf bei Cache-Treffer');

  /* 8) Abruf-Fehler (Netz weg): Skip statt Ausnahme. */
  nextResponse = () => { throw new Error('netz weg'); };
  out = await host.recognize('https://i.ytimg.com/vi/offline/hq720.jpg', 'eng+rus');
  assert.deepStrictEqual(plain(out), { text: '', skipped: true }, 'Netzfehler → Skip');

  /* 9) Kurzer/unsicherer Text löst den tiefen Lauf mit Masken aus.
     Der Fake liefert für jede Variante denselben Kurztext; entscheidend ist,
     dass nach dem schnellen Lauf weitere Bildvarianten an Tesseract gehen. */
  recognizeResult = { data: { text: '10 iLvs?', confidence: 40 } };
  const recognizedBeforeDeep = recognized.length;
  nextResponse = () => okResponse('image/jpeg', JPEG_BYTES);
  out = await host.recognize('https://i.ytimg.com/vi/deep/hq720.jpg', 'eng+rus');
  assert.strictEqual(out.text, '10 iLvs?', 'tiefer Lauf liefert den erkannten Text');
  assert.strictEqual(recognized.length - recognizedBeforeDeep, 6,
    'schneller Lauf + fünf Varianten (grau, rot, hell, invertiert, dunkel)');
  assert.strictEqual(recognized[recognized.length - 1].width, 8, 'Varianten sind 2× skaliert');
  assert.strictEqual(recognized[recognized.length - 1].height, 4);

  /* 10) Popup-Vorwärmen: „eng+rus“ initialisiert beide Modelle wirklich
     und meldet danach einen belastbaren Bereit-Status. */
  st = await host.prepare('eng+rus');
  assert.strictEqual(st.state, 'ready', 'nach prepare ist der Host bereit');
  assert.strictEqual(st.loading, false);
  assert.strictEqual(st.error, null);
  assert.deepStrictEqual(plain(st.langs).sort(), ['eng', 'rus'], 'beide Modelle sind geladen');
  assert.deepStrictEqual(initializedLangs.slice().sort(), ['eng', 'rus']);

  /* 11) Kyrillischer Hinweis wählt rus statt des gemischten Modells. Der
     rus-Worker wurde oben bereits vorgeladen und bleibt neben eng bestehen. */
  recognizeResult = { data: { text: 'ПРИВЕТ МИР', confidence: 91 } };
  const loadedBefore = loadedLangs.length;
  const terminatedBefore = terminated;
  nextResponse = () => okResponse('image/jpeg', JPEG_BYTES);
  out = await host.recognize('https://i.ytimg.com/vi/ru/hq720.jpg', 'eng+rus', 'Привет, это русский заголовок');
  assert.strictEqual(out.text, 'ПРИВЕТ МИР');
  assert.strictEqual(loadedLangs.length, loadedBefore, 'kein erneutes Laden nach prepare');
  assert.strictEqual(initializedLangs[initializedLangs.length - 1], 'rus');
  assert.strictEqual(terminated, terminatedBefore, 'der eng-Worker bleibt für spätere Karten erhalten');

  process.stdout.write('ocr-host image tests: OK\n');
})().catch(e => { console.error(e); process.exit(1); });
