/* test-shots.js — Kontrollbilder vor dem Ausblenden (extension/shots.js).
   Prüft: Dateiname (Datum/Uhrzeit/Kennung/Grund, ASCII), Sichtbarkeit der Karte
   inklusive verdeckendem Masthead, Zuschnitt des Chrome-Screenshots und die
   Ausgabegröße. Kein Browser, kein Netz, keine Dateien. */
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');

const sandbox = { window: {}, self: {}, console };
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'shots.js'), 'utf8'), sandbox);
const s = sandbox.YB && sandbox.YB.shots;
assert.ok(s, 'shots.js muss YB.shots exportieren');

/* ---- 1) Dateiname: lokale Zeit, Unterordner je Tag, ASCII-Kennung ---- */
const d = new Date(2026, 9, 20, 16, 30, 15);
assert.strictEqual(s.fileName(d, 'quzTROdLmU4', 'ai-generated'),
  'YouTube Blocker/2026-10-20/163015_quzTROdLmU4_ai.jpg');
assert.strictEqual(s.fileName(d, 'quzTROdLmU4', 'members-only'),
  'YouTube Blocker/2026-10-20/163015_quzTROdLmU4_members.jpg');
assert.strictEqual(s.fileName(d, 'quzTROdLmU4', 'promo'),
  'YouTube Blocker/2026-10-20/163015_quzTROdLmU4_promo.jpg');
assert.strictEqual(s.fileName(new Date(2026, 0, 2, 3, 4, 5), '', 'promo'),
  'YouTube Blocker/2026-01-02/030405_slot_promo.jpg', 'Werbeplatz ohne Video-Kennung');

/* Gründe tragen teils einen Suchbegriff („title:…“) — im Namen steht nur der Kanal. */
assert.strictEqual(s.fileName(d, 'abcdefghijk', 'title:foo'), 'YouTube Blocker/2026-10-20/163015_abcdefghijk_title.jpg');
assert.strictEqual(s.fileName(d, 'abcdefghijk', 'channel:bar'), 'YouTube Blocker/2026-10-20/163015_abcdefghijk_channel.jpg');
assert.strictEqual(s.fileName(d, 'abcdefghijk', 'semantic-image:baz'), 'YouTube Blocker/2026-10-20/163015_abcdefghijk_semantic.jpg');
assert.strictEqual(s.fileName(d, 'abcdefghijk', 'ocr:x'), 'YouTube Blocker/2026-10-20/163015_abcdefghijk_ocr.jpg');
assert.strictEqual(s.fileName(d, 'abcdefghijk', 'speech:y'), 'YouTube Blocker/2026-10-20/163015_abcdefghijk_speech.jpg');
assert.strictEqual(s.fileName(d, 'test', 'test'), 'YouTube Blocker/2026-10-20/163015_test_test.jpg');
assert.strictEqual(s.fileName(d, 'abcdefghijk', 'unknown'), 'YouTube Blocker/2026-10-20/163015_abcdefghijk_other.jpg');

/* Fremde Zeichen (Pfadtrenner, Punkte, Leerzeichen) dürfen nicht in den Namen. */
assert.strictEqual(s.sanitizeId('../../etc/passwd'), 'etcpasswd');
assert.strictEqual(s.sanitizeId('a b/c'), 'abc');
assert.strictEqual(s.sanitizeId(''), 'slot');
assert.ok(s.fileName(d, 'a/b\\c:d*e?f', 'ai-generated').indexOf('a/b') === -1, 'keine Pfadtrenner in der Kennung');
assert.ok(/^[\x20-\x7E]+$/.test(s.fileName(d, 'ümlaut', 'ai-generated')), 'Dateiname bleibt ASCII');

/* ---- 2) Vollständig sichtbar: Fenster plus verdeckende Balken ---- */
const vp = { w: 1000, h: 800 };
const card = { x: 100, y: 100, w: 360, h: 200 };
assert.strictEqual(s.fullyVisible(card, vp, []), true, 'Karte komplett im Fenster');
assert.strictEqual(s.fullyVisible({ x: 100, y: 700, w: 360, h: 200 }, vp, []), false, 'unten abgeschnitten');
assert.strictEqual(s.fullyVisible({ x: -1, y: 100, w: 360, h: 200 }, vp, []), false, 'links abgeschnitten');
assert.strictEqual(s.fullyVisible({ x: 0, y: 0, w: 1000, h: 800 }, vp, []), true, 'exakt bildschirmfüllend');
assert.strictEqual(s.fullyVisible({ x: 0, y: 0, w: 0, h: 200 }, vp, []), false, 'ohne Fläche');
/* Masthead oben (56 px) verdeckt die obere Kante */
assert.strictEqual(s.fullyVisible({ x: 100, y: 20, w: 360, h: 200 }, vp,
  [{ x: 0, y: 0, w: 1000, h: 56 }]), false, 'unter dem Masthead');
assert.strictEqual(s.fullyVisible({ x: 100, y: 60, w: 360, h: 200 }, vp,
  [{ x: 0, y: 0, w: 1000, h: 56 }]), true, 'direkt unter dem Masthead');
/* Balken am linken Rand (Guide) verdeckt nur, wenn er die Karte berührt */
assert.strictEqual(s.fullyVisible(card, vp, [{ x: 0, y: 0, w: 80, h: 800 }]), true);
assert.strictEqual(s.fullyVisible(card, vp, [{ x: 0, y: 0, w: 120, h: 800 }]), false);

/* ---- 3) Zuschnitt des Chrome-Bildes (Gerätepixel → CSS-Pixel) ---- */
const crop = s.cropPixels({ x: 100, y: 50, w: 200, h: 120 }, vp, 2000, 1600);   /* 2 Gerätepixel je CSS-Pixel */
assert.deepStrictEqual(Object.assign({}, crop), { sx: 200, sy: 100, sw: 400, sh: 240 });
/* Karte am Rand: Ausschnitt bleibt im Bild */
const edge = s.cropPixels({ x: 980, y: 780, w: 40, h: 40 }, vp, 2000, 1600);
assert.strictEqual(edge.sx, 1960);
assert.strictEqual(edge.sy, 1560);
assert.strictEqual(edge.sw, 40);
assert.strictEqual(edge.sh, 40);
assert.strictEqual(s.cropPixels({ x: 0, y: 0, w: 10, h: 10 }, { w: 0, h: 800 }, 100, 100), null);

/* ---- 4) Ausgabegröße: 1:1 CSS-Pixel, Breite gedeckelt ---- */
assert.deepStrictEqual(Object.assign({}, s.outputSize({ x: 0, y: 0, w: 360, h: 202 })), { w: 360, h: 202 });
assert.deepStrictEqual(Object.assign({}, s.outputSize({ x: 0, y: 0, w: 900, h: 500 })), { w: 480, h: 267 });
assert.strictEqual(s.outputSize({ x: 0, y: 0, w: 0, h: 10 }), null);

/* ---- 5) Konstanten: kleine Dateien, Chrome-Limit eingehalten ---- */
assert.strictEqual(s.QUALITY, 30);
assert.ok(s.CAPTURE_QUALITY >= s.QUALITY, 'Zwischenbild nicht schlechter als das Ergebnis');
assert.ok(s.SHOT_GAP_MS >= 500, 'höchstens zwei Aufnahmen je Sekunde (Chrome)');
assert.ok(s.WAIT_VISIBLE_MS >= 1000, 'Karte darf auf Sichtbarkeit warten');

console.log('test-shots: OK');
