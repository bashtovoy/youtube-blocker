/* test-routes.js — Wortlisten-Routen (docs/SEMANTIC_FILTER_ROUTING.md, Punkt 1).
   Fehlende Route = Altverhalten (alle Kanäle); 'hybrid' = Titel + OCR + Bild;
   'text' = reine Textspur (Titel, Kanal, OCR, Transkript) ohne SigLIP. */
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const sandbox = { window: {} };
vm.runInNewContext(
  fs.readFileSync(require('path').join(__dirname, '../extension/matcher.js'), 'utf8'),
  sandbox
);
const m = sandbox.window.YB.matcher;
assert.strictEqual(typeof m.channelKeywords, 'function');
assert.strictEqual(typeof m.routeOf, 'function');
assert.strictEqual(typeof m.routeApplies, 'function');

const kws = [
  'Дрон',                                       /* String = Auto (alle Kanäle) */
  { text: 'cybercab', enabled: true, route: 'image' },
  { text: 'Navy', enabled: true, route: 'title' },
  { text: 'OCR-Wort', enabled: true, route: 'ocr' },
  { text: 'Hybrid', enabled: true, route: 'hybrid' },
  { text: 'TextWort', enabled: true, route: 'text' },
  { text: 'Aus', enabled: false, route: 'image' },
  { text: 'Kaputt', enabled: true, route: 'foo' },   /* ungültig → Auto */
  { text: '   ', enabled: true }
];

assert.deepStrictEqual([...m.channelKeywords(kws, 'title')],
  ['Дрон', 'Navy', 'Hybrid', 'TextWort', 'Kaputt']);
assert.deepStrictEqual([...m.channelKeywords(kws, 'ocr')],
  ['Дрон', 'OCR-Wort', 'Hybrid', 'TextWort', 'Kaputt']);
assert.deepStrictEqual([...m.channelKeywords(kws, 'image')],
  ['Дрон', 'cybercab', 'Hybrid', 'Kaputt']);
/* speech ist ein reiner Textkanal: keine Bild-/Titel-/OCR-Routen. */
assert.deepStrictEqual([...m.channelKeywords(kws, 'speech')],
  ['Дрон', 'Hybrid', 'TextWort', 'Kaputt']);

/* Altformat-Bestand: nur Strings / {text,enabled} */
assert.deepStrictEqual([...m.channelKeywords(['a', { text: 'b', enabled: true }], 'image')], ['a', 'b']);
assert.deepStrictEqual([...m.channelKeywords([{ text: 'b', enabled: false }], 'title')], []);

/* routeOf-Validierung */
assert.strictEqual(m.routeOf({ route: 'hybrid' }), 'hybrid');
assert.strictEqual(m.routeOf({ route: 'image' }), 'image');
assert.strictEqual(m.routeOf({ route: 'text' }), 'text');
assert.strictEqual(m.routeOf({ route: 'nope' }), null);
assert.strictEqual(m.routeOf('Drone'), null);
assert.strictEqual(m.routeOf(null), null);

/* routeApplies: 'text' wirkt nur in Textkanälen, Bildrouten nie im Transkript. */
assert.strictEqual(m.routeApplies('text', 'title'), true);
assert.strictEqual(m.routeApplies('text', 'ocr'), true);
assert.strictEqual(m.routeApplies('text', 'speech'), true);
assert.strictEqual(m.routeApplies('text', 'image'), false);
assert.strictEqual(m.routeApplies('image', 'speech'), false);
assert.strictEqual(m.routeApplies(null, 'speech'), true);
assert.strictEqual(m.routeApplies('hybrid', 'image'), true);

console.log('route tests: OK');
