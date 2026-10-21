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
  try { importScripts('folder-store.js'); } catch (e) { /* Chrome-Ordnerwahl bleibt optional */ }
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
function shotTabIsPrivate(tab) {
  return !!(tab && (tab.incognito || tab.cookieStoreId === 'firefox-private'));
}

/* Persistenter Status des letzten Kontrollbilds. Das Popup liest ihn über
   storage.onChanged; so bleiben stille Fehlschläge (Rechte, Sichtbarkeit,
   abgebrochener Download) sichtbar, ohne die Konsole zu öffnen. */
async function recordShot(status, info) {
  const payload = Object.assign({
    at: Date.now(),
    status,
    ok: status === 'saved'
  }, info || {});
  try {
    await api.storage.local.set({ lastShot: payload });
  } catch (e) { /* Diagnose ist optional */ }
}

/* downloads.download() meldet nur den Start. Erst downloads.onChanged/search
   zeigt, ob die Datei wirklich geschrieben oder vom Browser abgebrochen wurde. */
function waitForDownload(id, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    const finish = (err, item) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { api.downloads.onChanged.removeListener(onChanged); } catch (e) { /* optional */ }
      if (err) reject(err); else resolve(item);
    };
    const inspect = async () => {
      if (done) return;
      try {
        const items = await api.downloads.search({ id });
        const item = items && items[0];
        if (!item) return;
        if (item.state === 'complete') finish(null, item);
        else if (item.state === 'interrupted') finish(new Error(item.error || 'download-interrupted'));
      } catch (e) { /* search ist nur eine Zusatzprüfung */ }
    };
    const onChanged = delta => {
      if (!delta || delta.id !== id) return;
      if (delta.state && delta.state.current === 'complete') inspect();
      else if (delta.state && delta.state.current === 'interrupted') {
        finish(new Error((delta.error && delta.error.current) || 'download-interrupted'));
      }
    };
    try { api.downloads.onChanged.addListener(onChanged); } catch (e) { /* optional */ }
    timer = setTimeout(() => {
      inspect().then(() => {
        if (!done) finish(new Error('download-timeout'));
      }, () => finish(new Error('download-timeout')));
    }, timeoutMs || 20000);
    inspect();
  });
}

