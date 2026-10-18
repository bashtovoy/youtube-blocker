/* model-cache.js — prüft, ob der SigLIP-Modellbestand (beide Türme) bereits
   vollständig im Browser-Cache liegt (Cache API „transformers-cache", Schlüssel
   sind die HF-URLs, siehe semantic-worker.js und dtypeFor dort).
   Zweck: Statusanzeige im Popup. Nach einem Browser- oder Erweiterungsstart
   gibt es weder „ready" noch lastUsedAt — die Anzeige blieb grau, obwohl die
   Modelle ohne erneuten Download startbereit sind. Der Host meldet das Ergebnis
   als Feld „cached"; das Popup zeigt damit grün (lädt bei Bedarf in Sekunden).
   Läuft im Service Worker (Chrome, kalter Zustand) wie im Host-Kontext
   (Offscreen-Dokument bzw. Firefox-Hintergrundseite). */
(function () {
  'use strict';

  const CACHE_NAME = 'transformers-cache';
  const MODEL_MARKER = 'siglip-base-patch16-224';
  /* Dateisuffixe je dtype (transformers.js): WASM → q8 = „_quantized",
     WebGPU → q4f16 = „_q4f16" (siehe dtypeFor in semantic-worker.js). Für die
     Anzeige genügt: EIN vollständiges Turm-Paar liegt im Cache. */
  const FILE_PAIRS = [
    ['vision_model_quantized.onnx', 'text_model_quantized.onnx'],
    ['vision_model_q4f16.onnx', 'text_model_q4f16.onnx']
  ];

  async function check() {
    try {
      if (typeof caches === 'undefined') return null;
      if (!(await caches.has(CACHE_NAME))) return false;
      const urls = (await (await caches.open(CACHE_NAME)).keys()).map(k => String(k.url));
      const present = f => urls.some(u => u.indexOf(MODEL_MARKER) !== -1 && u.endsWith('/onnx/' + f));
      return FILE_PAIRS.some(pair => pair.every(present));
    } catch (e) {
      return null;   /* nicht prüfbar → Popup bleibt beim bisherigen Verhalten */
    }
  }

  self.YB_MODEL_CACHE = { check };
})();
