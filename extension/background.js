/* background.js — Zähler für offizielle Signale und lokale Ausblendungen; Routing zu Semantik- und OCR-Host */
'use strict';
const api = (typeof browser !== 'undefined') ? browser : chrome;
let cfgCache = { keywords: [], settings: {} };
/* Inkremente serialisieren: parallele get→set-Zyklen verloren sonst Treffer. */
let counterChain = Promise.resolve();
api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  if (msg.type === 'ybcfg') {
    cfgCache = { keywords: msg.cfg.keywords, settings: msg.cfg.settings };
  } else if (msg.type === 'ybget') {
    sender.tab && api.tabs.sendMessage(sender.tab.id, { type: 'ybcfg-respond', cfg: cfgCache }).catch(() => {});
    return Promise.resolve(cfgCache);
  } else if (msg.type === 'ybincrement') {
    const kind = msg.kind === 'dismissed' ? 'dismissedCount' : 'hiddenCount';
    const by = msg.by || 1;
    counterChain = counterChain
      .then(() => api.storage.local.get(kind))
      .then(d => api.storage.local.set({ [kind]: (d[kind] || 0) + by }))
      .catch(() => {});
  } else if (msg.type === 'ybsem') {
    return handleSemRequest(msg);
  } else if (msg.type === 'ybocr') {
    return handleOcrRequest(msg);
  }
});

/* Semantik-Anfragen aus Content-Scripts an den Worker-Host dieser Seite weiterreichen.
   Der Host lebt hier, weil YouTube (Trusted Types + CSP) das Erzeugen von Workern
   aus Content-Scripts blockiert. Siehe semantic-host.js. */
async function handleSemRequest(msg) {
  const host = self.YB_SEM_HOST;
  try {
    if (!host) throw new Error('Semantik-Host nicht geladen');
    if (msg.op === 'ensure') {
      await host.ensure(msg.texts, msg.key);
      return { ok: true };
    }
    if (msg.op === 'score') {
      return { ok: true, scores: await host.score(msg.url) };
    }
    if (msg.op === 'status') {
      return { ok: true, status: host.status() };
    }
    throw new Error('Unbekannte Semantik-Operation');
  } catch (e) {
    const err = e || {};
    return { ok: false, error: String(err.message || err), fatal: !!err.fatal };
  }
}

/* OCR-Anfragen aus Content-Scripts an den Tesseract-Host dieser Seite weiterreichen
   (gleiche Begründung wie beim Semantik-Host, siehe ocr-host.js). */
async function handleOcrRequest(msg) {
  const host = self.YB_OCR_HOST;
  try {
    if (!host) throw new Error('OCR-Host nicht geladen');
    if (msg.op === 'recognize') {
      const res = await host.recognize(msg.url, msg.langs);
      return { ok: true, text: res.text, ms: res.ms, cached: !!res.cached };
    }
    if (msg.op === 'status') {
      return { ok: true, status: host.status() };
    }
    throw new Error('Unbekannte OCR-Operation');
  } catch (e) {
    const err = e || {};
    return { ok: false, error: String(err.message || err), fatal: !!err.fatal };
  }
}

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
