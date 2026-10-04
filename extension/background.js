/* background.js — счётчики штатных сигналов и локальных скрытий */
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
