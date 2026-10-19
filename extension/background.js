/* background.js — Zähler für offizielle Signale und lokale Ausblendungen; Routing zu den Hosts.
   Firefox (MV2): semantic-host.js/ocr-host.js/host-routes.js liegen in dieser Seite —
   self.YB_ROUTES wird direkt aufgerufen.
   Chrome (MV3): Der Service Worker kann keine Worker erzeugen; die Hosts leben im
   Offscreen-Dokument (offscreen.html/offscreen.js), Anfragen gehen per runtime.sendMessage
   dorthin. Statusmeldungen des Offscreen-Dokuments kommen über {target:'sw'} zurück. */
'use strict';
const api = (typeof browser !== 'undefined') ? browser : chrome;
/* Modellbestand-Prüfung (Cache API) auch im Chrome-Service-Worker bereitstellen;
   Firefox lädt die Datei über manifest.background.scripts. */
if (typeof importScripts === 'function') {
  try { importScripts('model-cache.js'); } catch (e) { /* Status bleibt optional */ }
}
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
   ersten echten Anfrage ist schlicht noch kein Host aktiv (Zustand „aus“).
   Der Blick in den Modell-Cache sagt dem Popup, ob die Modelle trotzdem ohne
   erneuten Download startbereit sind (state „off“ + cached → grün). */
