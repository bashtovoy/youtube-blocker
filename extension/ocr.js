/* ocr.js — Content-Client für Vorschaubild-OCR (Tesseract.js, vollständig lokal).
   Der eigentliche Worker läuft in der Background-Seite (ocr-host.js), weil
   YouTube (Trusted Types + CSP) das Erzeugen von Workern aus Content-Scripts
   blockiert. Hier bleibt nur der schlanke Messaging-Client. */
(function () {
  'use strict';

  const api = (typeof browser !== 'undefined') ? browser : chrome;
  /* Inklusive Wartezeit in der Host-Warteschlange; der erste Aufruf lädt
     Kern und Sprachdaten aus dem Paket (kein Netz) — wenige Sekunden. */
  const TIMEOUT_RECOGNIZE_MS = 60000;

  function call(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('OCR-Host: Zeitüberschreitung')),
        timeoutMs
      );
      api.runtime.sendMessage({ type: 'ybocr', ...payload })
        .then(resp => { clearTimeout(timer); resolve(resp); })
        .catch(err => { clearTimeout(timer); reject(err); });
    }).then(resp => {
      if (!resp || !resp.ok) {
        const err = new Error((resp && resp.error) || 'OCR-Host nicht erreichbar');
        if (resp && resp.fatal) err.fatal = true;
        throw err;
      }
      return resp;
    });
  }

  /* Erkennungen pro Seite serialisieren: Der Host arbeitet Anfragen der Reihe
     nach ab. Ohne diese Kette würden alle Karten gleichzeitig anfragen, die
     hinteren liefen in den Timeout und bekämen nie ein Ergebnis. */
  let ocrChain = Promise.resolve();
  function recognizeUrl(url, langs, hint) {
    const payload = { op: 'recognize', url, langs };
    /* Titel/Kanal helfen dem Host, die wahrscheinlichere Schrift zu wählen
       (Latein oder Kyrillisch), ohne beide Tesseract-Modelle zu mischen. */
    if (hint) payload.hint = String(hint);
    const run = ocrChain.then(() => call(payload, TIMEOUT_RECOGNIZE_MS));
    ocrChain = run.catch(() => {});
    return run.then(resp => resp.text || '');
  }

  window.YB = window.YB || {};
  window.YB.ocr = { recognizeUrl };
})();
