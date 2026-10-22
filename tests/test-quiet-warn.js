/* test-quiet-warn.js — Log-Filter der Bibliotheks-Meldungen (extension/quiet-warn.js).
   Ohne Browser: console.warn und console.log werden durch Attrappen ersetzt,
   dann die Datei geladen. Geprüft: genau die bekannte Meldung von
   transformers.js („Unable to determine content-length …“) wird verworfen;
   jede andere Meldung — auch mit ähnlichem Text oder Nicht-String-Argumenten —
   kommt unverändert durch. */
'use strict';
const assert = require('assert');

const warnings = [];
const logs = [];
const originalWarn = console.warn;
const originalLog = console.log;
console.warn = (...args) => warnings.push(args);
console.log = (...args) => logs.push(args);

require('../extension/quiet-warn.js');

/* Zielmeldung transformers.js: beide Schreibweisen (voller Satz, nur erster Satz) schweigen. */
console.warn('Unable to determine content-length from response headers. Will expand buffer when needed.');
console.warn('Unable to determine content-length from response headers.');
/* Kontrollen: müssen unverändert ankommen. */
console.warn('Andere Warnung der Bibliothek');
console.warn({ code: 'X' });
console.warn('Hinweis: Unable to determine content-length from response headers.');
console.warn('Unable to determine content-le');
console.warn('Image too small to scale!!');
console.warn('Detected 7 diacritics');

console.log('Anderes Protokoll');

console.warn = originalWarn;
console.log = originalLog;

assert.deepStrictEqual(warnings, [
  ['Andere Warnung der Bibliothek'],
  [{ code: 'X' }],
  ['Hinweis: Unable to determine content-length from response headers.'],
  ['Unable to determine content-le'],
  ['Image too small to scale!!'],
  ['Detected 7 diacritics']
], 'Nur das exakte Präfix darf verworfen werden');
assert.deepStrictEqual(logs, [
  ['Anderes Protokoll']
], 'Nicht-Zielmeldungen bleiben im Protokoll');

process.stdout.write('quiet warn tests: OK\n');
