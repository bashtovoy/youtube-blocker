/* test-shots.js — Kontrollbilder vor dem Ausblenden (extension/shots.js).
   Prüft: Dateiname (Datum/Uhrzeit/Kennung/vollständiger Grund, ASCII),
   Sichtbarkeit der Karte inklusive verdeckendem Masthead, Zuschnitt des
   Chrome-Screenshots und die Ausgabegröße. Kein Browser, kein Netz,
   keine Dateien. */
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');

const sandbox = { window: {}, self: {}, console };
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'shots.js'), 'utf8'), sandbox);
const s = sandbox.YB && sandbox.YB.shots;
assert.ok(s, 'shots.js muss YB.shots exportieren');

/* ---- 1) Dateiname: lokale Zeit, Unterordner je Tag, vollständiger Grund ---- */
const d = new Date(2026, 9, 20, 16, 30, 15);
assert.strictEqual(s.fileName(d, 'quzTROdLmU4', 'ai-generated'),
  'YouTube Blocker/2026-10-20/163015_quzTROdLmU4_ai-generated.jpg');
assert.strictEqual(s.fileName(d, 'quzTROdLmU4', 'members-only'),
  'YouTube Blocker/2026-10-20/163015_quzTROdLmU4_members-only.jpg');
assert.strictEqual(s.fileName(d, 'quzTROdLmU4', 'promo'),
  'YouTube Blocker/2026-10-20/163015_quzTROdLmU4_promo.jpg');
assert.strictEqual(s.fileName(new Date(2026, 0, 2, 3, 4, 5), '', 'promo'),
  'YouTube Blocker/2026-01-02/030405_slot_promo.jpg', 'Werbeplatz ohne Video-Kennung');

/* Gründe mit Suchbegriff: Der Begriff steht jetzt im Namen. */
assert.strictEqual(s.fileName(d, 'abcdefghijk', 'title:foo'),
  'YouTube Blocker/2026-10-20/163015_abcdefghijk_title_foo.jpg');
assert.strictEqual(s.fileName(d, 'abcdefghijk', 'channel:bar'),
  'YouTube Blocker/2026-10-20/163015_abcdefghijk_channel_bar.jpg');
assert.strictEqual(s.fileName(d, 'abcdefghijk', 'semantic-image:baz'),
  'YouTube Blocker/2026-10-20/163015_abcdefghijk_semantic-image_baz.jpg');
assert.strictEqual(s.fileName(d, 'abcdefghijk', 'ocr:x'),
  'YouTube Blocker/2026-10-20/163015_abcdefghijk_ocr_x.jpg');
assert.strictEqual(s.fileName(d, 'abcdefghijk', 'speech:y'),
  'YouTube Blocker/2026-10-20/163015_abcdefghijk_speech_y.jpg');
assert.strictEqual(s.fileName(d, 'test', 'test'), 'YouTube Blocker/2026-10-20/163015_test_test.jpg');
assert.strictEqual(s.fileName(d, 'abcdefghijk', 'unknown'),
  'YouTube Blocker/2026-10-20/163015_abcdefghijk_other_unknown.jpg',
  'unbekannter Grund wird ausgeschrieben');

/* Kyrillisch und deutsche Umlaute werden für den Dateinamen umgeschrieben. */
assert.strictEqual(s.fileName(d, 'abcdefghijk', 'title:война'),
  'YouTube Blocker/2026-10-20/163015_abcdefghijk_title_voyna.jpg');
assert.strictEqual(s.fileName(d, 'abcdefghijk', 'title:ПВО'),
  'YouTube Blocker/2026-10-20/163015_abcdefghijk_title_pvo.jpg');
assert.strictEqual(s.fileName(d, 'abcdefghijk', 'channel:Müller'),
  'YouTube Blocker/2026-10-20/163015_abcdefghijk_channel_mueller.jpg');
assert.strictEqual(s.fileName(d, 'abcdefghijk', 'title:ракеты и дроны'),
  'YouTube Blocker/2026-10-20/163015_abcdefghijk_title_rakety_i_drony.jpg');

/* Fremde Zeichen (Pfadtrenner, Punkte, Leerzeichen) dürfen nicht in den Namen. */
assert.strictEqual(s.sanitizeId('../../etc/passwd'), 'etcpasswd');
assert.strictEqual(s.sanitizeId('a b/c'), 'abc');
assert.strictEqual(s.sanitizeId(''), 'slot');
assert.strictEqual(s.fileName(d, 'abcdefghijk', 'title:../../etc/passwd'),
  'YouTube Blocker/2026-10-20/163015_abcdefghijk_title_etc_passwd.jpg',
  'Pfadtrenner im Suchbegriff werden zu Unterstrichen');
assert.ok(s.fileName(d, 'a/b\\c:d*e?f', 'ai-generated').indexOf('a/b') === -1, 'keine Pfadtrenner in der Kennung');
assert.ok(/^[\x20-\x7E]+$/.test(s.fileName(d, 'ümlaut', 'ai-generated')), 'Dateiname bleibt ASCII');
assert.ok(/^[\x20-\x7E]+$/.test(s.fileName(d, 'ümlaut', 'title:война')), 'auch kyrillische Gründe bleiben ASCII');
/* Sehr langer Suchbegriff wird gedeckelt, aber nicht abgeschnitten mitten im Nichts. */
const longReason = s.fileName(d, 'abcdefghijk', 'title:' + 'x'.repeat(200));
assert.ok(longReason.length < 120, 'Dateiname bleibt kurz genug: ' + longReason);
assert.strictEqual(s.reasonPart(''), 'other');
assert.strictEqual(s.reasonCode('title:foo'), 'title', 'Kurzcode bleibt für die Diagnose erhalten');

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

/* ---- 2b) Teilweise sichtbar: sichtbarer Ausschnitt für die Notlösung ---- */
assert.deepStrictEqual(Object.assign({}, s.visiblePart({ x: -10, y: 700, w: 400, h: 200 }, vp)),
  { x: 0, y: 700, w: 390, h: 100 }, 'links und unten beschnitten');
assert.deepStrictEqual(Object.assign({}, s.visiblePart({ x: 900, y: 60, w: 300, h: 200 }, vp)),
  { x: 900, y: 60, w: 100, h: 200 }, 'rechts beschnitten');
assert.strictEqual(s.visiblePart({ x: 100, y: 900, w: 360, h: 200 }, vp), null, 'ganz unterhalb');
assert.strictEqual(s.visiblePart({ x: 1200, y: 100, w: 360, h: 200 }, vp), null, 'ganz rechts');
assert.strictEqual(s.visiblePart({ x: 0, y: 0, w: 7, h: 200 }, vp), null, 'zu schmal');
assert.strictEqual(s.visiblePart(card, vp).y, 100);
/* Masthead und Guide werden aus dem Notfallbild herausgeschnitten. */
assert.deepStrictEqual(Object.assign({}, s.visiblePart({ x: 100, y: 20, w: 360, h: 200 }, vp,
  [{ x: 0, y: 0, w: 1000, h: 56 }])), { x: 100, y: 56, w: 360, h: 164 }, 'Masthead oben');
assert.deepStrictEqual(Object.assign({}, s.visiblePart({ x: 100, y: 100, w: 360, h: 200 }, vp,
  [{ x: 0, y: 0, w: 120, h: 800 }])), { x: 120, y: 100, w: 340, h: 200 }, 'Guide links');
assert.strictEqual(s.visiblePart({ x: 100, y: 60, w: 360, h: 200 }, vp,
  [{ x: 0, y: 0, w: 1000, h: 800 }]), null, 'vollständig verdeckt');

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
