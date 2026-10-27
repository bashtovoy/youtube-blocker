/* test-lexicon.js — Begriffsmatrix: Migration der alten 54-Wörter-Liste,
   Expansion in die Textkanäle, ein Prompt pro Gruppe für SigLIP, flaches
   keywords-Mirror. Kein Browser, kein Netz. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const EXT = path.join(__dirname, '..', 'extension');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const file of ['matcher.js', 'lexicon.js', 'popup/lexicon-data.js']) {
  vm.runInContext(fs.readFileSync(path.join(EXT, file), 'utf8'), sandbox);
}
const arr = value => Array.from(value || []);   /* VM-Arrays in den Host-Realm holen */
const L = sandbox.window.YB.lexicon;
const matcher = sandbox.window.YB.matcher;
const data = sandbox.window.YB.lexiconData;
const flat = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'keywords-54.json'), 'utf8'));

assert.ok(L, 'lexicon.js muss YB.lexicon exportieren');
assert.ok(data && Array.isArray(data.groups), 'lexicon-data.js muss Gruppen liefern');
assert.strictEqual(flat.length, 54, 'Fixtur muss die 54 Wörter des alten Exports enthalten');
assert.strictEqual(data.groups.length, 25, 'kuratierte Startmatrix hat 25 Gruppen');

/* 1) Migration: alle 54 Wörter landen in passenden Gruppen, nichts wird
   unbekannt/verworfen, und die kuratierten Varianten kommen vollständig mit. */
const res = L.migrate(flat, data.groups);
assert.strictEqual(res.unmatched, 0, 'kein Wort darf als unbekannt übrig bleiben');
assert.strictEqual(res.matchedGroups, 25, 'alle 25 Vorlagen werden durch die 54 Wörter erreicht');
assert.strictEqual(res.lexicon.length, 25, 'Migration erzeugt 25 Gruppen');

const variantNorms = new Set();
res.lexicon.forEach(g => g.variants.forEach(v => variantNorms.add(L.normalizeText(v))));
for (const item of flat) {
  const n = L.normalizeText(item.text);
  assert.ok(n, 'leeres Wort in der Fixtur');
  assert.ok(variantNorms.has(n), 'Wort fehlt nach der Migration: ' + item.text);
}
assert.strictEqual(L.duplicateVariants(res.lexicon).length, 0, 'keine Variante doppelt über Gruppen');

const byId = id => res.lexicon.find(g => g.id === id);
for (const id of ['drones', 'robots', 'trump', 'tesla', 'leaks', 'news', 'military', 'war',
  'navy', 'politics', 'russia', 'china', 'scandal', 'hackers', 'death', 'clickbait', 'vr']) {
  assert.ok(byId(id), 'Gruppe fehlt: ' + id);
}

/* 2) Gruppen-Ausnahmen werden zusammengeführt (Робот + Robot) und bleiben
   nach der Migration erhalten. */
const robots = byId('robots');
const robotExceptions = arr(matcher.normalizeExceptions(robots.exceptions));
for (const ex of ['теннис', 'tennis', 'настольный теннис', 'table tennis', 'пинг-понг', 'ping pong', 'теніс']) {
  assert.ok(robotExceptions.includes(ex), 'Robot-Ausnahme fehlt: ' + ex);
}
const tesla = byId('tesla');
assert.ok(arr(matcher.normalizeExceptions(tesla.exceptions)).includes('no tesla'), 'Tesla-Ausnahme fehlt');
assert.ok(arr(matcher.normalizeExceptions(byId('news').exceptions)).includes('breaking bad'));
assert.ok(arr(matcher.normalizeExceptions(byId('death').exceptions)).includes('kill bill'));

/* 3) Routen: acht Konzepte laufen nur über Text (kein SigLIP), alle anderen auto. */
const textGroups = ['news', 'leaks', 'scandal', 'hackers', 'clickbait', 'politics', 'russia', 'china'];
res.lexicon.forEach(g => {
  assert.strictEqual(g.route, textGroups.includes(g.id) ? 'text' : 'auto',
    'Route von ' + g.id + ' weicht von der Kuratierung ab');
});
assert.strictEqual(L.routeApplies('text', 'title'), true);
assert.strictEqual(L.routeApplies('text', 'ocr'), true);
assert.strictEqual(L.routeApplies('text', 'speech'), true);
assert.strictEqual(L.routeApplies('text', 'image'), false);
assert.strictEqual(L.routeApplies('auto', 'image'), true);
assert.strictEqual(L.routeApplies('image', 'speech'), false);

/* 4) Textkanäle: jede Variante wird expandiert; der Bildkanal bekommt genau
   einen Prompt pro Gruppe, damit Synonyme nicht in der Margin konkurrieren. */
const stats = L.stats(res.lexicon);
assert.strictEqual(stats.groups, 25);
assert.ok(stats.variants >= 180, 'die Matrix soll die 54 Wörter deutlich ergänzen: ' + stats.variants);

const titleEntries = L.entriesFor(res.lexicon, 'title');
assert.strictEqual(titleEntries.length, stats.variants, 'Titelkanal enthält jede Variante');
assert.ok(titleEntries.every(e => !e.prompt), 'Titelkanal enthält keine Bild-Prompts');
assert.ok(titleEntries.some(e => e.text === 'Дрон' && e.group === 'drones'));

