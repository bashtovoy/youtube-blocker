/* offscreen.js — Brücke des Offscreen-Dokuments (nur Chrome).
   Chrome MV3: Der Service Worker kann keine Worker erzeugen, deshalb laufen
   semantic-host.js/ocr-host.js hier. Diese Brücke verbindet beide Welten:
   - YB_STATUS_SINK: semStatus an den Service Worker melden (hier gibt es kein storage),
   - Nachrichten des Service Workers ({target:'offscreen'}) an host-routes.js reichen. */
'use strict';
(function () {
  const api = (typeof browser !== 'undefined') ? browser : chrome;

  /* semantic-host.js ruft das bei jedem Statuswechsel auf; der Service Worker
     schreibt den Wert nach storage.local. */
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
