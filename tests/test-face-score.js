/* test-face-score.js — reine Gesichtsbewertung (extension/face-score.js).
   Prüft die Klickköder-Geometrie ohne MediaPipe: Schock vs. Lächeln,
   Mindestgröße, Blendshape-Namen und die Auswahl des stärksten Gesichts.
   Kein DOM, kein Browser, kein Netz. */
'use strict';
const assert = require('assert');
const path = require('path');
const s = require(path.join(__dirname, '..', 'extension', 'face-score.js'));

/* ---- 1) IDs und Thumbnail-URLs ---- */
assert.strictEqual(s.validVideoId('quzTROdLmU4'), true);
assert.strictEqual(s.validVideoId('kurz'), false);
assert.strictEqual(s.validVideoId('../../etc/passwd'), false);
assert.strictEqual(s.validVideoId('quzTROdLmU4\n'), false);
assert.strictEqual(s.thumbnailUrl('quzTROdLmU4'), 'https://i.ytimg.com/vi/quzTROdLmU4/mqdefault.jpg');
assert.strictEqual(s.thumbnailUrl('quzTROdLmU4', 'hqdefault'), 'https://i.ytimg.com/vi/quzTROdLmU4/hqdefault.jpg');
assert.strictEqual(s.thumbnailUrl('quzTROdLmU4', 'maxresdefault'), 'https://i.ytimg.com/vi/quzTROdLmU4/mqdefault.jpg');
assert.strictEqual(s.thumbnailUrl('bad'), '');
assert.deepStrictEqual(s.THUMB_QUALITIES, ['mqdefault', 'hqdefault']);

/* ---- 2) Blendshapes: beide Namensvarianten, fehlende Werte = 0 ---- */
const map = s.blendshapeMap([
  { categoryName: 'jawOpen', score: 0.8 },
  { displayName: 'eyeWideLeft', score: 2 },
  { categoryName: 'mouthSmileRight', score: -1 },
  null,
  { score: 0.5 }
]);
assert.strictEqual(map.jawOpen, 0.8);
assert.strictEqual(map.eyeWideLeft, 1, 'Score wird auf 0..1 begrenzt');
assert.strictEqual(map.mouthSmileRight, 0, 'negativer Score wird auf 0 begrenzt');
assert.strictEqual(s.blendshapeMap(null).jawOpen, undefined);

/* ---- 3) Bounding-Box aus Landmarken ---- */
const box = s.boxFromLandmarks([{ x: 0.2, y: 0.3 }, { x: 0.6, y: 0.8 }, { x: 0.4, y: 0.5 }]);
assert.strictEqual(box.x, 0.2);
assert.strictEqual(box.y, 0.3);
assert.ok(Math.abs(box.w - 0.4) < 1e-9);
assert.ok(Math.abs(box.h - 0.5) < 1e-9);
assert.ok(Math.abs(box.area - 0.2) < 1e-9);
assert.strictEqual(s.boxFromLandmarks([]), null);
assert.strictEqual(s.boxFromLandmarks(null), null);

/* ---- 4) Schock vs. normale Mimik ---- */
const shock = s.scoreFace({
  jawOpen: 0.9, browInnerUp: 0.9, browOuterUpLeft: 0.8, browOuterUpRight: 0.8,
  eyeWideLeft: 0.9, eyeWideRight: 0.9, mouthStretchLeft: 0.8, mouthStretchRight: 0.8,
  mouthFunnel: 0, mouthSmileLeft: 0.05, mouthSmileRight: 0.05
}, 0.5);
assert.ok(shock.score > 0.85, 'Schock muss deutlich über der Schwelle liegen: ' + shock.score);
assert.ok(shock.signals.mouth > 0.9 && shock.signals.brow > 0.9 && shock.signals.eyes > 0.9);

const neutral = s.scoreFace({}, 0.5);
assert.strictEqual(neutral.score, 0);

const talk = s.scoreFace({ jawOpen: 0.9 }, 0.5);
assert.ok(talk.score < 0.3, 'offener Mund allein (Reden/Singen) darf nicht treffen: ' + talk.score);

const browsOnly = s.scoreFace({ browInnerUp: 0.9, browOuterUpLeft: 0.9, browOuterUpRight: 0.9 }, 0.5);
assert.ok(browsOnly.score < 0.4, 'Brauen allein dürfen nicht treffen: ' + browsOnly.score);

const laugh = s.scoreFace({
  jawOpen: 0.55, browInnerUp: 0.8, browOuterUpLeft: 0.7, browOuterUpRight: 0.7,
  eyeWideLeft: 0.4, eyeWideRight: 0.4, mouthStretchLeft: 0.9, mouthStretchRight: 0.9,
  mouthSmileLeft: 0.95, mouthSmileRight: 0.95
}, 0.5);
assert.ok(laugh.score < 0.55, 'Lachen mit hochgezogenen Brauen muss gedämpft bleiben: ' + laugh.score);

const tiny = s.scoreFace({ jawOpen: 0.9, browInnerUp: 0.9, eyeWideLeft: 0.9, eyeWideRight: 0.9 }, 0.05);
assert.strictEqual(tiny.score, 0, 'Gesicht unter MIN_FACE_WIDTH ist kein Ziel');
assert.strictEqual(tiny.faceWidth, 0.05);
assert.strictEqual(s.MIN_FACE_WIDTH, 0.12);
assert.strictEqual(s.DEFAULT_THRESHOLD, 0.65);

/* ---- 5) Komplettes MediaPipe-Ergebnis: stärkstes Gesicht zählt ---- */
const bigFace = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }];
const smallFace = [{ x: 0.45, y: 0.45 }, { x: 0.5, y: 0.5 }];
const shockCats = [
  { categoryName: 'jawOpen', score: 0.9 },
  { categoryName: 'browInnerUp', score: 0.9 },
  { categoryName: 'eyeWideLeft', score: 0.9 },
  { categoryName: 'eyeWideRight', score: 0.9 }
];
const result = s.scoreResult({
  faceLandmarks: [smallFace, bigFace],
  faceBlendshapes: [{ categories: [] }, { categories: shockCats }]
});
assert.strictEqual(result.faces, 2);
assert.ok(result.score > 0.75, 'großes Schockgesicht gewinnt: ' + result.score);
assert.strictEqual(result.faceWidth, 0.6);
assert.ok(result.signals && result.signals.jaw > 0.9);

const none = s.scoreResult({ faceLandmarks: [], faceBlendshapes: [] });
assert.deepStrictEqual(JSON.parse(JSON.stringify(none)), { score: 0, faces: 0, faceWidth: 0, signals: null });

/* Ohne Blendshapes kein Score, auch wenn Landmarken da sind. */
const noShapes = s.scoreResult({ faceLandmarks: [bigFace] });
assert.strictEqual(noShapes.score, 0);
assert.strictEqual(noShapes.faces, 1);

console.log('face-score tests: OK');