const imageEntries = L.entriesFor(res.lexicon, 'image');
assert.strictEqual(imageEntries.length, 25 - textGroups.length, 'ein Prompt je Auto-Gruppe');
assert.ok(imageEntries.every(e => e.prompt === true && e.text && e.group));
assert.deepStrictEqual(arr(imageEntries.map(e => e.group)).sort(),
  arr(res.lexicon.filter(g => g.route === 'auto').map(g => g.id)).sort(),
  'Bildkanal ignoriert reine Textgruppen');
const dronePrompt = imageEntries.find(e => e.group === 'drones');
assert.strictEqual(dronePrompt.text, 'a drone flying in the sky',
  'Bildkanal nutzt den Prompt, nicht die Variante');
assert.ok(!L.entriesFor(res.lexicon, 'image').some(e => e.text === 'Дрон'));

const imagePrompts = imageEntries.map(e => L.normalizeText(e.text));
assert.strictEqual(new Set(imagePrompts).size, imagePrompts.length, 'Prompts sind eindeutig');

/* 5) Flaches Spiegelformat für alte Versionen/Exporte: Routen bleiben,
   Auto wird weggelassen, Ausnahmen werden auf jede Variante kopiert. */
const kws = L.toKeywords(res.lexicon);
assert.ok(Array.isArray(kws));
assert.ok(kws.every(k => k.enabled === true));
const flatNorm = new Set(kws.map(k => L.normalizeText(k.text)));
for (const n of variantNorms) assert.ok(flatNorm.has(n), 'toKeywords verliert Variante: ' + n);
const robotKeyword = kws.find(k => k.text === 'Робот');
assert.ok(robotKeyword.exceptions.includes('теннис') && robotKeyword.exceptions.includes('tennis'));
assert.ok(!('route' in robotKeyword), 'Auto wird im Altformat nicht geschrieben');
assert.ok(kws.filter(k => k.route === 'text').length > 0, 'Text-Route überlebt den Export');
assert.ok(kws.filter(k => k.route === 'text').every(k => ['news', 'leaks', 'scandal', 'hackers',
  'clickbait', 'politics', 'russia', 'china'].includes(
  res.lexicon.find(g => g.variants.some(v => L.normalizeText(v) === L.normalizeText(k.text))).id)),
  'Text-Route gehört nur zu den acht Textgruppen');

/* 6) Deaktivierte Gruppe: keine Treffer, aber das Mirror-Format bleibt
   vollständig und markiert die Varianten als aus. */
const off = res.lexicon.map(g => Object.assign({}, g, {
  variants: g.variants.slice(),
  exceptions: (g.exceptions || []).slice(),
  enabled: g.id === 'drones' ? false : g.enabled
}));
assert.ok(!L.entriesFor(off, 'title').some(e => e.group === 'drones'));
assert.ok(L.toKeywords(off).filter(k => k.text === 'Дрон').every(k => k.enabled === false));
assert.ok(L.stats(off).enabled === 24);

/* 7) Unbekannte Wörter werden nicht verworfen, sondern zur Einzelgruppe. */
const unknown = L.migrate(flat.slice(0, 2).concat([
  { text: 'Квантовый тостер', enabled: false, route: 'image' }
]), data.groups);
assert.strictEqual(unknown.unmatched, 1);
const single = unknown.lexicon.find(g => g.label === 'Квантовый тостер');
assert.ok(single, 'unbekanntes Wort als Einzelgruppe');
assert.strictEqual(single.enabled, false);
assert.strictEqual(single.route, 'image');
assert.deepStrictEqual(arr(single.variants), ['Квантовый тостер']);

/* 8) Normalisierung ist defensiv: Strings, Unsinn, doppelte IDs. */
assert.strictEqual(L.normalizeLexicon(null).length, 0);
assert.strictEqual(L.normalizeLexicon('kaputt').length, 0);
const normalized = L.normalizeLexicon([
  { id: 'x', label: 'X', variants: [' A ', 'a', ''], route: 'nope', exceptions: 'eins, zwei' },
  { id: 'x', label: 'Y', variants: ['b'], route: 'text' }
]);
assert.strictEqual(normalized.length, 2);
assert.strictEqual(normalized[0].route, 'auto');
assert.deepStrictEqual(arr(normalized[0].variants), ['A']);
assert.deepStrictEqual(arr(normalized[0].exceptions), ['eins', 'zwei']);
assert.notStrictEqual(normalized[0].id, normalized[1].id, 'doppelte IDs werden eindeutig');

/* 9) Neue Gruppen und Suche. */
const created = L.createGroup('Новая тема', res.lexicon);
assert.ok(!res.lexicon.some(g => g.id === created.id));
assert.deepStrictEqual(arr(created.variants), ['Новая тема']);
assert.strictEqual(created.route, 'auto');
assert.ok(L.findVariant(res.lexicon, 'ДРОН'));
assert.strictEqual(L.findVariant(res.lexicon, 'квантовый тостер'), null);

/* 10) Kein Fuzzy: exakte Wortformen, keine Edit-Distanz. */
assert.strictEqual(matcher.levenshtein, undefined);
assert.strictEqual(matcher.matchKeywords('Дроны летят', ['Дрон']), null);
assert.strictEqual(matcher.matchKeywords('Дрон летит', ['Дрон']), 'Дрон');

console.log('lexicon tests: OK (' + stats.groups + ' Gruppen, ' + stats.variants + ' Varianten)');
