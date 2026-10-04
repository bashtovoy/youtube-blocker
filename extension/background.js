/* background.js — счётчик срабатываний на бейдже, конфиг для сторонних скриптов */
'use strict';

const api = (typeof browser !== 'undefined') ? browser : chrome;

let cfgCache = { keywords: [], settings: {} };

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  if (msg.type === 'ybcfg') {
    cfgCache = { keywords: msg.cfg.keywords, settings: msg.cfg.settings };
  } else if (msg.type === 'ybget') {
    /* innerHTML-скрипты на странице (ytInitialData hook) запрашивают конфиг */
    sender.tab && api.tabs.sendMessage(sender.tab.id, { type: 'ybcfg-respond', cfg: cfgCache }).catch(() => {});
    return Promise.resolve(cfgCache);
  } else if (msg.type === 'ybincrement') {
    /* атомарное (в рамках одного background) наращивание счётчика */
    api.storage.local.get('blockedCount').then((d) => {
      api.storage.local.set({ blockedCount: (d.blockedCount || 0) + (msg.by || 1) });
    });
  }
});

api.storage.local.get('blockedCount').then((d) => updateBadge(d.blockedCount || 0));
api.storage.local.onChanged.addListener((changes) => {
  if (changes.blockedCount) updateBadge(changes.blockedCount.newValue || 0);
});

function updateBadge(n) {
  api.browserAction.setBadgeText({ text: n > 0 ? String(n) : '' });
  api.browserAction.setBadgeBackgroundColor({ color: '#c33' });
}
