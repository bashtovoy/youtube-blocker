/* shots.js — Kontrollbilder vor dem Ausblenden (reine Hilfsfunktionen).
   Wird im Content-Skript (Bereich der Karte, Sichtbarkeit) und im Hintergrund
   (Dateiname, Zuschnitt des Chrome-Screenshots) geladen. Keine DOM-Zugriffe:
   alle Funktionen sind testbar ohne Browser. */
(function () {
  'use strict';

  const root = (typeof self !== 'undefined') ? self : window;

  /* Minimalqualität: Die Dateien dienen der Kontrolle, nicht dem Archiv.
     JPEG q30 ergibt je nach Karte etwa 3–25 KB. */
  const QUALITY = 30;            /* gespeichertes JPEG (0–100) */
  const CAPTURE_QUALITY = 60;    /* Zwischenbild des ganzen Tabs (Chrome) */
  const MAX_WIDTH = 480;         /* Obergrenze der gespeicherten Breite in CSS-Pixeln */
  const SHOT_GAP_MS = 550;       /* Chrome erlaubt höchstens 2 captureVisibleTab je Sekunde */
  const WAIT_VISIBLE_MS = 8000;  /* so lange darf ein Ausblenden auf die sichtbare Karte warten */

  /* Grund → kurzer ASCII-Code im Dateinamen. Unbekannte Gründe landen als „other“. */
  const REASON_CODES = {
    'ai-generated': 'ai',
    'members-only': 'members',
    promo: 'promo',
    title: 'title',
    channel: 'channel',
    'semantic-image': 'semantic',
    semantic: 'semantic',
    ocr: 'ocr',
    speech: 'speech',
    test: 'test'
  };

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  /* Der Grund kann einen Suchbegriff tragen („title:foo“) — im Dateinamen steht
     nur der Kanal, damit der Name kurz und ohne Sonderzeichen bleibt. */
  function reasonCode(reason) {
    const base = String(reason || '').split(':')[0];
    return REASON_CODES[base] || 'other';
  }

  function sanitizeId(videoId) {
    const id = String(videoId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
    return id || 'slot';
  }

  function dayKey(date) {
    const d = date || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function timeKey(date) {
    const d = date || new Date();
    return pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  /* Unterordner der Browser-Downloads: „YouTube Blocker/JJJJ-MM-TT/HHMMSS_id_grund.jpg“.
     Mehr ist ohne Dateidialog nicht möglich — Erweiterungen schreiben nur dorthin. */
  function fileName(date, videoId, reason) {
    return 'YouTube Blocker/' + dayKey(date) + '/' + timeKey(date) + '_' +
      sanitizeId(videoId) + '_' + reasonCode(reason) + '.jpg';
  }

  function overlaps(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }

  /* Sichtbarer Teil einer Karte, auf das Fenster beschnitten. Feste Balken
     (Masthead/Guide) werden abgezogen, damit im Notfallbild kein fremder
     Seiteninhalt landet. Wird nur verwendet, wenn eine Karte nach
     WAIT_VISIBLE_MS noch teilweise verdeckt/abgeschnitten ist. */
  function visiblePart(card, viewport, blockers) {
    if (!card || !viewport) return null;
    let x = Math.max(0, card.x);
    let y = Math.max(0, card.y);
    let right = Math.min(viewport.w, card.x + card.w);
    let bottom = Math.min(viewport.h, card.y + card.h);
    if (!(right - x >= 8) || !(bottom - y >= 8)) return null;
    for (const b of (blockers || [])) {
      if (!b || !(b.w > 0) || !(b.h > 0)) continue;
      if (!overlaps({ x, y, w: right - x, h: bottom - y }, b)) continue;
      const candidates = [
        { x, y, w: right - x, h: Math.min(bottom, b.y) - y },
        { x, y: Math.max(y, b.y + b.h), w: right - x, h: bottom - Math.max(y, b.y + b.h) },
        { x, y, w: Math.min(right, b.x) - x, h: bottom - y },
        { x: Math.max(x, b.x + b.w), y, w: right - Math.max(x, b.x + b.w), h: bottom - y }
      ].filter(r => r.w >= 8 && r.h >= 8);
      if (!candidates.length) return null;
      candidates.sort((a, c) => (c.w * c.h) - (a.w * a.h));
      const best = candidates[0];
      x = best.x;
      y = best.y;
      right = best.x + best.w;
      bottom = best.y + best.h;
    }
    return { x, y, w: right - x, h: bottom - y };
  }

  /* Vollständig sichtbar heißt: die ganze Karte liegt im Fenster und wird von
     keinem festen Balken (Masthead) verdeckt. Nur dann ist der Screenshot ein
     vollständiges Bild der Karte. card/blocker: {x,y,w,h} in Fensterkoordinaten. */
  function fullyVisible(card, viewport, blockers) {
    if (!card || !viewport) return false;
    if (!(card.w > 0) || !(card.h > 0)) return false;
    if (card.x < 0 || card.y < 0) return false;
    if (card.x + card.w > viewport.w + 0.5 || card.y + card.h > viewport.h + 0.5) return false;
    for (const b of (blockers || [])) {
      if (b && b.w > 0 && b.h > 0 && overlaps(card, b)) return false;
    }
    return true;
  }

  /* Chrome liefert den ganzen sichtbaren Tab in Gerätepixeln. Daraus den
     Ausschnitt der Karte in Bildpixeln berechnen. */
  function cropPixels(card, viewport, imageW, imageH) {
    if (!card || !viewport || !(viewport.w > 0) || !(viewport.h > 0)) return null;
    if (!(imageW > 0) || !(imageH > 0)) return null;
    const kx = imageW / viewport.w;
    const ky = imageH / viewport.h;
    const sx = Math.round(Math.max(0, card.x) * kx);
    const sy = Math.round(Math.max(0, card.y) * ky);
    const sw = Math.min(imageW - sx, Math.round(card.w * kx));
    const sh = Math.min(imageH - sy, Math.round(card.h * ky));
    if (!(sw > 0) || !(sh > 0)) return null;
    return { sx, sy, sw, sh };
  }

  /* Ausgabegröße in CSS-Pixeln (1:1, höchstens MAX_WIDTH breit). */
  function outputSize(card) {
    if (!card || !(card.w > 0) || !(card.h > 0)) return null;
    const w = Math.max(1, Math.min(Math.round(card.w), MAX_WIDTH));
    const h = Math.max(1, Math.round(card.h * w / card.w));
    return { w, h };
  }

  root.YB = root.YB || {};
  root.YB.shots = {
    QUALITY,
    CAPTURE_QUALITY,
    MAX_WIDTH,
    SHOT_GAP_MS,
    WAIT_VISIBLE_MS,
    reasonCode,
    sanitizeId,
    fileName,
    visiblePart,
    fullyVisible,
    cropPixels,
    outputSize
  };
})();
