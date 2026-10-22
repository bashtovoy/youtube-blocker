/* test-ai-channel.js — Kanal-Zähler für offizielle KI-Kennzeichnungen.
   Reine Logik aus extension/ai-channel.js; kein DOM, kein Browser. */
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');

const sandbox = { window: {}, self: null, URL, console };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'ai-channel.js'), 'utf8'), sandbox);
const a = sandbox.YB && sandbox.YB.aiChannel;
assert.ok(a, 'ai-channel.js muss YB.aiChannel exportieren');
assert.deepStrictEqual([...a.MODES], ['off', 'badge', 'dim'], 'kein lokales Ausblenden mehr');

const V1 = 'aaaaaaaaaaa';
const V2 = 'bbbbbbbbbbb';
const V3 = 'ccccccccccc';
const UC = 'UCabcdefghijklmnopqrstuv';
const ref = { key: UC, id: UC, name: 'Testkanal' };

/* ---- 1) Kanal-Links: ID vor Handle, Handle vor Name ---- */
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(a.refFromHref('/channel/' + UC, 'Testkanal'))),
  { key: UC, id: UC, handle: '', legacy: '', name: 'Testkanal' }
);
assert.strictEqual(a.refFromHref('/@Foo', 'Foo').key, '@foo');
assert.strictEqual(a.refFromHref('https://www.youtube.com/@Foo/videos?x=1#y', 'Foo').key, '@foo');
assert.strictEqual(a.refFromHref('/c/Foo', 'Foo').key, 'legacy:foo');
assert.strictEqual(a.refFromHref('/user/Foo', 'Foo').key, 'legacy:foo');
assert.strictEqual(a.refFromHref('', ' Test  Channel ').key, 'name:test channel');
assert.strictEqual(a.refFromHref('https://example.com/channel/' + UC, 'Testkanal').key, 'name:testkanal');
assert.strictEqual(a.refFromHref('/watch?v=' + V1, '').key, '', 'Watch-Link ist kein Kanal');

/* ---- 2) Ein Hit reicht nicht, zwei verschiedene Videos schon ---- */
let store = {};
store = a.recordHit(store, ref, V1, 1000);
assert.strictEqual(a.isFlagged(a.findRecord(store, ref).rec, 1000), false, 'ein Video reicht nicht');
store = a.recordHit(store, ref, V2, 2000);
assert.strictEqual(a.isFlagged(a.findRecord(store, ref).rec, 2000), true, 'zwei Videos markieren');
assert.strictEqual(a.findRecord(store, ref).rec.videos.length, 2);

/* Dasselbe Video zählt nicht doppelt. */
store = a.recordHit(store, ref, V2, 3000);
assert.strictEqual(a.findRecord(store, ref).rec.videos.length, 2, 'Duplikat zählt nicht');
assert.strictEqual(a.isFlagged(a.findRecord(store, ref).rec, 3000), true);

/* Die Eingabe wird nicht mutiert; Content/Background schreiben nur das Ergebnis. */
const beforeMutation = JSON.stringify(store);
a.recordHit(store, ref, V3, 3500);
assert.strictEqual(JSON.stringify(store), beforeMutation, 'recordHit mutiert den Eingabestand nicht');

/* ---- 3) 180-Tage-Fenster und TTL ---- */
const later = 2000 + a.WINDOW_MS + 1;
assert.strictEqual(a.isFlagged(a.findRecord(store, ref).rec, later), false, 'alte Hits verfallen');
const pruned = a.prune(store, later);
assert.ok(!pruned[UC] || pruned[UC].videos.length === 0, 'alte Videos werden entfernt');

/* ---- 4) Obergrenzen ---- */
let many = {};
for (let i = 0; i < 12; i++) {
  const id = String(i).padStart(11, 'x');
  many = a.recordHit(many, ref, id, 10000 + i);
}
assert.strictEqual(many[UC].videos.length, a.MAX_VIDEOS, 'maximal 10 Videos je Kanal');

let channels = {};
for (let i = 0; i < a.MAX_CHANNELS + 5; i++) {
  const c = { key: 'UC' + String(i).padStart(22, 'x'), id: 'UC' + String(i).padStart(22, 'x'), name: 'K' + i };
  channels = a.recordHit(channels, c, String(i).padStart(11, 'y'), 20000 + i);
}
assert.strictEqual(Object.keys(channels).length, a.MAX_CHANNELS, 'maximal 300 Kanäle');

/* ---- 5) Entscheidung: Modus, offizielle Kennzeichnung, Freigaben ---- */
assert.strictEqual(a.decision(store, ref, { hideAiGenerated: true, aiChannelMode: 'off' }, {}, V1, 2000), 'off');
assert.strictEqual(a.decision(store, ref, { hideAiGenerated: false, aiChannelMode: 'badge' }, {}, V1, 2000), 'off');
assert.strictEqual(a.decision(store, ref, { hideAiGenerated: true, aiChannelMode: 'badge' }, {}, V1, 2000), 'badge');
assert.strictEqual(a.decision(store, ref, { hideAiGenerated: true, aiChannelMode: 'dim' }, {}, V1, 2000), 'dim');
assert.strictEqual(a.decision(store, ref, { hideAiGenerated: true, aiChannelMode: 'hide' }, {}, V1, 2000), 'off', 'entfernter Modus fällt auf aus zurück');
assert.strictEqual(a.decision(store, ref, { hideAiGenerated: true, aiChannelMode: 'foo' }, {}, V1, 2000), 'off');
assert.strictEqual(a.decision(store, ref, { hideAiGenerated: true, aiChannelMode: 'badge' }, { allowVideos: { [V1]: 1 } }, V1, 2000), 'off');
assert.strictEqual(a.decision(store, ref, { hideAiGenerated: true, aiChannelMode: 'badge' }, { allowChannels: { [UC]: 1 } }, V1, 2000), 'off');
assert.strictEqual(a.decision(store, ref, { hideAiGenerated: true, aiChannelMode: 'badge' }, {}, V3, 2000), 'badge', 'Video-Freigabe gilt nur für dieses Video');

/* ---- 6) Lokalisierte Marker ---- */
for (const lang of ['de', 'en', 'ru', 'uk']) {
  const t = a.badgeText(lang);
  assert.ok(t.mark && t.aria && t.hint, 'Marker fehlt: ' + lang);
  assert.ok(!/undefined/.test(t.mark + t.aria + t.hint), 'kein undefined: ' + lang);
}
assert.strictEqual(a.badgeText('unbekannt').mark, a.badgeText('en').mark);

console.log('test-ai-channel: OK');
