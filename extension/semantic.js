/* semantic.js — Content-Client für lokales SigLIP-Matching: Text → Bild.
   Der eigentliche Worker läuft in der Background-Seite (semantic-host.js), weil
   YouTube (Trusted Types + CSP) das Erzeugen von Workern aus Content-Scripts
   blockiert. Hier bleibt nur der schlanke Messaging-Client. */
(function () {
  'use strict';

  const api = (typeof browser !== 'undefined') ? browser : chrome;
  const MODEL_DIR = 'models/siglip-base-patch16-224/';
  const TIMEOUT_ENSURE_MS = 45000;   /* erster Treffer lädt das Modell im Host */
  const TIMEOUT_SCORE_MS = 60000;    /* inkl. Wartezeit in der Host-Warteschlange */

  function call(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Semantik-Host: Zeitüberschreitung')),
        timeoutMs
      );
      api.runtime.sendMessage({ type: 'ybsem', ...payload })
        .then(resp => { clearTimeout(timer); resolve(resp); })
        .catch(err => { clearTimeout(timer); reject(err); });
    }).then(resp => {
      if (!resp || !resp.ok) {
        const err = new Error((resp && resp.error) || 'Semantik-Host nicht erreichbar');
        if (resp && resp.fatal) err.fatal = true;
        throw err;
      }
      return resp;
    });
  }

  async function init() {
    const resp = await call({ op: 'status' }, 5000);
    return resp.status;
  }

  async function setTexts(texts) {
    await call({ op: 'ensure', texts, key: (texts || []).join('\u0001') }, TIMEOUT_ENSURE_MS);
    return texts;
  }

  /* Scores pro Seite serialisieren: Der Host arbeitet Anfragen der Reihe nach ab.
     Ohne diese Kette würden alle Karten gleichzeitig anfragen, die hinteren liefen
     in den Timeout und bekämen nie ein Ergebnis. */
  let scoreChain = Promise.resolve();
  function scoreImage(source) {
    const run = scoreChain.then(() => call({ op: 'score', url: source }, TIMEOUT_SCORE_MS));
    scoreChain = run.catch(() => {});
    return run.then(resp => resp.scores || []);
  }

  /* Kontrastive Entscheidung (docs/SEMANTIC_FILTER_ROUTING.md, Punkt 3):
     margin = Kosinus des Zielkonzepts − bester Kosinus der Konkurrenz.
     Konkurrenten sind die übrigen Konzepte derselben Liste. Synonyme bzw.
     Übersetzungen desselben Begriffs (z. B. Drone/Dron) können sich daher
     gegenseitig drücken — die Diagnoseausgabe in content.js zeigt das.
     Kein Sigmoid-Schwellwert mehr; der rohe Kosinus ist die Basis. */
  function marginDecision(scores, threshold) {
    const list = (scores || []).filter(s => s && s.text && Number.isFinite(s.cos));
    if (!list.length) return null;
    const min = Number.isFinite(Number(threshold)) ? Number(threshold) : 0.1;
    let best = null;
    for (const item of list) {
      let refCos = -Infinity, refText = null;
      for (const other of list) {
        if (other === item) continue;
        if (other.cos > refCos) { refCos = other.cos; refText = other.text; }
      }
      const margin = refText === null ? item.cos : item.cos - refCos;
      if (!best || margin > best.margin) {
        best = { text: item.text, cos: item.cos, refText, refCos, margin };
      }
    }
    return best && best.margin >= min ? best : null;
  }

  window.YB = window.YB || {};
  window.YB.semantic = {
    modelDir: MODEL_DIR,
    init,
    setTexts,
    scoreImage,
    marginDecision
  };
})();
