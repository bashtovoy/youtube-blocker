/* test-quiet-warn.js — Log-Filter der Bibliotheks-Warnungen (extension/quiet-warn.js).
   Ohne Browser: console.warn wird durch eine Attrappe ersetzt, dann die Datei
   geladen. Geprüft: Genau die bekannten Meldungen von transformers.js
   („Unable to determine content-length …“) und des tesseract.js-Kerns
   („Image too small to scale!! …“, „Line cannot be recognized!!“) werden
   verworfen; jede andere Warnung — auch mit ähnlichem Text oder
   Nicht-String-Argumenten — kommt unverändert durch. */
'use strict';
const assert = require('assert');

const captured = [];
const original = console.warn;
console.warn = (...args) => captured.push(args);

require('../extension/quiet-warn.js');

/* Zielmeldungen transformers.js: beide Schreibweisen (voller Satz, nur erster Satz) schweigen. */
console.warn('Unable to determine content-length from response headers. Will expand buffer when needed.');
console.warn('Unable to determine content-length from response headers.');
/* Zielmeldungen tesseract.js-Kern: mit und ohne Suffix („(2x36 vs min width of 3)“). */
console.warn('Image too small to scale!! (2x36 vs min width of 3)');
console.warn('Image too small to scale!!');
console.warn('Line cannot be recognized!!');
/* Kontrollen: müssen unverändert ankommen. */
console.warn('Andere Warnung der Bibliothek');
console.warn({ code: 'X' });
console.warn('Hinweis: Unable to determine content-length from response headers.');
console.warn('Unable to determine content-le');
console.warn('Bild: Image too small to scale!!');
console.warn('Zeile: Line cannot be recognized!!');

console.warn = original;

assert.deepStrictEqual(captured, [
  ['Andere Warnung der Bibliothek'],
  [{ code: 'X' }],
  ['Hinweis: Unable to determine content-length from response headers.'],
  ['Unable to determine content-le'],
  ['Bild: Image too small to scale!!'],
  ['Zeile: Line cannot be recognized!!']
], 'Nur die exakten Präfixe dürfen verworfen werden');

process.stdout.write('quiet warn tests: OK\n');
