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

/* Сброс счётчика при перезагрузке/навигации страницы YouTube: бейдж показывает
   количество сработок на текущей загрузке, а не накопительно за всё время.
   status==='loading' срабатывает на реальный reload/переход, но не на внутренние
   pushState-навигации YouTube-SPA. content.js инжектится позже (document_idle),
   поэтому сброс успевает произойти до новых инкрементов. */
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