async function offStatus(route) {
  if (route === 'sem') {
    const cached = self.YB_MODEL_CACHE ? await self.YB_MODEL_CACHE.check() : null;
    return { ok: true, status: { state: 'off', device: null, error: null, initMs: 0, lastScoreMs: 0, lastUsedAt: 0, dl: null, cached } };
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
    if (msg.op === 'yb-sw-storage-get' && msg.key) {
      api.storage.local.get(msg.key).then(d => sendResponse({ value: d[msg.key] }));
      return true;   /* asynchroner Abschluss: Kanal offen halten */
    }
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

/* ---------- Verwaiste Content-Scripts in offene Tabs nachreichen ----------
   Browser ersetzen Content-Scripts in bereits geöffneten Tabs bei einem Update nicht;
   die alte Instanz verliert dabei ihren runtime-Kontext („verwaist“). Neue Wörter
   erreichen solche Tabs nie wieder — Karten bleiben bis zum manuellen Neuladen
   ungefiltert. Deshalb injizieren wir die Skriptliste aus dem Manifest in alle
   YouTube-Tabs, die sich nicht mit der laufenden Version melden (ybping).

   Geprüft wird nicht mehr nur einmal je Version: Ein manuelles Neuladen der
   Erweiterung (gleiche Version) feuert in Chrome kein onInstalled — solche Tabs
   blieben sonst bis zum manuellen F5 taub. Ein gedrosseltes Nachfassen prüft
   deshalb auch zwischendurch; eine frische Extension-Sitzung (Chrome leert
   storage.session bei Reload/Update/Neustart) löst es sofort aus. */
const CONTENT_VERSION_KEY = 'contentScriptVersion';   /* Version der letzten Prüfung */
const CONTENT_CHECKED_KEY = 'contentCheckedAt';       /* Zeitpunkt der letzten Prüfung */
const SESSION_BOOT_KEY = 'contentSessionAt';          /* Chrome: Marker der Extension-Sitzung */
const CHECK_INTERVAL_MS = 2 * 60 * 1000;              /* Nachfassen höchstens alle 2 Minuten */
const CHECK_FLOOR_MS = 30 * 1000;                     /* Notbremse gegen enge Doppelläufe */

let reinjectChain = Promise.resolve();
function reinjectStaleTabs(force) {
  reinjectChain = reinjectChain
    .then(() => doReinjectStaleTabs(force))
    .catch(e => console.warn('[YB] reinject failed:', String((e && e.message) || e)));
  return reinjectChain;
}

async function doReinjectStaleTabs(force) {
  /* In Test-/Teilumgebungen (gemocktes api) gibt es die APIs nicht — still überspringen. */
  if (!api.runtime.getManifest || !api.storage || !api.tabs) return;
  const version = api.runtime.getManifest().version;
  const now = Date.now();
  if (!force) {
    const stored = await api.storage.local.get([CONTENT_VERSION_KEY, CONTENT_CHECKED_KEY]);
    const since = now - (Number(stored[CONTENT_CHECKED_KEY]) || 0);
    if (since < CHECK_FLOOR_MS) return;   /* Notbremse: nie zweimal kurz hintereinander */
    const due = stored[CONTENT_VERSION_KEY] !== version || since >= CHECK_INTERVAL_MS;
    if (!due) {
      /* Innerhalb der Drosselzeit zählt nur eine frische Extension-Sitzung. */
      let newSession = false;
      if (api.storage.session) {
        try {
          const sess = await api.storage.session.get(SESSION_BOOT_KEY);
          newSession = !sess[SESSION_BOOT_KEY];
        } catch (e) { newSession = false; }
      }
      if (!newSession) return;
    }
  }
  /* Marker der Extension-Sitzung setzen, damit Folge-Starts die Drosselzeit einhalten. */
  if (api.storage.session) {
    try { await api.storage.session.set({ [SESSION_BOOT_KEY]: now }); } catch (e) { /* optional */ }
  }
  const cs = (api.runtime.getManifest().content_scripts || [])[0];
  const files = cs && cs.js;
  if (!Array.isArray(files) || !files.length) return;
  const tabs = await api.tabs.query({ url: ['*://*.youtube.com/*', '*://music.youtube.com/*'] });
  let injected = 0;
  for (const tab of tabs) {
    if (tab.discarded || tab.status === 'loading') continue;   /* lädt/schläft: bekommt beim Laden ohnehin frische Skripte */
    let live = '';
    try {
      const res = await api.tabs.sendMessage(tab.id, { type: 'ybping' });
      live = (res && res.version) ? String(res.version) : '';
    } catch (e) { live = ''; }     /* verwaist: die Nachricht erreicht niemanden mehr */
    if (live === version) continue;
    try {
      if (api.scripting && api.scripting.executeScript) {           /* Chrome (MV3) */
        await api.scripting.executeScript({ target: { tabId: tab.id }, files });
      } else if (api.tabs && api.tabs.executeScript) {              /* Firefox (MV2) */
        for (const file of files) await api.tabs.executeScript(tab.id, { file, runAt: 'document_idle' });
      } else {
        throw new Error('keine Injektions-API verfügbar');
      }
      injected++;
    } catch (e) { /* geschützte/verworfene Tabs: content_scripts injizieren beim nächsten Laden normal */ }
  }
  await api.storage.local.set({ [CONTENT_VERSION_KEY]: version, [CONTENT_CHECKED_KEY]: Date.now() });
  if (injected) console.log('[YB] content scripts reinjected into', injected, 'tab(s)');
}

/* Auslöser:
   - onInstalled: Update/Installation — immer erzwingen (deckt auch das Neuladen
     des temporären Add-ons in Firefox ab, bei dem die Version gleich bleibt).
     Das gemerkte „kein GPU-Adapter“-Merkmal verfällt beim Update von selbst:
     sein Wert trägt die Erweiterungsversion (semantic-host.js).
   - onStartup und Skriptstart (auch jeder MV3-Service-Worker-Start): gedrosselt —
     eine storage-Lesung, und höchstens alle CHECK_INTERVAL_MS (oder sofort in
     einer frischen Extension-Sitzung) ein Nachfassen, das verwaiste Tabs heilt. */
reinjectStaleTabs();
if (api.runtime.onInstalled) api.runtime.onInstalled.addListener(() => reinjectStaleTabs(true));
if (api.runtime.onStartup) api.runtime.onStartup.addListener(() => reinjectStaleTabs());
