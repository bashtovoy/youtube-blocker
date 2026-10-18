/* test-quiet-warn.js — Log-Filter des Semantik-Workers (extension/quiet-warn.js).
   Ohne Browser: console.warn wird durch eine Attrappe ersetzt, dann die Datei
   geladen. Geprüft: Genau die transformers.js-Meldung „Unable to determine
   content-length …“ wird verworfen; jede andere Warnung — auch mit ähnlichem
   Text oder Nicht-String-Argumenten — kommt unverändert durch. */
'use strict';
const assert = require('assert');

const captured = [];
const original = console.warn;
console.warn = (...args) => captured.push(args);

require('../extension/quiet-warn.js');

/* Zielmeldung: beide Schreibweisen (voller Satz, nur erster Satz) schweigen. */
console.warn('Unable to determine content-length from response headers. Will expand buffer when needed.');
console.warn('Unable to determine content-length from response headers.');
/* Kontrollen: müssen unverändert ankommen. */
console.warn('Andere Warnung der Bibliothek');
console.warn({ code: 'X' });
console.warn('Hinweis: Unable to determine content-length from response headers.');
console.warn('Unable to determine content-le');

console.warn = original;

assert.deepStrictEqual(captured, [
  ['Andere Warnung der Bibliothek'],
  [{ code: 'X' }],
  ['Hinweis: Unable to determine content-length from response headers.'],
  ['Unable to determine content-le']
], 'Nur die exakte content-length-Meldung darf verworfen werden');

process.stdout.write('quiet warn tests: OK\n');
