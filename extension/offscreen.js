/* offscreen.js — Brücke des Offscreen-Dokuments (nur Chrome).
   Chrome MV3: Der Service Worker kann keine Worker erzeugen, deshalb laufen
   semantic-host.js/ocr-host.js/face-host.js hier. Diese Brücke verbindet beide Welten:
   - YB_STATUS_SINK: Host-Status an den Service Worker melden (hier gibt es kein storage),
   - Nachrichten des Service Workers ({target:'offscreen'}) an host-routes.js reichen. */
'use strict';
(function () {
  const api = (typeof browser !== 'undefined') ? browser : chrome;

  /* Chrome protokolliert jede WebGPU-Anfrage als Warnung
     („Failed to create WebGPU Context Provider“), wenn kein GPU-Adapter
     bereitsteht — auch die bloße Geräteprobe. Chrome nutzt die Semantik
     deshalb ohne WebGPU direkt in Wasm; Firefox behält die WebGPU-Probe mit
     versionsgebundenem Fallback. */
  self.YB_FORCE_WASM = true;

  /* Semantik-/OCR-/Face-Host rufen das bei jedem Statuswechsel auf; der
     Service Worker schreibt den Wert nach storage.local. */
  self.YB_STATUS_SINK = (key, payload) => {
    try {
      api.runtime.sendMessage({ target: 'sw', op: 'yb-sw-storage-set', key, payload }).catch(() => {});
    } catch (e) { /* Status ist optional */ }
  };

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== 'offscreen') return;
    const route = self.YB_ROUTES && self.YB_ROUTES[msg.route];
    if (!route) { sendResponse({ ok: false, error: 'Route fehlt: ' + msg.route }); return; }
    route(msg.msg)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  });
})();
