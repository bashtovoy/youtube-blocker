/* background.js — Zähler für offizielle Signale und lokale Ausblendungen; Routing zu den Hosts.
   Firefox (MV2): semantic-host.js/ocr-host.js/host-routes.js liegen in dieser Seite —
   self.YB_ROUTES wird direkt aufgerufen.
   Chrome (MV3): Der Service Worker kann keine Worker erzeugen; die Hosts leben im
   Offscreen-Dokument (offscreen.html/offscreen.js), Anfragen gehen per runtime.sendMessage
   dorthin. Statusmeldungen des Offscreen-Dokuments kommen über {target:'sw'} zurück. */
'use strict';
const api = (typeof browser !== 'undefined') ? browser : chrome;
/* MV3 heißt der Knopf "action", Firefox MV2 "browserAction" — beide Bäume bedienen. */
const actionApi = api.action || api.browserAction;
let cfgCache = { keywords: [], settings: {} };
/* Inkremente serialisieren: parallele get→set-Zyklen verloren sonst Treffer. */
let counterChain = Promise.resolve();

/* ---------- Chrome: Offscreen-Dokument mit den Hosts ---------- */

let offscreenCreating = null;

async function offscreenExists() {
  if (!api.offscreen || !api.runtime.getContexts) return false;
  try {
    const contexts = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  } catch (e) { return false; }
}

async function ensureOffscreen() {
  if (await offscreenExists()) return;
  if (!offscreenCreating) {
    offscreenCreating = api.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Lokale WASM-Worker (SigLIP, Tesseract) ausführen — der Service Worker kann keine Worker erzeugen'
    }).catch(e => {
      /* Race: parallel wurde doch schon eines erstellt — kein Fehler. */
      if (!/single offscreen|already exists/i.test(String((e && e.message) || e))) throw e;
    }).finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

/* Die erste Nachricht kann eintreffen, bevor die Skripte des frisch erstellten
   Dokuments laufen — kurz wiederholen. Alle Operationen sind idempotent. */
async function offscreenCall(route, msg) {
  await ensureOffscreen();
  let lastErr = null;
  for (let i = 0; i < 25; i++) {
    try {
      const res = await api.runtime.sendMessage({ target: 'offscreen', route, msg });
      if (res !== undefined) return res;
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Offscreen-Dokument nicht erreichbar' + (lastErr ? ': ' + lastErr.message : ''));
}

/* Statusabfragen beantworten, ohne das Offscreen-Dokument zu starten: Vor der
   ersten echten Anfrage ist schlicht noch kein Host aktiv (Zustand „aus“). */
function offStatus(route) {
  if (route === 'sem') {
    return { ok: true, status: { state: 'off', device: null, error: null, initMs: 0, lastScoreMs: 0, lastUsedAt: 0, dl: null } };
  }
  return { ok: true, status: { ready: false, langs: null, cached: 0 } };
}

async function callHost(route, msg) {
  if (self.YB_ROUTES && self.YB_ROUTES[route]) return self.YB_ROUTES[route](msg);   /* Firefox */
  if (msg.op === 'status' && !(await offscreenExists())) return offStatus(route);   /* Chrome, noch kalt */
  return offscreenCall(route, msg);                                                 /* Chrome, Hosts im Offscreen */
}

/* ---------- Nachrichtenrouting ---------- */

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  /* Meldungen aus dem Offscreen-Dokument (dort gibt es keinen storage-Zugriff). */
  if (msg.target === 'sw') {
    if (msg.op === 'yb-sw-storage-set' && msg.key) api.storage.local.set({ [msg.key]: msg.payload });
    return;
  }
  if (msg.type === 'ybcfg') {
    cfgCache = { keywords: msg.cfg.keywords, settings: msg.cfg.settings };
  } else if (msg.type === 'ybget') {
    sender.tab && api.tabs.sendMessage(sender.tab.id, { type: 'ybcfg-respond', cfg: cfgCache }).catch(() => {});
    sendResponse(cfgCache);
  } else if (msg.type === 'ybincrement') {
    const kind = msg.kind === 'dismissed' ? 'dismissedCount' : 'hiddenCount';
    const by = msg.by || 1;
    counterChain = counterChain
      .then(() => api.storage.local.get(kind))
      .then(d => api.storage.local.set({ [kind]: (d[kind] || 0) + by }))
      .catch(() => {});
  } else if (msg.type === 'ybsem' || msg.type === 'ybocr') {
    /* Antwort via sendResponse + return true: das erwartet Chrome von asynchronen
       Listenern; Firefox akzeptiert diese Form ebenfalls. sendResponse hält den
       Kanal offen — wichtig für lange Erstbezüge (ensure lädt die Modelle). */
    callHost(msg.type === 'ybsem' ? 'sem' : 'ocr', msg)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
});

api.storage.local.get(['dismissedCount', 'hiddenCount']).then(d => updateBadge((d.dismissedCount || 0) + (d.hiddenCount || 0)));
api.storage.onChanged.addListener(changes => {
  if (changes.dismissedCount || changes.hiddenCount) {
    api.storage.local.get(['dismissedCount', 'hiddenCount']).then(d => updateBadge((d.dismissedCount || 0) + (d.hiddenCount || 0)));
  }
});
function updateBadge(n) { actionApi.setBadgeText({ text: n > 0 ? String(n) : '' }); }

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
