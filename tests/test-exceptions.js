/* test-exceptions.js — Freigaben pro Schlüsselwort und global.
   Reine Logik aus matcher.js + semantischer Margin-Entscheidung, kein Browser. */
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const path = require('path');
const sandbox = { window: {}, browser: {} };
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '../extension/matcher.js'), 'utf8'),
  sandbox
);
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '../extension/semantic.js'), 'utf8'),
  sandbox
);
const m = sandbox.window.YB.matcher;
const sem = sandbox.window.YB.semantic;

/* ---- Normalisierung der Listen ---- */
assert.deepStrictEqual([...m.normalizeExceptions('теннис, пинг-понг')], ['теннис', 'пинг-понг']);
assert.deepStrictEqual([...m.normalizeExceptions([' Теннис ', 'теннис', ''])], ['Теннис']);
assert.deepStrictEqual([...m.normalizeAllowAll('No Tesla\nNo, thanks')], ['No Tesla', 'No, thanks']);
assert.deepStrictEqual([...m.normalizeAllowAll(['No Tesla', 'no tesla'])], ['No Tesla']);
assert.deepStrictEqual([...m.exceptionsOf({ text: 'Робот', exceptions: ['теннис'] })], ['теннис']);
assert.deepStrictEqual([...m.exceptionsOf('Робот')], []);

/* ---- Kurze Begriffe: nur ganzes Wort; lange: auch Wortstamm ---- */
assert.strictEqual(m.exceptionMatches('Робот-теннисист', ['теннис']), true);
assert.strictEqual(m.exceptionMatches('ТЕННИСНЫЙ РОБОТ', ['теннис']), true);
assert.strictEqual(m.exceptionMatches('кибертеннис', ['теннис']), true);
assert.strictEqual(m.exceptionMatches('Робот-пылесос', ['теннис']), false);
assert.strictEqual(m.exceptionMatches('Настольный теннисист', ['настольный теннис']), true);
assert.strictEqual(m.exceptionMatches('Настольный робот', ['настольный теннис']), false);
assert.strictEqual(m.exceptionMatches('said AI', ['ai']), true);
assert.strictEqual(m.exceptionMatches('said', ['ai']), false);
assert.strictEqual(m.exceptionMatches('рококо', ['рок']), false);
assert.strictEqual(m.exceptionMatches('рок', ['рок']), true);
assert.strictEqual(m.exceptionMatches('automatic', ['auto']), true);

/* ---- „No Tesla“: Wortfolge, letztes Wort als Stamm ---- */
assert.strictEqual(m.exceptionMatches('No Tesla: warum ich gegangen bin', ['No Tesla']), true);
assert.strictEqual(m.exceptionMatches('NO-TESLA Review', ['No Tesla']), true);
assert.strictEqual(m.exceptionMatches('No Teslas', ['No Tesla']), true);
assert.strictEqual(m.exceptionMatches('Tesla Model 3', ['No Tesla']), false);
assert.strictEqual(m.exceptionMatches('Tesla: No', ['No Tesla']), false);
assert.strictEqual(m.exceptionMatches('NoTesla Review', ['No Tesla']), false);
assert.strictEqual(m.firstException('No Tesla: warum', ['No Tesla']), 'No Tesla');

/* Dieselbe Phrase nur beim Wort Tesla: hebt Tesla auf, aber nicht Робот. */
const teslaOnly = [{ text: 'Tesla', exceptions: ['No Tesla'] }];
assert.strictEqual(m.matchEntries('No Tesla: warum', teslaOnly, {
  contextText: 'No Tesla: warum', fuzzy: true
}), null);
assert.strictEqual(m.matchEntries('Tesla Model 3', teslaOnly, {
  contextText: 'Tesla Model 3', fuzzy: true
}).text, 'Tesla');
const teslaAndRobot = [
  { text: 'Tesla', exceptions: ['No Tesla'] },
  { text: 'Робот', exceptions: [] }
];
const scopeHit = m.matchEntries('No Tesla и робот', teslaAndRobot, {
  contextText: 'No Tesla и робот', fuzzy: true
});
assert.ok(scopeHit);
assert.strictEqual(scopeHit.text, 'Робот');

/* ---- Erster nicht freigegebener Treffer, nicht der erste Treffer ---- */
const entries = [
  { text: 'Робот', exceptions: ['теннис'] },
  { text: 'Дрон', exceptions: [] }
];
let hit = m.matchEntries('Робот-теннисист и дрон', entries, {
  contextText: 'Робот-теннисист и дрон', fuzzy: true
});
assert.ok(hit, 'Дрон muss trotz freigegebenem Робот treffen');
assert.strictEqual(hit.text, 'Дрон');
assert.strictEqual(m.matchEntries('Робот-теннисист', entries, {
  contextText: 'Робот-теннисист', fuzzy: true
}), null);
hit = m.matchEntries('Робот-пылесос', entries, {
  contextText: 'Робот-пылесос', fuzzy: true
});
assert.strictEqual(hit.text, 'Робот');

/* ---- Kanäle und Routen behalten die Freigaben ---- */
const kws = [
  { text: 'Робот', enabled: true, exceptions: ['теннис'] },
  { text: 'Дрон', enabled: true, route: 'image' },
  { text: 'OCR-Wort', enabled: true, route: 'ocr' },
  { text: 'Hybrid', enabled: true, route: 'hybrid', exceptions: ['ruhig'] },
  { text: 'Aus', enabled: false, exceptions: ['x'] },
  'String'
];
assert.deepStrictEqual([...m.channelEntries(kws, 'title').map(e => e.text)], ['Робот', 'Hybrid', 'String']);
assert.deepStrictEqual([...m.channelEntries(kws, 'image').map(e => e.text)], ['Робот', 'Дрон', 'Hybrid', 'String']);
assert.deepStrictEqual([...m.channelEntries(kws, 'ocr').map(e => e.text)], ['Робот', 'OCR-Wort', 'Hybrid', 'String']);
assert.deepStrictEqual([...m.channelEntries(kws, 'title')[0].exceptions], ['теннис']);
assert.deepStrictEqual([...m.channelEntries(kws, 'title')[1].exceptions], ['ruhig']);
assert.deepStrictEqual([...m.channelKeywords(kws, 'image')], ['Робот', 'Дрон', 'Hybrid', 'String']);

/* ---- Semantik: freigegebene Konzepte verdrängen keine aktiven Treffer ---- */
const scores = [
  { text: 'Робот', cos: 0.50 },
  { text: 'Дрон', cos: 0.40 },
  { text: 'Navy', cos: 0.10 }
];
const imageEntries = [
  { text: 'Робот', exceptions: ['теннис'] },
  { text: 'Дрон', exceptions: [] },
  { text: 'Navy', exceptions: [] }
];
let active = m.activeScores(scores, imageEntries, 'теннисный робот');
assert.deepStrictEqual([...active.map(s => s.text)], ['Дрон', 'Navy']);
let decision = sem.marginDecision(active, 0.03);
assert.strictEqual(decision.text, 'Дрон');
assert.strictEqual(decision.refText, 'Navy');

active = m.activeScores(scores, imageEntries, 'робот-пылесос');
assert.deepStrictEqual([...active.map(s => s.text)], ['Робот', 'Дрон', 'Navy']);

/* Ohne Freigabe bleibt das Score-Array unverändert. */
const same = m.activeScores(scores, imageEntries, '');
assert.deepStrictEqual([...same.map(s => s.text)], ['Робот', 'Дрон', 'Navy']);

console.log('exception tests: OK');
