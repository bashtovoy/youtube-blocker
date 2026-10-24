/* host-routes.js — gemeinsame Weitergabe der Semantik-/OCR-/Face-Anfragen an die Hosts.
   Wird geladen:
   - Firefox: im Hintergrundkontext (nach semantic-host.js/ocr-host.js/face-host.js) — direkter Aufruf.
   - Chrome MV3: im Offscreen-Dokument, in dem die Hosts leben (Service Worker können
     keine Worker erzeugen); der Service Worker reicht die Anfragen dorthin weiter.
   Darum definiert diese Datei nur self.YB_ROUTES und registriert selbst keine Listener.
   Fehlerform bleibt wie bisher: {ok:false, error, fatal?}. */
(function () {
  'use strict';

  async function sem(msg) {
    const host = self.YB_SEM_HOST;
    try {
      if (!host) throw new Error('Semantik-Host nicht geladen');
      if (msg.op === 'ensure') {
        await host.ensure(msg.texts, msg.key);
        return { ok: true };
      }
      if (msg.op === 'score') {
        return { ok: true, scores: await host.score(msg.url) };
      }
      if (msg.op === 'status') {
        return { ok: true, status: host.status() };
      }
      throw new Error('Unbekannte Semantik-Operation');
    } catch (e) {
      const err = e || {};
      return { ok: false, error: String(err.message || err), fatal: !!err.fatal };
    }
  }

  async function ocr(msg) {
    const host = self.YB_OCR_HOST;
    try {
      if (!host) throw new Error('OCR-Host nicht geladen');
      if (msg.op === 'prepare') {
        const res = await host.prepare(msg.langs);
        return { ok: true, status: res };
      }
      if (msg.op === 'recognize') {
        const res = await host.recognize(msg.url, msg.langs, msg.hint);
        return { ok: true, text: res.text, ms: res.ms, cached: !!res.cached };
      }
      if (msg.op === 'status') {
        return { ok: true, status: host.status() };
      }
      throw new Error('Unbekannte OCR-Operation');
    } catch (e) {
      const err = e || {};
      return { ok: false, error: String(err.message || err), fatal: !!err.fatal };
    }
  }

  async function face(msg) {
    const host = self.YB_FACE_HOST;
    try {
      if (!host) throw new Error('Face-Host nicht geladen');
      if (msg.op === 'prepare') {
        const res = await host.prepare();
        return { ok: true, status: res };
      }
      if (msg.op === 'score') {
        return { ok: true, result: await host.score(msg.videoId) };
      }
      if (msg.op === 'status') {
        return { ok: true, status: host.status() };
      }
      if (msg.op === 'reset') {
        host.reset();
        return { ok: true };
      }
      throw new Error('Unbekannte Face-Operation');
    } catch (e) {
      const err = e || {};
      return { ok: false, error: String(err.message || err), fatal: !!err.fatal };
    }
  }

  self.YB_ROUTES = { sem, ocr, face };
})();