async function downloadShot(dataUrl, file, options) {
  const opts = { filename: file, conflictAction: 'uniquify', saveAs: false };
  /* Private Firefox-Fenster brauchen die Zuordnung zum privaten Download-
     Kontext; sonst kann der Blob-Download am Kontext scheitern. Chrome kennt
     dieses Feld nicht und ignoriert es. */
  if (options && options.incognito && typeof browser !== 'undefined') opts.incognito = true;
  const canBlob = typeof document !== 'undefined' &&
    typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
  if (!canBlob) {
    const id = await api.downloads.download(Object.assign({ url: dataUrl }, opts));
    return { id, done: waitForDownload(id) };
  }
  const blob = await (await fetch(dataUrl)).blob();
  const url = URL.createObjectURL(blob);
  try {
    const id = await api.downloads.download(Object.assign({ url }, opts));
    return { id, done: waitForDownload(id) };
  } finally {
    /* Der Download liest die Blob-URL asynchron; deshalb erst später freigeben. */
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

function chromeBuild() {
  try {
    return !!api.runtime && api.runtime.getManifest &&
      api.runtime.getManifest().manifest_version === 3;
  } catch (e) {
    return false;
  }
}

function folderStore() {
  return chromeBuild() && self.YB && self.YB.folder && self.YB.folder.storeSupported()
    ? self.YB.folder
    : null;
}

async function shotPermission() {
  if (!api.permissions || !api.permissions.contains) return true;
  try {
    /* Chrome speichert Kontrollbilder in den einmal gewählten Ordner; dort
       wird „downloads“ nicht mehr benötigt. Firefox braucht es weiterhin. */
    if (chromeBuild()) return await api.permissions.contains({ origins: ['<all_urls>'] });
    return await api.permissions.contains({ permissions: ['downloads'], origins: ['<all_urls>'] });
  } catch (e) {
    return false;
  }
}

async function captureTabShot(tab, lib, msg) {
  if (api.tabs.captureTab) {
    /* Firefox: rect ist relativ zur Seite (nicht zum Fenster); scale 1 liefert
       CSS-Pixel statt Gerätepixel — kleinste Datei ohne Nachbearbeitung. */
    const rect = {
      x: Math.round(msg.rect.x + msg.scroll.x),
      y: Math.round(msg.rect.y + msg.scroll.y),
      width: Math.max(1, Math.round(msg.rect.w)),
      height: Math.max(1, Math.round(msg.rect.h))
    };
    return api.tabs.captureTab(tab.id, {
      rect, scale: 1, format: 'jpeg', quality: lib.QUALITY
    });
  }
  /* captureVisibleTab nimmt den aktiven Tab des Fensters auf, nicht gezielt den
     Absender. Wechselt der Nutzer während der Warteschlange den Tab, entstünde
     ein Bild der falschen Seite — daher unmittelbar vorher prüfen. */
  try {
    const current = await api.tabs.get(tab.id);
    if (!current || !current.active) return null;
  } catch (e) {
    return null;
  }
  const raw = await api.tabs.captureVisibleTab(tab.windowId, {
    format: 'jpeg', quality: lib.CAPTURE_QUALITY
  });
  return cropShot(raw, msg);
}

async function doShot(msg, sender) {
  const lib = shotsLib();
  const chrome = chromeBuild();
  const folder = folderStore();
  if (!lib || (chrome && !folder) || (!chrome && !api.downloads)) {
    return { ok: false, error: chrome ? 'folder-api' : 'downloads-api' };
  }
  const tab = sender && sender.tab;
  if (!tab || tab.id == null) return { ok: false, error: 'kein-tab' };
  if (!(await shotPermission())) return { ok: false, error: 'berechtigung-fehlt' };
  const wait = lib.SHOT_GAP_MS - (Date.now() - lastShotAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastShotAt = Date.now();

  const dataUrl = await captureTabShot(tab, lib, msg);
  if (!dataUrl) return { ok: false, error: 'nicht-aktiv' };

  const file = lib.fileName(new Date(), msg.videoId, msg.reason);
  if (folder) {
    const stored = await folder.saveOrQueue(dataUrl, file, {
      videoId: String(msg.videoId || ''),
      reason: String(msg.reason || ''),
      partial: !!msg.partial,
      incognito: shotTabIsPrivate(tab),
      source: 'auto'
    });
    if (!stored.ok && !stored.pending) return { ok: false, error: stored.error || 'folder-save' };
    console.log('[YB] Kontrollbild ' + (stored.pending ? 'vorgemerkt:' : 'gespeichert:'), stored.file || file);
    return {
      ok: true,
      file: stored.file || file,
      target: 'folder',
      pending: !!stored.pending,
      pendingId: stored.pending ? stored.id : null,
      error: stored.pending ? (stored.reason || 'no-folder') : '',
      incognito: shotTabIsPrivate(tab),
      downloadId: null
    };
  }

  const dl = await downloadShot(dataUrl, file, { incognito: shotTabIsPrivate(tab) });
  console.log('[YB] Kontrollbild gestartet:', file);
  /* Der Content wartet nur auf den Start; die Fertigstellung wird im
     Hintergrund überwacht und der Popup-Status danach aktualisiert. */
  return { ok: true, file, target: 'downloads', incognito: shotTabIsPrivate(tab), downloadId: dl.id, settle: dl.done };
}

/* Manuelle Testaufnahme aus dem Popup: prüft Rechte und Downloadweg, ohne auf
   eine passende Karte zu warten. Speichert den sichtbaren Tab als JPEG. */
async function doTestShot(msg) {
  const lib = shotsLib();
  const chrome = chromeBuild();
  const folder = folderStore();
  if (!lib || (chrome && !folder) || (!chrome && !api.downloads)) {
    return { ok: false, error: chrome ? 'folder-api' : 'downloads-api' };
  }
  if (!(await shotPermission())) return { ok: false, error: 'berechtigung-fehlt' };
  let tab = null;
  if (msg && msg.tabId != null) {
    /* Das Popup kann den gewünschten YouTube-Tab explizit mitgeben; das macht
       die Testaufnahme unabhängig vom gerade fokussierten Tab. */
    try { tab = await api.tabs.get(msg.tabId); } catch (e) { tab = null; }
  } else {
    const tabs = await api.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs && tabs[0];
  }
  if (!tab || tab.id == null) return { ok: false, error: 'kein-tab' };
  let dataUrl;
  if (api.tabs.captureTab) {
    dataUrl = await api.tabs.captureTab(tab.id, { format: 'jpeg', quality: lib.QUALITY });
  } else {
    /* Chrome nimmt immer den aktiven Tab des Fensters auf. Nicht still den
       falschen Tab fotografieren, wenn der Nutzer inzwischen gewechselt hat. */
    try {
      const current = await api.tabs.get(tab.id);
      if (!current || !current.active) return { ok: false, error: 'nicht-aktiv' };
    } catch (e) {
      return { ok: false, error: 'nicht-aktiv' };
    }
    dataUrl = await api.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg', quality: lib.CAPTURE_QUALITY
    });
  }
  if (!dataUrl) return { ok: false, error: 'aufnahme-leer' };
  const file = lib.fileName(new Date(), 'test', 'test');
  if (folder) {
    const stored = await folder.saveOrQueue(dataUrl, file, {
      videoId: 'test',
      reason: 'test',
      source: 'manual',
      incognito: shotTabIsPrivate(tab)
    });
    if (!stored.ok && !stored.pending) throw new Error('Ordner: ' + (stored.error || 'Speichern fehlgeschlagen'));
    console.log('[YB] Test-Kontrollbild ' + (stored.pending ? 'vorgemerkt:' : 'gespeichert:'), stored.file || file);
    return {
      ok: true,
      file: stored.file || file,
      target: 'folder',
      pending: !!stored.pending,
      pendingId: stored.pending ? stored.id : null,
      error: stored.pending ? (stored.reason || 'no-folder') : '',
      incognito: shotTabIsPrivate(tab),
      downloadId: null
    };
  }
  const dl = await downloadShot(dataUrl, file, { incognito: shotTabIsPrivate(tab) });
  try {
    await dl.done;
  } catch (e) {
    const error = String((e && e.message) || e);
    throw new Error('Download: ' + error);
  }
  console.log('[YB] Test-Kontrollbild gespeichert:', file);
  return { ok: true, file, target: 'downloads', incognito: shotTabIsPrivate(tab), downloadId: dl.id };
}

let folderFlushChain = Promise.resolve();

/* Nach der Ordnerfreigabe im Popup werden vorgemerkte Bilder nachgeschrieben.
   Der letzte „pending“-Status wird danach auf „saved“ gesetzt, damit das Popup
   nicht dauerhaft auf eine erledigte Freigabe wartet. */
function flushPendingShots() {
  const folder = folderStore();
  if (!folder) return Promise.resolve({ ok: false, error: 'folder-unsupported', saved: 0, pending: 0 });
  const start = () => folder.flushPending();
  const result = folderFlushChain.then(start, start);
  folderFlushChain = result.catch(() => {});
  return result.then(async res => {
    if (res && res.saved > 0) {
      try {
        const data = await api.storage.local.get('lastShot');
        const last = data && data.lastShot;
        const lastWasSaved = !last || last.pendingId == null ||
          (Array.isArray(res.savedIds) && res.savedIds.indexOf(last.pendingId) >= 0);
        if (last && last.pending && lastWasSaved) {
          await recordShot('saved', Object.assign({}, last, {
            status: 'saved',
            ok: true,
            file: res.lastSaved || last.file,
            error: null,
            pending: false,
            pendingId: null
          }));
        }
      } catch (e) { /* Status ist optional */ }
    }
    return res;
  });
}

async function runShot(msg, sender, run) {
  const base = {
    videoId: String(msg.videoId || ''),
    reason: String(msg.reason || ''),
    source: (msg.test || msg.type === 'ybshot-test') ? 'manual' : 'auto',
    visible: msg.visible !== false,
    partial: !!msg.partial,
    incognito: shotTabIsPrivate(sender && sender.tab)
  };
  try {
    const res = await run(msg, sender);
    const settle = res && res.settle;
    /* Promises dürfen nicht in der Nachrichtenantwort landen. */
    const response = Object.assign({}, res);
    if (settle) delete response.settle;
    const info = Object.assign(base, {
      incognito: response.incognito != null ? !!response.incognito : base.incognito,
      file: response.file || null,
      error: response.error || null,
      downloadId: response.downloadId || null,
      target: response.target || (folderStore() ? 'folder' : 'downloads'),
      pending: !!response.pending,
      pendingId: response.pendingId || null
    });
    if (settle && typeof settle.then === 'function') {
      settle.then(
        () => recordShot('saved', info),
        e => recordShot('failed', Object.assign({}, info, { error: String((e && e.message) || e) }))
      );
    } else if (response.pending) {
      await recordShot('pending', info);
    } else {
      await recordShot(response.ok ? 'saved' : 'failed', info);
    }
    return response;
  } catch (e) {
    const error = String((e && e.message) || e);
    await recordShot('failed', Object.assign(base, { error }));
    throw e;
  }
}

function enqueueShot(msg, sender, run) {
  const start = () => runShot(msg, sender, run || doShot);
  const result = shotChain.then(start, start);
  shotChain = result.catch(() => {});
  return result;
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
  } else if (msg.type === 'ybshot-folder-flush') {
    flushPendingShots()
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: String((e && e.message) || e), saved: 0, pending: 0 }));
    return true;
  } else if (msg.type === 'ybshot' || msg.type === 'ybshot-test') {
    /* Antwort erst nach Aufnahme und Download-Start; der Content wartet mit dem
       Ausblenden, solange das Bild noch entsteht. Die manuelle Testaufnahme
       wartet zusätzlich auf die fertige Datei, damit das Popup den echten
       Downloadfehler zeigen kann. */
    enqueueShot(msg, sender, msg.type === 'ybshot-test' ? doTestShot : doShot)
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
