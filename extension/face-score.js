/* face-score.js — reine Bewertung der Gesichtsgeometrie für Vorschaubilder.
   Kein DOM, kein MediaPipe: Eingabe sind die Blendshapes des Face Landmarker
   und die normalisierte Gesichtsbreite. So bleibt die Schwelle ohne Browser
   testbar und der Host enthält nur die Modell-/Bildlogik.

   Ziel ist nicht „Emotion erkennen“, sondern der typische Clickbait-Schock:
   weit offener Mund + gehobene Brauen oder weit aufgerissene Augen + ein
   Gesicht, das nicht nur ein Hintergrunddetail ist. Normale laughter/smile-
   Muster werden gedämpft, weil mouthStretch auch bei einem Lächeln hoch ist. */
(function () {
  'use strict';

  const root = (typeof self !== 'undefined') ? self : (typeof globalThis !== 'undefined' ? globalThis : this);

  const FACE_SCORE_VERSION = 'face-score-v1';
  const FACE_MODEL_VERSION = 'face-landmarker-float16-1';
  const DEFAULT_THRESHOLD = 0.65;
  const MIN_FACE_WIDTH = 0.12;   /* kleiner = Hintergrundgesicht, nicht Ziel */
  const THUMB_QUALITIES = ['mqdefault', 'hqdefault'];
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

  function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return n < 0 ? 0 : n > 1 ? 1 : n;
  }

  /* Weiche Schwelle: verhindert harte Sprünge, wenn ein Blendshape knapp
     unter/über einem Wert liegt. */
  function smoothstep(value, lo, hi) {
    if (!(hi > lo)) return clamp01(value);
    const t = clamp01((Number(value) - lo) / (hi - lo));
    return t * t * (3 - 2 * t);
  }

  function validVideoId(videoId) {
    return VIDEO_ID.test(String(videoId || ''));
  }

  function thumbnailUrl(videoId, quality) {
    const id = String(videoId || '');
    if (!validVideoId(id)) return '';
    const q = THUMB_QUALITIES.includes(quality) ? quality : THUMB_QUALITIES[0];
    return 'https://i.ytimg.com/vi/' + id + '/' + q + '.jpg';
  }

  /* MediaPipe liefert Kategorien als Array. Namen können je nach Version in
     categoryName oder displayName stehen; beides akzeptieren. */
  function blendshapeMap(categories) {
    const out = Object.create(null);
    for (const item of (Array.isArray(categories) ? categories : [])) {
      if (!item) continue;
      const name = String(item.categoryName || item.displayName || '');
      if (!name) continue;
      out[name] = clamp01(item.score);
    }
    return out;
  }

  /* Bounding-Box der Landmarken (normalisierte Koordinaten). Sie ist bewusst
     nur eine Größen- und Positionshilfe; die eigentliche Entscheidung kommt
     aus den Blendshapes. */
  function boxFromLandmarks(landmarks) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of (Array.isArray(landmarks) ? landmarks : [])) {
      const x = Number(p && p.x);
      const y = Number(p && p.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!(maxX >= minX) || !(maxY >= minY)) return null;
    return {
      x: minX,
      y: minY,
      w: Math.max(0, maxX - minX),
      h: Math.max(0, maxY - minY),
      area: Math.max(0, maxX - minX) * Math.max(0, maxY - minY)
    };
  }

  /* Kernbewertung. faceWidth = Breite der Gesichts-BBox / Bildbreite.
     Rückgabe ist ein roher Score 0..1; die Schwelle setzt der Content. */
  function scoreFace(blendshapes, faceWidth) {
    const bs = (blendshapes && typeof blendshapes === 'object') ? blendshapes : {};
    const g = name => clamp01(bs[name]);
    const avg = (a, b) => (g(a) + g(b)) / 2;

    const width = Number(faceWidth);
    if (!Number.isFinite(width) || width < MIN_FACE_WIDTH) {
      return {
        score: 0,
        faceWidth: Number.isFinite(width) ? Math.max(0, width) : 0,
        signals: {
          jaw: 0, brow: 0, eyes: 0, mouth: 0, stretch: 0, funnel: 0, smile: 0
        }
      };
    }

    const jaw = smoothstep(g('jawOpen'), 0.25, 0.75);
    const browRaw = 0.6 * g('browInnerUp') +
      0.2 * g('browOuterUpLeft') + 0.2 * g('browOuterUpRight');
    const brow = smoothstep(browRaw, 0.15, 0.65);
    const eyes = smoothstep(avg('eyeWideLeft', 'eyeWideRight'), 0.15, 0.60);
    const stretch = smoothstep(avg('mouthStretchLeft', 'mouthStretchRight'), 0.25, 0.75);
    const funnel = smoothstep(g('mouthFunnel'), 0.25, 0.70);
    const smile = smoothstep(avg('mouthSmileLeft', 'mouthSmileRight'), 0.35, 0.80);

    const mouth = Math.max(jaw, 0.85 * stretch, 0.8 * funnel);
    const upper = Math.max(brow, eyes);

    /* Kookkurrenz statt Summe: Mund allein ist Reden/Singen, obere Mimik
       allein ist Stirnrunzeln. Erst beides zusammen ist der Shock-Marker. */
    const co = (mouth >= 0.45 ? 1 : 0) + (upper >= 0.45 ? 1 : 0);
    const gate = co === 2 ? 1 : co === 1 ? 0.35 : 0;

    const raw = 0.50 * mouth + 0.30 * brow + 0.20 * eyes;
    const size = 0.6 + 0.4 * smoothstep(width, 0.12, 0.40);
    const smilePenalty = 0.45 * smile;

    const score = clamp01(raw * gate * size * (1 - smilePenalty));
    return {
      score,
      faceWidth: width,
      signals: {
        jaw: Number(jaw.toFixed(4)),
        brow: Number(brow.toFixed(4)),
        eyes: Number(eyes.toFixed(4)),
        mouth: Number(mouth.toFixed(4)),
        stretch: Number(stretch.toFixed(4)),
        funnel: Number(funnel.toFixed(4)),
        smile: Number(smile.toFixed(4))
      }
    };
  }

  /* Komplettes MediaPipe-Ergebnis: pro erkanntem Gesicht eine BBox und die
     Blendshapes. Wir nehmen den höchsten Score; die Größe dämpft kleine
     Hintergrundgesichter bereits in scoreFace(). */
  function scoreResult(result) {
    const faces = Array.isArray(result && result.faceLandmarks) ? result.faceLandmarks : [];
    const shapes = Array.isArray(result && result.faceBlendshapes) ? result.faceBlendshapes : [];
    if (!faces.length || !shapes.length) {
      return { score: 0, faces: faces.length || shapes.length || 0, faceWidth: 0, signals: null };
    }
    let best = null;
    const count = Math.min(faces.length, shapes.length);
    for (let i = 0; i < count; i++) {
      const box = boxFromLandmarks(faces[i]);
      if (!box) continue;
      const categories = shapes[i] && shapes[i].categories;
      const item = scoreFace(blendshapeMap(categories), box.w);
      const candidate = Object.assign({ face: i, box }, item);
      if (!best || candidate.score > best.score) best = candidate;
    }
    if (!best) return { score: 0, faces: count, faceWidth: 0, signals: null };
    return {
      score: best.score,
      faces: count,
      faceWidth: Number(best.faceWidth.toFixed(4)),
      signals: best.signals
    };
  }

  const api = {
    FACE_SCORE_VERSION,
    FACE_MODEL_VERSION,
    DEFAULT_THRESHOLD,
    MIN_FACE_WIDTH,
    THUMB_QUALITIES,
    validVideoId,
    thumbnailUrl,
    blendshapeMap,
    boxFromLandmarks,
    scoreFace,
    scoreResult
  };

  root.YB_FACE_SCORE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
