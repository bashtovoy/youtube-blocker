/* background.js — Zähler für offizielle Signale und lokale Ausblendungen */
'use strict';
const api = (typeof browser !== 'undefined') ? browser : chrome;
let cfgCache = { keywords: [], settings: {} };
api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  if (msg.type === 'ybcfg') {
    cfgCache = { keywords: msg.cfg.keywords, settings: msg.cfg.settings };
  } else if (msg.type === 'ybget') {
    sender.tab && api.tabs.sendMessage(sender.tab.id, { type: 'ybcfg-respond', cfg: cfgCache }).catch(() => {});
    return Promise.resolve(cfgCache);
  } else if (msg.type === 'ybincrement') {
    const kind = msg.kind === 'dismissed' ? 'dismissedCount' : 'hiddenCount';
    api.storage.local.get(kind).then(d => api.storage.local.set({ [kind]: (d[kind] || 0) + (msg.by || 1) }));
  }
});
api.storage.local.get(['dismissedCount', 'hiddenCount']).then(d => updateBadge((d.dismissedCount || 0) + (d.hiddenCount || 0)));
api.storage.local.onChanged.addListener(changes => {
  if (changes.dismissedCount || changes.hiddenCount) {
    api.storage.local.get(['dismissedCount', 'hiddenCount']).then(d => updateBadge((d.dismissedCount || 0) + (d.hiddenCount || 0)));
  }
});
function updateBadge(n) { api.browserAction.setBadgeText({ text: n > 0 ? String(n) : '' }); }

/* Zähler bei Neuladen/Navigieren der YouTube-Seite zurücksetzen: Das Badge zeigt
   die Treffer der aktuellen Seitensession, nicht aufsummiert über die gesamte Zeit.
   status==='loading' feuert bei echtem Reload/Übergang, aber nicht bei internen
   pushState-Navigationen der YouTube-SPA. content.js wird später injiziert (document_idle),
   daher erfolgt das Zurücksetzen rechtzeitig vor neuen Inkrementen. */
function isYoutubeUrl(u) {
  try {
    const h = new URL(u).hostname;
    return h === 'youtube.com' || h.endsWith('.youtube.com');
  } catch (e) { return false; }
}
api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && isYoutubeUrl(tab.url || changeInfo.url || '')) {
    api.storage.local.set({ dismissedCount: 0, hiddenCount: 0 });
  }
});
