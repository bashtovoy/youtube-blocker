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
  try { importScripts('shots.js'); } catch (e) { /* Kontrollbilder bleiben optional */ }
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
  return {
    ok: true,
    status: {
      state: 'off', ready: false, loading: false, langs: [], loadingLangs: [],
      stage: '', stageLang: '', progress: 0, error: null, cached: 0
    }
  };
}

async function callHost(route, msg) {
  if (self.YB_ROUTES && self.YB_ROUTES[route]) return self.YB_ROUTES[route](msg);   /* Firefox */
  if (msg.op === 'status' && !(await offscreenExists())) return offStatus(route);   /* Chrome, noch kalt */
  return offscreenCall(route, msg);                                                 /* Chrome, Hosts im Offscreen */
}

/* ---------- Kontrollbilder vor dem Ausblenden ----------
   Der Content schickt den Rahmen der Karte; hier wird der Tab aufgenommen, auf
   die Karte zugeschnitten (Chrome) bzw. direkt beschnitten (Firefox) und als
   JPEG unter „Downloads/YouTube Blocker/JJJJ-MM-TT/…“ abgelegt. Sequenziell,
   weil Chrome nur zwei Aufnahmen je Sekunde erlaubt. */
let shotChain = Promise.resolve();
let lastShotAt = 0;

function shotsLib() { return self.YB && self.YB.shots; }

async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
  }
  return 'data:' + blob.type + ';base64,' + btoa(bin);
}

/* Chrome: captureVisibleTab liefert den ganzen Tab. Ausschnitt der Karte
   herausschneiden und auf CSS-Größe verkleinern — das spart die meiste Dateigröße. */
async function cropShot(dataUrl, msg) {
  const lib = shotsLib();
  if (!lib) throw new Error('shots.js fehlt');
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  try {
    const crop = lib.cropPixels(msg.rect, msg.viewport, bmp.width, bmp.height);
    if (!crop) throw new Error('Kartenrahmen außerhalb des Bildes');
    const out = lib.outputSize(msg.rect);
    if (!out) throw new Error('Kartengröße unbrauchbar');
    const canvas = new OffscreenCanvas(out.w, out.h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas nicht verfügbar');
    ctx.drawImage(bmp, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, out.w, out.h);
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: lib.QUALITY / 100 });
    return await blobToDataUrl(jpeg);
  } finally {
    if (bmp.close) bmp.close();
  }
}

/* Firefox lehnt data:-URLs in downloads.download ab („Access denied for URL“).
   Dort eine Blob-URL der Hintergrundseite verwenden; Chrome akzeptiert data:-URLs,
   kennt aber im Service Worker kein URL.createObjectURL. */
async function downloadShot(dataUrl, file) {
  const canBlob = typeof document !== 'undefined' &&
    typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
  if (!canBlob) {
    await api.downloads.download({ url: dataUrl, filename: file, conflictAction: 'uniquify', saveAs: false });
    return;
  }
  const blob = await (await fetch(dataUrl)).blob();
  const url = URL.createObjectURL(blob);
  try {
    await api.downloads.download({ url, filename: file, conflictAction: 'uniquify', saveAs: false });
  } finally {
    /* Der Download liest die Blob-URL asynchron; deshalb erst später freigeben. */
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

async function doShot(msg, sender) {
  const lib = shotsLib();
  if (!lib || !api.downloads) return { ok: false, error: 'downloads-api' };
  const tab = sender && sender.tab;
  if (!tab || tab.id == null) return { ok: false, error: 'kein-tab' };
  /* Beide optionalen Berechtigungen werden erst beim Einschalten im Popup erteilt. */
  if (api.permissions && api.permissions.contains) {
    const allowed = await api.permissions.contains({ permissions: ['downloads'], origins: ['<all_urls>'] });
    if (!allowed) return { ok: false, error: 'berechtigung-fehlt' };
  }
  const wait = lib.SHOT_GAP_MS - (Date.now() - lastShotAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastShotAt = Date.now();

  let dataUrl;
  if (api.tabs.captureTab) {
    /* Firefox: rect ist relativ zur Seite (nicht zum Fenster); scale 1 liefert
       CSS-Pixel statt Gerätepixel — kleinste Datei ohne Nachbearbeitung. */
    const rect = {
      x: Math.round(msg.rect.x + msg.scroll.x),
      y: Math.round(msg.rect.y + msg.scroll.y),
      width: Math.max(1, Math.round(msg.rect.w)),
      height: Math.max(1, Math.round(msg.rect.h))
    };
    dataUrl = await api.tabs.captureTab(tab.id, {
      rect, scale: 1, format: 'jpeg', quality: lib.QUALITY
    });
  } else {
    /* captureVisibleTab nimmt den aktiven Tab des Fensters auf, nicht gezielt den
       Absender. Wechselt der Nutzer während der Warteschlange den Tab, entstünde
       ein Bild der falschen Seite — daher unmittelbar vorher prüfen. */
    try {
      const current = await api.tabs.get(tab.id);
      if (!current || !current.active) return { ok: false, error: 'nicht-aktiv' };
    } catch (e) {
      return { ok: false, error: 'tab-weg' };
    }
    const raw = await api.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg', quality: lib.CAPTURE_QUALITY
    });
    dataUrl = await cropShot(raw, msg);
  }
  if (!dataUrl) return { ok: false, error: 'aufnahme-leer' };

  const file = lib.fileName(new Date(), msg.videoId, msg.reason);
  await downloadShot(dataUrl, file);
  console.log('[YB] Kontrollbild gespeichert:', file);
  return { ok: true, file };
}

function enqueueShot(msg, sender) {
  const run = shotChain.then(() => doShot(msg, sender), () => doShot(msg, sender));
  shotChain = run.catch(() => {});
  return run;
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
  } else if (msg.type === 'ybshot') {
    /* Antwort erst nach Aufnahme und Download; der Content wartet mit dem
       Ausblenden, solange das Bild noch entsteht. */
    enqueueShot(msg, sender)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
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
