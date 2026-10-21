/* test-quiet-warn.js — Log-Filter der Bibliotheks-Meldungen (extension/quiet-warn.js).
   Ohne Browser: console.warn und console.log werden durch Attrappen ersetzt,
   dann die Datei geladen. Geprüft: genau die bekannten Meldungen von
   transformers.js („Unable to determine content-length …“), des
   tesseract.js-Kerns („Image too small to scale!! …“, „Line cannot be
   recognized!!“) sowie die Leptonica-Boxmeldungen und die Debug-Zeile
   „Detected N diacritics“ werden verworfen; jede andere Meldung — auch mit
   ähnlichem Text oder Nicht-String-Argumenten — kommt unverändert durch. */
'use strict';
const assert = require('assert');

const warnings = [];
const logs = [];
const originalWarn = console.warn;
const originalLog = console.log;
console.warn = (...args) => warnings.push(args);
console.log = (...args) => logs.push(args);

require('../extension/quiet-warn.js');

/* Zielmeldungen transformers.js: beide Schreibweisen (voller Satz, nur erster Satz) schweigen. */
console.warn('Unable to determine content-length from response headers. Will expand buffer when needed.');
console.warn('Unable to determine content-length from response headers.');
/* Zielmeldungen tesseract.js-Kern: mit und ohne Suffix („(2x36 vs min width of 3)“). */
console.warn('Image too small to scale!! (2x36 vs min width of 3)');
console.warn('Image too small to scale!!');
console.warn('Line cannot be recognized!!');
/* Leptonica-Boxmeldungen: exakter Text schweigt. */
console.warn('Error in boxClipToRectangle: box outside rectangle');
console.warn('Error in pixScanForForeground: invalid box');
/* Diacritics-Zeile: schweigt auch dann, wenn der Kern sie nach stderr schreibt. */
console.warn('Detected 7 diacritics');
/* Kontrollen: müssen unverändert ankommen. */
console.warn('Andere Warnung der Bibliothek');
console.warn({ code: 'X' });
console.warn('Hinweis: Unable to determine content-length from response headers.');
console.warn('Unable to determine content-le');
console.warn('Bild: Image too small to scale!!');
console.warn('Zeile: Line cannot be recognized!!');
console.warn('Error in boxClipToRectangle: anderer Text');
console.warn('Detected 7 diacritics', 'Zusatz');

/* Debug-Zeile von tprintf: exaktes Muster schweigt, Varianten bleiben. */
console.log('Detected 179 diacritics');
console.log('Anderes Protokoll');
console.log('Detected x diacritics');
console.log('Vorher: Detected 12 diacritics');
console.log('Detected 12 diacritics', 'Zusatz');

console.warn = originalWarn;
console.log = originalLog;

assert.deepStrictEqual(warnings, [
  ['Andere Warnung der Bibliothek'],
  [{ code: 'X' }],
  ['Hinweis: Unable to determine content-length from response headers.'],
  ['Unable to determine content-le'],
  ['Bild: Image too small to scale!!'],
  ['Zeile: Line cannot be recognized!!'],
  ['Error in boxClipToRectangle: anderer Text'],
  ['Detected 7 diacritics', 'Zusatz']
], 'Nur die exakten Präfixe/Muster dürfen verworfen werden');
assert.deepStrictEqual(logs, [
  ['Anderes Protokoll'],
  ['Detected x diacritics'],
  ['Vorher: Detected 12 diacritics'],
  ['Detected 12 diacritics', 'Zusatz']
], 'Nur die exakte Diacritics-Zeile darf verworfen werden');

process.stdout.write('quiet warn tests: OK\n');
