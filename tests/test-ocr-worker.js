/* test-ocr-worker.js — Einstieg des Tesseract-Workers (extension/ocr-worker.js).
   Ohne Browser: importScripts wird zur Attrappe, die quiet-warn.js wirklich lädt
   (das Tesseract-Bundle wird übersprungen). Geprüft: Der Log-Filter steht VOR dem
   Tesseract-Skript — der Kern bindet console.warn beim eigenen Laden — und die
   kosmetischen Kern- sowie Leptonica-Meldungen kommen nicht mehr durch. */
'use strict';
const assert = require('assert');
const path = require('path');

const loaded = [];
global.importScripts = (...urls) => {
  for (const u of urls) {
    loaded.push(u);
    if (u === 'quiet-warn.js') require(path.join(__dirname, '..', 'extension', 'quiet-warn.js'));
  }
};

/* quiet-warn.js bindet console.warn beim Laden — die Attrappen müssen vorher stehen. */
const captured = [];
const logged = [];
const originalWarn = console.warn;
const originalLog = console.log;
console.warn = (...args) => captured.push(args);
console.log = (...args) => logged.push(args);

require(path.join(__dirname, '..', 'extension', 'ocr-worker.js'));

/* Zielmeldungen des tesseract.js-Kerns: schweigen (mit und ohne Suffix). */
console.warn('Image too small to scale!! (2x36 vs min width of 3)');
console.warn('Line cannot be recognized!!');
console.warn('Error in boxClipToRectangle: box outside rectangle');
console.warn('Error in pixScanForForeground: invalid box');
console.warn('Detected 3 diacritics');
console.log('Detected 42 diacritics');
/* Kontrolle: alles andere bleibt. */
console.warn('Error attempting to read image');
console.log('ocr host: worker bereit (eng)');

console.warn = originalWarn;
console.log = originalLog;

assert.deepStrictEqual(loaded, ['quiet-warn.js', 'lib/worker-tesseract.min.js'],
  'Filter zuerst laden, dann das Tesseract-Worker-Skript');
assert.deepStrictEqual(captured, [['Error attempting to read image']],
  'Nur die Kontrolle darf durchkommen');
assert.deepStrictEqual(logged, [['ocr host: worker bereit (eng)']],
  'Nur die exakte Diacritics-Zeile wird verworfen');

process.stdout.write('ocr worker tests: OK\n');
