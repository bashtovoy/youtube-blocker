/* face.js — Content-Client für die lokale Gesichtsprüfung.
   Die Erkennung läuft im privilegierten Host (Firefox: Background-Seite,
   Chrome: Offscreen-Dokument). Hier bleibt nur die Nachrichtenbrücke und die
   Beschriftung des Kalibrierungs-Badges. */
(function () {
  'use strict';

  const api = (typeof browser !== 'undefined') ? browser : chrome;
  const TIMEOUT_STATUS_MS = 8000;
  const TIMEOUT_PREPARE_MS = 45000;   /* erster Modellstart im Host */
  const TIMEOUT_SCORE_MS = 45000;     /* inkl. Wartezeit in der Host-Warteschlange */

  const BADGES = {
    de: {
      mark: '😱',
      aria: 'Übertriebener Gesichtsausdruck (lokal erkannt)',
      hint: 'Lokaler Face-Filter: offener Mund + gehobene Brauen/weite Augen. Nur markiert, nicht ausgeblendet.'
    },
    en: {
      mark: '😱',
      aria: 'Exaggerated facial expression (detected locally)',
      hint: 'Local face filter: open mouth + raised brows/wide eyes. Marked only, not hidden.'
    },
    ru: {
      mark: '😱',
      aria: 'Преувеличенное выражение лица (локально)',
      hint: 'Локальный фильтр лиц: открытый рот + поднятые брови/широко раскрытые глаза. Только пометка, без скрытия.'
    },
    uk: {
      mark: '😱',
      aria: 'Перебільшений вираз обличчя (локально)',
      hint: 'Локальний фільтр облич: відкритий рот + підняті брови/широко розплющені очі. Лише позначка, без приховування.'
    }
  };

  function call(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Face-Host: Zeitüberschreitung')),
        timeoutMs
      );
      let request;
      try {
        request = api.runtime.sendMessage({ type: 'ybface', ...payload });
      } catch (err) {
        /* Ein invalidierter Erweiterungskontext wirft synchron. */
        clearTimeout(timer);
        reject(err);
        return;
      }
      Promise.resolve(request)
        .then(resp => { clearTimeout(timer); resolve(resp); })
        .catch(err => { clearTimeout(timer); reject(err); });
    }).then(resp => {
      if (!resp || !resp.ok) {
        const err = new Error((resp && resp.error) || 'Face-Host nicht erreichbar');
        if (resp && resp.fatal) err.fatal = true;
        throw err;
      }
      return resp;
    });
  }

  /* Anfragen pro Seite serialisieren: Der Host arbeitet sie ohnehin der Reihe
     nach ab; ohne Kette würden die hinteren Karten in den Timeout laufen. */
  let chain = Promise.resolve();
  function score(videoId) {
    const run = chain.then(() => call({ op: 'score', videoId }, TIMEOUT_SCORE_MS));
    chain = run.catch(() => {});
    return run.then(resp => resp.result || null);
  }

  function status() {
    return call({ op: 'status' }, TIMEOUT_STATUS_MS).then(resp => resp.status || null);
  }

  function prepare() {
    return call({ op: 'prepare' }, TIMEOUT_PREPARE_MS).then(resp => resp.status || null);
  }

  function badgeText(lang) {
    return BADGES[lang] || BADGES.en;
  }

  window.YB = window.YB || {};
  window.YB.face = { score, status, prepare, badgeText };
})();
