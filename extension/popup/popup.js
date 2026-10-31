/* popup.js — Verwaltung der Begriffsliste und Einstellungen */
'use strict';

const api = (typeof browser !== 'undefined') ? browser : chrome;
const $ = id => document.getElementById(id);
const i18n = YB.i18n;
const t = (key, vars) => i18n.t(key, vars);
console.log('[popup] import via tab v3 loaded');  /* Markierung: fehlt sie in der Konsole, läuft im Browser noch ein alter Build */
$('ver').textContent = 'v' + api.runtime.getManifest().version;  /* sichtbare Build-Nummer im Kopfbereich */

const SETTING_IDS = ['enabled', 'checkTitle', 'checkSemanticImage', 'checkThumbOcr', 'checkSpeech', 'hideMembersOnly', 'hideLiveStreams', 'hideAiGenerated', 'hidePromoted', 'shotBeforeHide'];
/* uiLang gehört zu den Werten, wird beim Laden aber gesondert behandelt
   (ohne gespeicherte Wahl gilt beim ersten Öffnen die Browsersprache). */
const VALUE_IDS = ['uiLang', 'mode', 'ocrLangs', 'semanticMargin', 'actionDelayMs', 'speechLang', 'speechModel', 'speechMaxSeconds', 'hashThreshold', 'aiChannelMode', 'faceMode', 'faceThreshold', 'videoQuality'];
const FACE_MODES = ['off', 'mark', 'hide'];

const DEFAULT_SETTINGS = {
  enabled: true,
  checkTitle: true,
  checkSemanticImage: true,
  checkThumbOcr: false,
  checkSpeech: false,
  faceMode: 'off',
  faceThreshold: 0.65,
  videoQuality: 'hd1080',
  hideMembersOnly: false,
  hideLiveStreams: false,
  hideAiGenerated: true,
  aiChannelMode: 'off',
  hidePromoted: true,
  shotBeforeHide: false,
  mode: 'dismiss',
  ocrLangs: 'eng+rus',
  hashThreshold: 8,
  semanticMargin: 0.03,
  actionDelayMs: 2500,
  speechLang: 'ru',
  speechModel: 'models/ggml-base.bin',
  speechMaxSeconds: 120
};

/* Importe aus älteren Versionen können Zahlfelder als leeren String enthalten.
   Number('') ist 0 — das würde z. B. die Pause zwischen Signalen abschalten. */
function numberOr(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const qualityRules = globalThis.YBQualityRules || null;

function normalizeVideoQuality(value) {
  return qualityRules
    ? qualityRules.normalize(value, qualityRules.DEFAULT_QUALITY)
    : 'hd1080';
}

function qualityLabel(value) {
  if (value === 'auto') return t('quality_auto');
  if (value === 'off') return t('quality_off');
  if (value === 'max') return t('quality_max');
  return qualityRules ? qualityRules.labelOf(value) : String(value || '');
}

let lexicon = [];    /* [{ id, label, enabled, route, prompt, variants, exceptions }] */
let lastSemStatus = null;   /* für Neu-Beschriftung beim Sprachwechsel */
let counts = { dis: 0, hid: 0 };   /* Kopfzeile: YouTube-Signale / lokale Ausblendungen */
let lastShot = null;  /* letzter Aufnahmeversuch aus storage.local */
let lastQualityStatus = null;   /* Status aus der MAIN-World (quality.js) */
let qualityStatusTimer = null;
let qualityStatusBusy = false;
let qualityStatusTabId = null;
let qualityMissingTicks = 0;

/* Status des Semantik-Hosts (semantic-host.js speichert unter „semStatus“):
   zeigt, ob die Modelle bereit sind bzw. der einmalige Erstbezug läuft.
   Liefert Text, Farbklasse und Balkenmodus (none | det | indet). */
function semStatusView(st) {
  if (!st) return { text: t('sem_idle'), cls: '', bar: 'none', pct: 0 };   /* noch nie gelaufen → Hinweistext statt leerer Zeile */
  if (st.state === 'error') {
    return { text: t('sem_error', { msg: st.error || t('unknown') }), cls: 'err', bar: 'none', pct: 0 };
  }
  if (st.state === 'ready') {
    return { text: '✓ ' + t('sem_ready', { device: st.device === 'webgpu' ? 'WebGPU' : 'WASM' }), cls: 'ok', bar: 'none', pct: 0 };
  }
  if (st.state === 'loading') {
    const d = st.dl;
    if (d && d.total > 0) {
      const mb = n => (n / 1048576).toFixed(0);
      const pct = Math.max(2, Math.min(100, Number(d.progress) || 0));
      return { text: t('sem_loading', { p: Math.round(d.progress), loaded: mb(d.loaded), total: mb(d.total) }), cls: '', bar: 'det', pct };
    }
    return { text: t('sem_preparing'), cls: '', bar: 'indet', pct: 0 };
  }
  /* „off“ mit cached: Dateien liegen im Browser-Cache (z. B. direkt nach dem
     Browserstart) — kein Erstbezug mehr nötig, Modell startet bei Bedarf. */
  if (st.state === 'off' && st.cached) {
    return { text: t('sem_cached'), cls: '', bar: 'none', pct: 0 };
  }
  return { text: t('sem_idle'), cls: '', bar: 'none', pct: 0 };
}

function renderSemStatus(st) {
  lastSemStatus = st;
  const el = $('semModelStatus');
  if (el) {
    const v = semStatusView(st);
    el.textContent = v.text;
    el.classList.toggle('ok', v.cls === 'ok');
    el.classList.toggle('err', v.cls === 'err');
    const bar = $('semProgress');
    const fill = $('semProgressFill');
    if (bar && fill) {
      bar.hidden = v.bar === 'none';
      bar.classList.toggle('indeterminate', v.bar === 'indet');
      fill.style.width = v.bar === 'det' ? v.pct + '%' : '';
    }
  }
  renderStats();
}

/* ---- Statusindikatoren der Kanäle im Bereich „Was geprüft wird“ ----
   grüner Haken = aktiv und einsatzbereit; grauer Ring = aus oder noch nicht
   vorbereitet; blaue Punkte = lädt gerade; rotes „!“ = Fehler.
   Die Checkboxen bleiben reine Einstellungen. */
let ocrStatus = null;          /* letzter Status des OCR-Hosts */
let ocrPollTimer = null;       /* Popup offen halten, solange OCR lädt */
let ocrPrepareRequest = null;  /* laufende prepare-Anfrage */
let ocrPrepareKey = '';        /* Sprachsatz der laufenden Anfrage */
let faceStatus = null;         /* letzter Status des Face-Hosts */
let facePollTimer = null;      /* Popup offen halten, solange das Modell lädt */
let facePrepareRequest = null; /* laufende prepare-Anfrage */
let whisperState = 'pending';  /* pending | ok | missing — siehe checkWhisper() */
let whisperChecked = false;    /* Bibliothek nur einmal je Popup-Öffnung prüfen */
let shotsPermOk = null;        /* null = noch nicht geprüft */

const STAT_GLYPH = { ok: '✓', wait: '…', err: '!', off: '○', pending: '○' };

function setStat(id, cls, titleKey) {
  const el = $(id);
  if (!el) return;
  el.textContent = STAT_GLYPH[cls] || '○';
  el.className = 'stat ' + cls;
  el.title = t(titleKey);
}

function renderStats() {
  const on = id => $(id).checked;
  /* Kanäle ohne Modell/Netzabhängigkeit: laufen, sobald aktiviert */
  setStat('statTitle', on('checkTitle') ? 'ok' : 'off', on('checkTitle') ? 'stat_ok' : 'stat_off');
  setStat('statMembersOnly', on('hideMembersOnly') ? 'ok' : 'off', on('hideMembersOnly') ? 'stat_ok' : 'stat_off');
  setStat('statLive', on('hideLiveStreams') ? 'ok' : 'off', on('hideLiveStreams') ? 'stat_ok' : 'stat_off');
  setStat('statAi', on('hideAiGenerated') ? 'ok' : 'off', on('hideAiGenerated') ? 'stat_ok' : 'stat_off');
  setStat('statPromoted', on('hidePromoted') ? 'ok' : 'off', on('hidePromoted') ? 'stat_ok' : 'stat_off');

  /* Semantik: Live-Status des Hosts (Modelle bereit / laden / Fehler).
     „off“ mit lastUsedAt = Worker wurde nach Leerlauf bewusst beendet;
     „off“ mit cached = Modelldateien liegen im Browser-Cache (z. B. nach
     Browserstart/Update) — in beiden Fällen startbereit → grün. */
  let sem = ['pending', 'stat_pending'];
  if (!on('checkSemanticImage')) sem = ['off', 'stat_off'];
  else if (lastSemStatus && lastSemStatus.state === 'ready') sem = ['ok', 'stat_ok'];
  else if (lastSemStatus && lastSemStatus.state === 'off' && (lastSemStatus.lastUsedAt || lastSemStatus.cached)) sem = ['ok', 'stat_ok_idle'];
  else if (lastSemStatus && lastSemStatus.state === 'loading') sem = ['wait', 'stat_wait'];
  else if (lastSemStatus && lastSemStatus.state === 'error') sem = ['err', 'stat_err'];
  setStat('statSemanticImage', sem[0], sem[1]);

  /* OCR: der Host meldet Laden/Bereit/Fehler; das Popup fragt während des
     Ladens nach, damit der Fortschritt nicht nur ein einmaliger Schnappschuss ist. */
  let ocr = ['pending', 'stat_pending'];
  if (!on('checkThumbOcr')) ocr = ['off', 'stat_off'];
  else if (ocrStatus && ocrStatus.state === 'loading') ocr = ['wait', 'stat_wait'];
  else if (ocrStatus && ocrStatus.state === 'error') ocr = ['err', 'stat_err'];
  else if (ocrStatus && ocrStatus.state === 'ready') ocr = ['ok', 'stat_ok'];
  setStat('statOcr', ocr[0], ocr[1]);

  /* Gesichter: eigenes MediaPipe-Modell. „off“ mit assets/lastUsedAt heißt
     bereit auf Abruf (die Dateien liegen im Paket), nicht abgeschaltet. */
  let face = ['pending', 'stat_pending'];
  const faceModeEl = $('faceMode');
  if (!faceModeEl || faceModeEl.value === 'off') face = ['off', 'stat_off'];
  else if (faceStatus && faceStatus.state === 'loading') face = ['wait', 'stat_wait'];
  else if (faceStatus && faceStatus.state === 'error') face = ['err', 'stat_err'];
  else if (faceStatus && faceStatus.state === 'ready') face = ['ok', 'stat_ok'];
  else if (faceStatus && faceStatus.state === 'off' && (faceStatus.lastUsedAt || faceStatus.assets)) face = ['ok', 'stat_ok_idle'];
  setStat('statFace', face[0], face[1]);

  /* Sprache: Whisper-Bibliothek installiert? (Modelldatei wird nicht geprüft) */
  let sp = ['pending', 'stat_pending'];
  if (!on('checkSpeech')) sp = ['off', 'stat_off'];
  else if (whisperState === 'ok') sp = ['ok', 'stat_ok'];
  else if (whisperState === 'missing') sp = ['pending', 'stat_speech_missing'];
  setStat('statSpeech', sp[0], sp[1]);

  /* Kontrollbilder: eingeschaltet, aber Berechtigung fehlt/entzogen → rot;
     solange die Prüfung läuft, nicht vorschnell grün anzeigen. */
  if ($('statShots')) {
    let sh = ['off', 'stat_off'];
    if (on('shotBeforeHide')) {
      if (shotsPermOk === false) sh = ['err', 'shots_perm_missing'];
      else if (shotsPermOk === null) sh = ['pending', 'stat_pending'];
      else sh = ['ok', 'stat_ok'];
    }
    setStat('statShots', sh[0], sh[1]);
  }
}

/* ---- OCR-Modell: sichtbar vorbereiten und Status anzeigen -------------------
   Die PaddleOCR-Modelle liegen lokal im Paket; „laden“ heißt hier: SDK,
   ONNX-Runtime und die ausgewählten Erkenner initialisieren. Das passiert
   automatisch beim Öffnen des Popups, sobald OCR aktiviert ist. Währenddessen
   fragt das Popup den Host regelmäßig nach dem Status; nach Erfolg/Fehler
   hört die Abfrage auf. */
function ocrStatusView(st) {
  if (!st) return { text: t('ocr_idle'), cls: '', bar: 'none', pct: 0 };
  if (st.state === 'error') {
    return { text: t('ocr_error', { msg: st.error || t('unknown') }), cls: 'err', bar: 'none', pct: 0 };
  }
  if (st.state === 'loading') {
    const lang = (st.loadingLangs && st.loadingLangs[0]) || st.stageLang || '';
    const text = lang ? t('ocr_loading_lang', { lang }) : t('ocr_loading');
    const pct = Number(st.progress) || 0;
    return pct > 0
      ? { text, cls: '', bar: 'det', pct: Math.max(2, Math.min(100, pct)) }
      : { text, cls: '', bar: 'indet', pct: 0 };
  }
  if (st.state === 'ready') {
    const langs = (st.langs || []).join(', ');
    return { text: t('ocr_ready', { langs: langs || 'eng' }), cls: 'ok', bar: 'none', pct: 0 };
  }
  return { text: t('ocr_idle'), cls: '', bar: 'none', pct: 0 };
}

function renderOcrStatus() {
  const block = $('ocrBlock');
  if (!block) return;
  const enabled = $('checkThumbOcr').checked;
  block.hidden = !enabled;
  if (!enabled) return;
  const v = ocrStatusView(ocrStatus);
  const text = $('ocrModelStatus');
  if (text) {
    text.textContent = v.text;
    text.classList.toggle('ok', v.cls === 'ok');
    text.classList.toggle('err', v.cls === 'err');
  }
  const bar = $('ocrProgress');
  const fill = $('ocrProgressFill');
  if (bar && fill) {
    bar.hidden = v.bar === 'none';
    bar.classList.toggle('indeterminate', v.bar === 'indet');
    fill.style.width = v.bar === 'det' ? v.pct + '%' : '';
  }
  const btn = $('ocrPrepare');
  if (btn) {
    const busy = ocrStatus && ocrStatus.state === 'loading';
    btn.hidden = busy || !!(ocrStatus && ocrStatus.state === 'ready');
    btn.disabled = busy;
    btn.textContent = t(ocrStatus && ocrStatus.state === 'error' ? 'ocr_retry' : 'ocr_prepare');
  }
}

function stopOcrPoll() {
  if (ocrPollTimer) clearTimeout(ocrPollTimer);
  ocrPollTimer = null;
}

function scheduleOcrPoll() {
  stopOcrPoll();
  if (!$('checkThumbOcr').checked) return;
  if (ocrStatus && (ocrStatus.state === 'ready' || ocrStatus.state === 'error')) return;
  ocrPollTimer = setTimeout(refreshOcrStatus, 700);
}

async function refreshOcrStatus() {
  try {
    const res = await api.runtime.sendMessage({ type: 'ybocr', op: 'status' });
    if (res && res.ok && res.status) ocrStatus = res.status;
    else ocrStatus = { state: 'error', error: (res && res.error) || t('unknown') };
  } catch (e) {
    ocrStatus = { state: 'error', error: String((e && e.message) || e) };
  }
  renderStats();
  renderOcrStatus();
  scheduleOcrPoll();
}

function prepareOcr() {
  if (!$('checkThumbOcr').checked) { stopOcrPoll(); renderOcrStatus(); return; }
  const langs = $('ocrLangs').value || 'eng+rus';
  /* Sofort als „lädt“ anzeigen; die Wahrheit kommt anschließend vom Host. */
  if (!ocrStatus || ocrStatus.state !== 'loading') {
    ocrStatus = { state: 'loading', loadingLangs: langs.split('+'), progress: 0 };
  }
  renderStats();
  renderOcrStatus();
  stopOcrPoll();
  ocrPollTimer = setTimeout(refreshOcrStatus, 250);
  if (ocrPrepareRequest && ocrPrepareKey === langs) return;
  ocrPrepareKey = langs;
  ocrPrepareRequest = api.runtime.sendMessage({ type: 'ybocr', op: 'prepare', langs })
    .then(res => {
      if (res && res.ok && res.status) ocrStatus = res.status;
      else if (res && !res.ok) ocrStatus = { state: 'error', error: res.error || t('unknown') };
      return refreshOcrStatus();
    })
    .catch(e => {
      stopOcrPoll();
      ocrStatus = { state: 'error', error: String((e && e.message) || e) };
      renderStats();
      renderOcrStatus();
    })
    .finally(() => {
      if (ocrPrepareKey === langs) {
        ocrPrepareRequest = null;
        ocrPrepareKey = '';
      }
    });
}

/* ---- Face-Modell: Status und Vorbereitung ----------------------------------
   Das Modell liegt lokal unter lib/mediapipe/. Beim Einschalten des Kanals
   startet das Popup die Initialisierung im Host und zeigt den Zustand; die
   eigentliche Bildarbeit läuft später im Content/Host. */
function faceStatusView(st) {
  if (!st) return { text: t('face_idle'), cls: '' };
  if (st.state === 'error') {
    return { text: t('face_error', { msg: st.error || t('unknown') }), cls: 'err' };
  }
  if (st.state === 'loading') return { text: t('face_loading'), cls: '' };
  if (st.state === 'ready') {
    const ms = Math.round(Number(st.lastScoreMs || st.initMs || 0));
    return { text: t('face_ready', { ms: ms > 0 ? ms : '—' }), cls: 'ok' };
  }
  if (st.state === 'off' && st.lastUsedAt) return { text: t('face_cached'), cls: '' };
  return { text: t('face_idle'), cls: '' };
}

function renderFaceStatus() {
  const block = $('faceBlock');
  if (!block) return;
  const enabled = $('faceMode').value !== 'off';
  block.hidden = !enabled;
  if (!enabled) return;
  const v = faceStatusView(faceStatus);
  const text = $('faceModelStatus');
  if (text) {
    text.textContent = v.text;
    text.classList.toggle('ok', v.cls === 'ok');
    text.classList.toggle('err', v.cls === 'err');
  }
  const btn = $('facePrepare');
  if (btn) {
    const busy = faceStatus && faceStatus.state === 'loading';
    btn.hidden = busy || !!(faceStatus && faceStatus.state === 'ready');
    btn.disabled = busy;
    btn.textContent = t(faceStatus && faceStatus.state === 'error' ? 'face_retry' : 'face_prepare');
  }
  renderStats();
}

function stopFacePoll() {
  if (facePollTimer) clearTimeout(facePollTimer);
  facePollTimer = null;
}

function scheduleFacePoll() {
  stopFacePoll();
  if ($('faceMode').value === 'off') return;
  if (faceStatus && (faceStatus.state === 'ready' || faceStatus.state === 'error')) return;
  facePollTimer = setTimeout(refreshFaceStatus, 700);
}

async function refreshFaceStatus() {
  try {
    const res = await api.runtime.sendMessage({ type: 'ybface', op: 'status' });
    if (res && res.ok && res.status) faceStatus = res.status;
    else faceStatus = { state: 'error', error: (res && res.error) || t('unknown') };
  } catch (e) {
    faceStatus = { state: 'error', error: String((e && e.message) || e) };
  }
  renderStats();
  renderFaceStatus();
  scheduleFacePoll();
}

function prepareFace() {
  if ($('faceMode').value === 'off') {
    stopFacePoll();
    renderFaceStatus();
    return;
  }
  /* Auch bei gespeichertem „ready“ den Host fragen: Nach einem Browserstart
     ist der Status in storage veraltet, das Modell aber noch nicht geladen. */
  /* Sofort als „lädt“ anzeigen; die Wahrheit kommt anschließend vom Host. */
  if (!faceStatus || faceStatus.state !== 'loading') faceStatus = { state: 'loading' };
  renderStats();
  renderFaceStatus();
  stopFacePoll();
  facePollTimer = setTimeout(refreshFaceStatus, 250);
  if (facePrepareRequest) return;
  facePrepareRequest = api.runtime.sendMessage({ type: 'ybface', op: 'prepare' })
    .then(res => {
      if (res && res.ok && res.status) faceStatus = res.status;
      else if (res && !res.ok) faceStatus = { state: 'error', error: res.error || t('unknown') };
      return refreshFaceStatus();
    })
    .catch(e => {
      stopFacePoll();
      faceStatus = { state: 'error', error: String((e && e.message) || e) };
      renderStats();
      renderFaceStatus();
    })
    .finally(() => { facePrepareRequest = null; });
}

/* ---- Kontrollbilder: optionale Berechtigungen -------------------------------
   Aufnehmen des Tabs verlangt <all_urls>, Speichern „downloads“. Beide werden
   erst beim Einschalten angefragt — wer die Funktion nie nutzt, sieht keinen
   Hinweis und keine Installationswarnung. */
function folderApi() {
  return YB.folder && YB.folder.storeSupported() ? YB.folder : null;
}

function folderMode() {
  return !!(folderApi() && YB.folder.pickerSupported());
}

function shotPermissionRequest() {
  return folderMode()
    ? { origins: ['<all_urls>'] }
    : { permissions: ['downloads'], origins: ['<all_urls>'] };
}

function renderShotsPerm() {
  const warn = $('shotsPerm');
  if (!warn) return;
  warn.hidden = !($('shotBeforeHide').checked && shotsPermOk === false);
}

async function checkShotsPermission() {
  if (!api.permissions || !api.permissions.contains) {
    shotsPermOk = false;
    renderShotsPerm();
    renderStats();
    return;
  }
  try {
    shotsPermOk = await api.permissions.contains(shotPermissionRequest());
  } catch (e) {
    shotsPermOk = false;
  }
  renderShotsPerm();
  renderStats();
}

function folderReason(reason) {
  if (reason === 'no-folder') return t('folder_reason_none');
  if (reason === 'permission') return t('folder_reason_permission');
  if (reason === 'write') return t('folder_reason_write');
  return reason || t('unknown');
}

/* Status des Chrome-Screenshotordners. Wahl und Freigabe laufen auf
   folder-access.html (nur ein echter Tab zeigt den Chrome-Dialog); das Popup
   zeigt den Status, schreibt wartende Bilder nach und öffnet die Einrichtung. */
async function renderFolderStatus(extra) {
  const box = $('shotsFolder');
  if (!box) return;
  const folder = folderApi();
  if (!folder || !folderMode()) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  let st;
  try {
    st = await folder.getStatus();
  } catch (e) {
    st = { name: '', permission: 'denied', pending: 0 };
  }
  const choose = $('shotsFolderChoose');
  const grant = $('shotsFolderGrant');
  const status = $('shotsFolderStatus');
  if (choose) choose.textContent = st.name ? t('folder_change') : t('folder_choose');
  if (grant) grant.hidden = !(st.name && st.permission !== 'granted');
  const hint = $('shotsFolderHint');
  if (hint) hint.hidden = !(st.name && st.permission !== 'granted');

  let text;
  if (!st.name) text = t('folder_none');
  else if (st.permission === 'granted') text = t('folder_ready', { name: st.name });
  else if (st.permission === 'prompt') text = t('folder_permission', { name: st.name });
  else text = t('folder_denied', { name: st.name });
  if (st.pending) text += ' · ' + t('folder_pending', { n: st.pending });
  if (extra) text += ' · ' + extra;
  if (status) status.textContent = text;
}

/* Ordnerwahl und Freigabe laufen auf folder-access.html: Nur ein echter Tab
   zeigt den Chrome-Dialog, und nur dort lässt sich „Bei jedem Besuch
   erlauben“ wählen. Das Popup zeigt den Status und öffnet für die Einrichtung
   die Seite; wartende Bilder schreibt es weiterhin selbst nach. */
function openFolderAccess() {
  return Promise.resolve(api.tabs.create({ url: api.runtime.getURL('folder-access.html') }))
    .catch(() => null);
}

async function ensureFolderForTest() {
  if (!folderMode()) return true;
  const st = await folderApi().getStatus();
  if (st.name && st.permission === 'granted') return true;
  status(t('folder_setup_needed'), false);
  await openFolderAccess();
  return false;
}

/* Wartende Bilder werden direkt im Popup nachgeschrieben: Nur hier gilt die
   soeben erteilte Ordnerfreigabe sicher; der Service Worker sieht sie womöglich
   nicht. Parallele Aufrufe (Klick und Auto-Nachschreiben beim Öffnen) laufen
   über eine Kette, damit die Warteschlange nicht doppelt abgearbeitet wird. */
let folderFlushChain = Promise.resolve();

function queueLocalFlush(folder) {
  const start = () => folder.flushPending();
  const result = folderFlushChain.then(start, start);
  folderFlushChain = result.catch(() => {});
  return result;
}

async function flushShotFolder() {
  const folder = folderApi();
  try {
    let res;
    if (folder) {
      res = await queueLocalFlush(folder);
      if (res && res.saved) {
        /* Statuspflege des Hintergrunds nachziehen (lastShot/recordShot liegen dort). */
        api.runtime.sendMessage({
          type: 'ybshot-folder-note',
          saved: res.saved,
          savedIds: res.savedIds,
          lastSaved: res.lastSaved
        }).catch(() => { /* Status ist optional */ });
      }
    } else {
      res = await api.runtime.sendMessage({ type: 'ybshot-folder-flush' });
    }
    await renderFolderStatus();
    if (res && res.saved) status(t('folder_flushed', { n: res.saved }));
    else if (res && res.failed) status(t('folder_error', { msg: t('folder_reason_write') }), false);
    else if (res && res.reason === 'permission') status(t('folder_flush_permission'), false);
    else if (res && res.error) status(t('folder_error', { msg: String(res.error) }), false);
    return res;
  } catch (e) {
    await renderFolderStatus();
    status(t('folder_error', { msg: String((e && e.message) || e) }), false);
    return null;
  }
}

$('shotsFolderChoose').onclick = () => {
  openFolderAccess();
};

$('shotsFolderGrant').onclick = () => {
  openFolderAccess();
};

function shortFile(file) {
  return String(file || '').split('/').pop();
}

function shotTime(ts) {
  const d = new Date(Number(ts));
  if (!Number.isFinite(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/* Letzten Aufnahmeversuch im Popup anzeigen. Damit sind auch stille Fälle
   sichtbar: Karte nicht vollständig im Bild, fehlende Rechte, Downloadfehler. */
function renderLastShot() {
  const el = $('lastShotStatus');
  if (!el) return;
  el.className = 'hint';
  el.title = '';
  if (!lastShot) {
    el.textContent = t('shots_last_none');
    return;
  }
  const time = shotTime(lastShot.at);
  const file = shortFile(lastShot.file);
  const privateTag = lastShot.incognito ? ' · ' + t('shots_private') : '';
  const partialTag = lastShot.partial ? ' · ' + t('shots_partial') : '';
  if (lastShot.status === 'pending') {
    el.textContent = t('shots_last_pending', {
      time,
      msg: folderReason(lastShot.error)
    }) + partialTag + privateTag;
    return;
  }
  if (lastShot.status === 'saved' || lastShot.ok) {
    el.textContent = t('shots_last_saved', { time, file: file || '—' }) + partialTag + privateTag;
    el.title = lastShot.file || '';
    el.classList.add('ok');
    return;
  }
  if (lastShot.status === 'skipped') {
    const reason = lastShot.error === 'nicht-sichtbar' || !lastShot.error
      ? t('shots_skip_not_visible')
      : lastShot.error;
    el.textContent = t('shots_last_skipped', { time, msg: reason }) + privateTag;
    return;
  }
  el.textContent = t('shots_last_failed', { time, msg: lastShot.error || t('unknown') }) + partialTag + privateTag;
  el.classList.add('err');
}

/* Whisper-Bibliothek einmalig prüfen: setup.sh setzt ohne Download nur eine
   Platzhalterdatei mit wenigen Zeilen ab; eine echte Bibliothek ist viel größer. */
function checkWhisper() {
  if (whisperChecked) return;
  whisperChecked = true;
  fetch(api.runtime.getURL('lib/whisper.js'))
    .then(r => (r && r.ok ? r.text() : ''))
    .then(txt => { whisperState = (txt && txt.length > 500) ? 'ok' : 'missing'; renderStats(); })
    .catch(() => { whisperState = 'missing'; renderStats(); });
}

api.storage.onChanged.addListener(changes => {
  if (changes.semStatus) renderSemStatus(changes.semStatus.newValue);
  if (changes.faceStatus) { faceStatus = changes.faceStatus.newValue || null; renderStats(); renderFaceStatus(); }
  if (changes.promoSuspects) {
    promoSuspects = Array.isArray(changes.promoSuspects.newValue) ? changes.promoSuspects.newValue : [];
    renderPromoDiag();
  }
  if (changes.lastShot) {
    lastShot = changes.lastShot.newValue || null;
    renderLastShot();
  }
  if (changes.hiddenCount || changes.dismissedCount) {
    counts = {
      dis: changes.dismissedCount ? (changes.dismissedCount.newValue || 0) : counts.dis,
      hid: changes.hiddenCount ? (changes.hiddenCount.newValue || 0) : counts.hid
    };
    renderCounts();
  }
});

function renderCounts() {
  $('blocked').textContent = (counts.dis || counts.hid)
    ? t('counter_yt_local', { dis: counts.dis, hid: counts.hid })
    : '';
}

function qualityTabInfo(url) {
  try {
    const u = new URL(url);
    if (!qualityRules || !qualityRules.isQualityHost(u.hostname)) return 'unsupported';
    return qualityRules.isWatchPath(u.pathname) ? 'watch' : 'not-watch';
  } catch (e) {
    return 'unsupported';
  }
}

/* Der Status kommt aus dem Content-Skript; quality.js schreibt ihn in ein
   DOM-Attribut. Das Popup fragt ihn beim Öffnen und danach jede Sekunde ab,
   damit Qualitätswechsel und manuelle Auswahl sichtbar werden. */
async function refreshQualityStatus() {
  if (qualityStatusBusy) return;
  qualityStatusBusy = true;
  try {
    const setting = normalizeVideoQuality($('videoQuality') ? $('videoQuality').value : DEFAULT_SETTINGS.videoQuality);
    if (setting === 'off') {
      lastQualityStatus = { mode: 'off' };
      qualityStatusTabId = null;
      qualityMissingTicks = 0;
      renderQualityStatus();
      return;
    }
    let tab = null;
    try {
      [tab] = await api.tabs.query({ active: true, currentWindow: true });
    } catch (e) {
      tab = null;
    }
    if (!tab) {
      lastQualityStatus = { mode: 'unsupported' };
      renderQualityStatus();
      return;
    }
    if (qualityStatusTabId !== tab.id) {
      qualityStatusTabId = tab.id;
      qualityMissingTicks = 0;
      lastQualityStatus = null;
    }
    const info = qualityTabInfo(tab.url || '');
    if (info === 'unsupported') {
      lastQualityStatus = { mode: 'unsupported' };
      renderQualityStatus();
      return;
    }
    if (info === 'not-watch') {
      lastQualityStatus = { mode: 'not-watch' };
      renderQualityStatus();
      return;
    }
    if (tab.status === 'loading') {
      lastQualityStatus = { mode: 'waiting' };
      renderQualityStatus();
      return;
    }
    let res = null;
    try {
      res = await api.tabs.sendMessage(tab.id, { type: 'ybquality-status' });
    } catch (e) {
      res = null;
    }
    if (res && res.ok && res.status) {
      qualityMissingTicks = 0;
      lastQualityStatus = res.status;
    } else if (res && res.ok) {
      /* Content-Skript lebt, aber quality.js hat noch keinen Status gesetzt:
         nach drei Durchläufen ist die MAIN-World-Instanz wahrscheinlich alt. */
      qualityMissingTicks += 1;
      lastQualityStatus = { mode: qualityMissingTicks >= 3 ? 'unavailable' : 'waiting' };
    } else {
      lastQualityStatus = { mode: 'unavailable' };
    }
    renderQualityStatus();
  } finally {
    qualityStatusBusy = false;
  }
}

function renderQualityStatus() {
  const el = $('qualityStatus');
  if (!el) return;
  const setting = normalizeVideoQuality($('videoQuality') ? $('videoQuality').value : DEFAULT_SETTINGS.videoQuality);
  const st = lastQualityStatus || {};
  let text = '';
  let cls = '';
  if (setting === 'off') {
    text = t('quality_status_off');
  } else {
    switch (st.mode) {
      case 'active':
        text = t('quality_status_active', { quality: qualityLabel(st.actual || st.current || setting) });
        cls = 'ok';
        break;
      case 'fallback':
        text = t('quality_status_fallback', {
          wanted: qualityLabel(st.requested || setting),
          actual: qualityLabel(st.actual)
        });
        break;
      case 'manual':
        text = t('quality_status_manual', { quality: qualityLabel(st.actual || st.current) });
        break;
      case 'ad':
        text = t('quality_status_ad');
        break;
      case 'error':
        text = t('quality_status_error');
        cls = 'err';
        break;
      case 'not-watch':
        text = t('quality_status_not_watch');
        break;
      case 'unsupported':
        text = t('quality_status_unsupported');
        break;
      case 'unavailable':
        text = t('quality_status_reload');
        cls = 'err';
        break;
      case 'off':
        text = t('quality_status_off');
        break;
      case 'waiting':
      default:
        text = t('quality_status_waiting');
        break;
    }
  }
  el.textContent = text;
  el.className = 'hint' + (cls ? ' ' + cls : '');
}

/* Sprache anwenden: Wörterbuch aufs DOM plus alle dynamischen Teile neu beschriften */
function applyLanguage(lang) {
  i18n.set(lang);
  $('uiLang').value = i18n.current;
  $('kwList').dataset.empty = t('lex_empty');
  renderLexicon();
  renderSemStatus(lastSemStatus);
  renderOcrStatus();
  renderFaceStatus();
  renderCounts();
  renderLastShot();
  renderPromoDiag();
  renderFolderStatus();
  renderQualityStatus();
  syncAiChannelUi();
}

function status(msg, ok = true) {
  const el = $('status');
  el.textContent = msg;
  el.style.color = ok ? '#12a150' : '#e0356a';
  if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
}

/* ---- Tabs mit veralteter Skript-Instanz -------------------------------------
   Offene YouTube-Tabs behalten nach einem Extension-Update das alte Content-
   Script; Nachrichten des Popups laufen dort ins Leere — genau deshalb wirkten
   neue Wörter manchmal erst nach dem manuellen Neuladen (F5). ybping verrät
   solche Tabs (antwortet erst ab 1.5.6); der Hintergrund injiziert sie nach
   einem Update zusätzlich schon automatisch. */
let staleTabs = [];

function renderStaleTabs(ids) {
  staleTabs = ids || [];
  const box = $('staleTabs');
  if (box) box.hidden = staleTabs.length === 0;
}

async function checkStaleTabs() {
  try {
    const version = api.runtime.getManifest().version;
    const tabs = await api.tabs.query({ url: ['*://*.youtube.com/*', '*://music.youtube.com/*'] });
    const { stale } = await YB.staleTabs.pingTabs(
      tabs, id => api.tabs.sendMessage(id, { type: 'ybping' }), version);
    renderStaleTabs(stale);
  } catch (e) {
    renderStaleTabs([]);   /* Abfrage fehlgeschlagen: lieber nichts behaupten */
  }
}

$('staleReload').onclick = async () => {
  const ids = staleTabs.slice();
  renderStaleTabs([]);
  for (const id of ids) {
    try { await api.tabs.reload(id); } catch (e) { /* Tab existiert nicht mehr */ }
  }
};

/* ---- Diagnose der Werbeformate ---------------------------------------------
   Verdächtige Karten (schwache Signale, noch keine Regel) speichert das
   Content-Skript lokal unter „promoSuspects“. Der Bericht ist JSON-Text zum
   Kopieren — die Erweiterung selbst versendet nichts. */
let promoSuspects = [];

function renderPromoDiag() {
  const el = $('promoDiagCount');
  if (el) el.textContent = promoSuspects.length
    ? t('promo_diag_count', { n: promoSuspects.length })
    : t('promo_diag_empty');
}

$('promoDiagCopy').onclick = async () => {
  const out = $('promoDiagOut');
  const report = {
    extension: 'youtube-blocker',
    version: api.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    suspects: promoSuspects
  };
  const json = JSON.stringify(report, null, 2);
  out.textContent = json;
  out.hidden = false;
  try {
    await navigator.clipboard.writeText(json);
    status(t('promo_diag_copied'));
  } catch (e) {
    status(t('promo_diag_copy_failed'), false);
  }
};

$('promoDiagClear').onclick = async () => {
  promoSuspects = [];
  renderPromoDiag();
  const out = $('promoDiagOut');
  out.textContent = '';
  out.hidden = true;
  await api.storage.local.set({ promoSuspects: [] });
  status(t('promo_diag_cleared'));
};

/* Migration beim ersten Öffnen nach dem Update: liegt noch kein lexicon vor,
   wird das flache keywords-Array über die kuratierten Vorlagen in Gruppen
   überführt. Unbekannte Wörter bleiben als Einzelgruppe erhalten. */
function ensureLexicon(data) {
  if (Array.isArray(data.lexicon)) {
    return { lexicon: YB.lexicon.normalizeLexicon(data.lexicon), migrated: false };
  }
  const flat = Array.isArray(data.keywords) ? data.keywords : [];
  if (!flat.length) return { lexicon: [], migrated: false };
  const templates = YB.lexiconData && Array.isArray(YB.lexiconData.groups)
    ? YB.lexiconData.groups : [];
  const res = YB.lexicon.migrate(flat, templates);
  return { lexicon: res.lexicon, migrated: true, unmatched: res.unmatched };
}

function routeLabel(route) {
  const key = route === 'title' ? 'route_title_lbl' : ('route_' + (route || 'auto'));
  return t(key);
}

const AI_CHANNEL_MODES = ['off', 'badge', 'dim'];

function syncAiChannelUi() {
  const on = $('hideAiGenerated') && $('hideAiGenerated').checked;
  const sel = $('aiChannelMode');
  if (!sel) return;
  sel.disabled = !on;
  sel.title = on ? '' : t('ai_channel_need_ai');
}

async function load() {
  const data = await api.storage.local.get({
    settings: {}, lexicon: null, keywords: [], blockedCount: 0, dismissedCount: 0, hiddenCount: 0, semStatus: null, faceStatus: null, promoSuspects: [], lastShot: null
  });
  const s = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  s.actionDelayMs = numberOr(s.actionDelayMs, DEFAULT_SETTINGS.actionDelayMs);
  s.speechMaxSeconds = numberOr(s.speechMaxSeconds, DEFAULT_SETTINGS.speechMaxSeconds);
  s.semanticMargin = numberOr(s.semanticMargin, DEFAULT_SETTINGS.semanticMargin);
  s.hashThreshold = numberOr(s.hashThreshold, DEFAULT_SETTINGS.hashThreshold);
  s.faceThreshold = numberOr(s.faceThreshold, DEFAULT_SETTINGS.faceThreshold);
  if (s.faceThreshold < 0.3 || s.faceThreshold > 0.95) s.faceThreshold = DEFAULT_SETTINGS.faceThreshold;
  s.videoQuality = normalizeVideoQuality(s.videoQuality);
  if (!AI_CHANNEL_MODES.includes(s.aiChannelMode)) s.aiChannelMode = DEFAULT_SETTINGS.aiChannelMode;
  if (!FACE_MODES.includes(s.faceMode)) s.faceMode = DEFAULT_SETTINGS.faceMode;
  SETTING_IDS.forEach(id => { $(id).checked = id in s ? s[id] : (id === 'enabled' || id === 'checkTitle' || id === 'checkSemanticImage'); });
  VALUE_IDS.forEach(id => { if (id !== 'uiLang') $(id).value = s[id]; });
  const ensured = ensureLexicon(data);
  lexicon = ensured.lexicon;
  /* Migration sofort persistieren: Content-Scripts und Exporte sehen dann
     dieselbe Matrix, auch wenn das Popup gleich wieder geschlossen wird. */
  if (ensured.migrated) {
    await api.storage.local.set({
      lexicon,
      keywords: YB.lexicon.toKeywords(lexicon)
    });
  }
  counts = { dis: data.dismissedCount || 0, hid: data.hiddenCount || 0 };
  lastSemStatus = data.semStatus;
  faceStatus = data.faceStatus || null;
  promoSuspects = Array.isArray(data.promoSuspects) ? data.promoSuspects : [];
  lastShot = data.lastShot || null;
  /* Sprache: gespeicherte Wahl; ohne Wahl einmalig aus der Browsersprache ableiten */
  applyLanguage(i18n.normalize(s.uiLang) || i18n.detect(api));
  if (ensured.migrated) status(t('lex_migrated', { groups: lexicon.length }));
  syncAiChannelUi();
  /* Live-Status beim Host erfragen: der gespeicherte semStatus kann fehlen oder
     veraltet sein (z. B. direkt nach dem Browserstart, bevor etwas lief). */
  api.runtime.sendMessage({ type: 'ybsem', op: 'status' })
    .then(res => { if (res && res.ok && res.status) renderSemStatus(res.status); })
    .catch(() => { /* Host nicht erreichbar → gespeicherter Stand bleibt stehen */ });
  /* OCR-Modell beim Öffnen des Popups vorbereiten und den Fortschritt
     anzeigen. Auch wenn das Popup gleich wieder schließt, läuft die
     Initialisierung im Hintergrund-/Offscreen-Host weiter. */
  refreshOcrStatus();
  if ($('checkThumbOcr').checked) prepareOcr();
  else renderOcrStatus();
  /* Face-Modell beim Öffnen vorbereiten, wenn der Kanal aktiv ist. Der
     Host lädt lokal; das Popup kann sofort wieder schließen. */
  if ($('faceMode').value !== 'off') prepareFace();
  else renderFaceStatus();
  /* Whisper-Bibliothek nur prüfen, wenn die Spracherkennung eingeschaltet ist */
  if ($('checkSpeech').checked) checkWhisper();
  /* Optionale Berechtigungen der Kontrollbilder prüfen (Häkchen + Warnhinweis) */
  checkShotsPermission();
  /* Chrome: Ordnerstatus zeigen und bei bereits erteilter Freigabe wartende
     Bilder ohne weiteren Klick nachschreiben. */
  if (folderMode()) {
    renderFolderStatus();
    folderApi().getStatus().then(st => {
      if (st.name && st.permission === 'granted' && st.pending) flushShotFolder();
    }).catch(() => {});
  }
  /* Läuft in einem offenen YouTube-Tab noch die alte Skript-Instanz? */
  checkStaleTabs();
  refreshQualityStatus();
}

function updateCount() {
  const st = YB.lexicon.stats(lexicon);
  $('kwCount').textContent = st.groups
    ? t('lex_count', { groups: st.groups, variants: st.variants, on: st.enabled })
    : '';
}

function openLexicon(id) {
  const base = api.runtime.getURL('popup/lexicon.html');
  api.tabs.create({ url: base + (id ? '#' + encodeURIComponent(id) : '') });
}

function renderLexicon() {
  const box = $('kwList');
  box.innerHTML = '';
  lexicon.forEach(g => {
    const row = document.createElement('div');
    row.className = 'lexrow' + (g.enabled === false ? ' off' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = g.enabled !== false;
    cb.title = t('kw_use_title');
    cb.onchange = () => {
      g.enabled = cb.checked;
      row.classList.toggle('off', !cb.checked);
      updateCount();
      schedulePersist(0);
    };

    const label = document.createElement('span');
    label.className = 'lexlabel';
    label.textContent = g.label || g.id;
    label.title = g.label || g.id;

    const route = document.createElement('span');
    route.className = 'lexroute';
    route.textContent = routeLabel(g.route);
    route.title = t('route_title');

    const meta = document.createElement('span');
    meta.className = 'lexmeta';
    meta.textContent = t('lex_meta', { n: (g.variants || []).length });

    const edit = document.createElement('button');
    edit.className = 'lexedit';
    edit.textContent = '✎';
    edit.title = t('lex_edit_title');
    edit.onclick = () => openLexicon(g.id);

    row.append(cb, label, route, meta, edit);
    box.appendChild(row);
  });
  box.dataset.empty = t('lex_empty');
  updateCount();
}

function addLexiconEntry(text) {
  const v = String(text || '').trim();
  if (!v) return false;
  const existing = YB.lexicon.findVariant(lexicon, v);
  if (existing) {
    status(t('lex_dup', { group: existing.label }), false);
    return false;
  }
  lexicon.push(YB.lexicon.createGroup(v, lexicon));
  renderLexicon();
  schedulePersist(0);
  return true;
}

let saveTimer = null;
let dirty = false;
let loadReady = null;   /* läuft load() noch, warten wir vor dem ersten Speichern */

function markDirty() {
  dirty = true;
  status(t('save_saving'));
}

function markSaved() {
  dirty = false;
  status(t('save_saved'));
}

/* Verzögertes Speichern: Jede Änderung speichert selbst und benachrichtigt die Tabs.
   Für Texteingaben längeres Debounce, um nicht bei jedem Zeichen zu senden. */
function schedulePersist(delay = 500) {
  markDirty();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, delay);
}

async function persist() {
  clearTimeout(saveTimer);
  /* Erst speichern, wenn load() die Felder gefüllt hat — sonst überschreibt
     ein früher Klick leere Strings (genau so entstand actionDelayMs:""). */
  if (loadReady) await loadReady;
  const settings = {};
  SETTING_IDS.forEach(id => settings[id] = $(id).checked);
  VALUE_IDS.forEach(id => settings[id] = $(id).value);
  settings.videoQuality = normalizeVideoQuality(settings.videoQuality);
  settings.aiChannelMode = AI_CHANNEL_MODES.includes(settings.aiChannelMode)
    ? settings.aiChannelMode
    : DEFAULT_SETTINGS.aiChannelMode;
  settings.faceMode = FACE_MODES.includes(settings.faceMode)
    ? settings.faceMode
    : DEFAULT_SETTINGS.faceMode;
  const faceThrRaw = Number(settings.faceThreshold);
  settings.faceThreshold = Number.isFinite(faceThrRaw) && faceThrRaw >= 0.3 && faceThrRaw <= 0.95
    ? faceThrRaw
    : DEFAULT_SETTINGS.faceThreshold;
  const marginRaw = Number(settings.semanticMargin);
  settings.semanticMargin = Number.isFinite(marginRaw) && marginRaw >= 0 && marginRaw <= 1
    ? marginRaw
    : DEFAULT_SETTINGS.semanticMargin;
  const hashRaw = Number(settings.hashThreshold);
  settings.hashThreshold = Number.isFinite(hashRaw) && hashRaw >= 0 && hashRaw <= 30
    ? hashRaw
    : DEFAULT_SETTINGS.hashThreshold;
  const delayRaw = numberOr(settings.actionDelayMs, DEFAULT_SETTINGS.actionDelayMs);
  settings.actionDelayMs = delayRaw >= 0 && delayRaw <= 60000
    ? delayRaw
    : DEFAULT_SETTINGS.actionDelayMs;
  const secsRaw = numberOr(settings.speechMaxSeconds, DEFAULT_SETTINGS.speechMaxSeconds);
  settings.speechMaxSeconds = secsRaw >= 10 && secsRaw <= 600
    ? secsRaw
    : DEFAULT_SETTINGS.speechMaxSeconds;
  settings.logMatch = true;
  /* Nicht lexicon = normalized: die DOM-Zeilen halten Referenzen auf die
     Gruppenobjekte; ein Austausch würde weitere Änderungen ins Leere laufen
     lassen. Normalisiert wird nur die gespeicherte Kopie. */
  const normalized = YB.lexicon.normalizeLexicon(lexicon);
  const kws = YB.lexicon.toKeywords(normalized);
  try {
    await api.storage.local.set({ settings, lexicon: normalized, keywords: kws });
    /* alle YouTube-Tabs benachrichtigen */
    const tabs = await api.tabs.query({ url: ['*://*.youtube.com/*', '*://music.youtube.com/*'] });
    await Promise.all(tabs.map(t => api.tabs.sendMessage(t.id, { type: 'config-changed' }).catch(() => {})));
    markSaved();
    /* Fehlgeschlagene Zustellungen oben sind bewusst still — hier werden sie sichtbar. */
    checkStaleTabs();
  } catch (e) {
    dirty = true;
    status(t('save_error', { msg: e.message }), false);
  }
  return { lexicon: normalized, keywords: kws };
}

$('kwAdd').onclick = () => { if (addLexiconEntry($('kwInput').value)) $('kwInput').value = ''; };
$('kwInput').onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (addLexiconEntry($('kwInput').value)) $('kwInput').value = ''; }
};
$('lexOpen').onclick = () => openLexicon();

/* Automatisches Speichern der Einstellungen: Häkchen/Auswahl wirken sofort, Text/Zahl mit Debounce */
SETTING_IDS.forEach(id => {
  const el = $(id);
  if (!el || id === 'shotBeforeHide') return;   /* eigener Listener: Berechtigung vor dem Speichern */
  el.addEventListener('change', () => {
    if (id === 'checkSpeech' && el.checked) checkWhisper();
    if (id === 'checkThumbOcr') {
      if (el.checked) prepareOcr();
      else { stopOcrPoll(); renderOcrStatus(); }
    }
    renderStats();
    schedulePersist(0);
  });
});

/* Kontrollbilder: Das Häkchen darf erst „an“ bleiben, wenn der Browser die
   Aufnahme des Tabs und das Speichern erlaubt hat. Der Aufruf erfolgt direkt in
   der Nutzergeste (kein await davor), sonst verweigert Firefox den Dialog. */
$('shotBeforeHide').addEventListener('change', async () => {
  const el = $('shotBeforeHide');
  renderShotsPerm();
  renderStats();
  if (!el.checked) { schedulePersist(0); return; }
  let granted = false;
  try {
    if (api.permissions && api.permissions.request) {
      granted = await api.permissions.request(shotPermissionRequest());
    }
  } catch (e) { granted = false; }
  if (!granted) {
    el.checked = false;
    shotsPermOk = false;
    renderShotsPerm();
    renderStats();
    status(t('shots_perm_denied'), false);
    return;
  }
  shotsPermOk = true;
  renderShotsPerm();
  renderStats();
  schedulePersist(0);
  status(folderMode() ? t('shots_on_folder') : t('shots_on'));
  if (folderMode()) renderFolderStatus();
});

/* Manuelle Testaufnahme: prüft den kompletten Weg (Berechtigung, Aufnahme,
   Download) ohne auf eine passende Karte warten zu müssen. Die Berechtigung
   wird direkt in der Nutzergeste angefragt. */
$('shotTest').onclick = async () => {
  const btn = $('shotTest');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    if (shotsPermOk !== true) {
      let granted = false;
      try {
        if (api.permissions && api.permissions.request) {
          granted = await api.permissions.request(shotPermissionRequest());
        }
      } catch (e) { granted = false; }
      shotsPermOk = granted;
      renderShotsPerm();
      renderStats();
      if (!granted) {
        status(t('shots_perm_denied'), false);
        return;
      }
    }
    if (folderMode()) {
      const ready = await ensureFolderForTest();
      if (!ready) return;
      await flushShotFolder();
    }
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs && tabs[0];
    const res = await api.runtime.sendMessage({ type: 'ybshot-test', tabId: activeTab && activeTab.id });
    if (res && res.ok && res.pending) {
      status(t('shots_test_pending', { file: shortFile(res.file) || '—' }), false);
      await renderFolderStatus(folderReason(res.error));
    } else if (res && res.ok) {
      status(t('shots_test_ok', { file: shortFile(res.file) || '—' }));
    } else {
      status(t('shots_test_failed', { msg: (res && res.error) || t('unknown') }), false);
    }
  } catch (e) {
    status(t('shots_test_failed', { msg: String((e && e.message) || e) }), false);
  } finally {
    btn.disabled = false;
  }
};
VALUE_IDS.forEach(id => {
  const el = $(id);
  if (!el || id === 'uiLang') return;   /* uiLang: eigener Listener unten (Sprache sofort anwenden) */
  const isText = el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number');
  el.addEventListener(isText ? 'input' : 'change', () => {
    if (id === 'ocrLangs' && $('checkThumbOcr').checked) prepareOcr();
    if (id === 'faceMode') {
      renderStats();
      renderFaceStatus();
      if (el.value !== 'off') prepareFace();
      else stopFacePoll();
    }
    if (id === 'videoQuality') {
      lastQualityStatus = null;
      qualityMissingTicks = 0;
      renderQualityStatus();
      setTimeout(refreshQualityStatus, 350);
    }
    schedulePersist(isText ? 700 : 0);
  });
});
if ($('hideAiGenerated')) $('hideAiGenerated').addEventListener('change', syncAiChannelUi);

/* Sprachwechsel: Oberfläche sofort umstellen und die Wahl speichern */
$('uiLang').addEventListener('change', () => {
  applyLanguage(i18n.normalize($('uiLang').value) || 'de');
  schedulePersist(0);
});

/* Wird das Popup mit ausstehendem Debounce geschlossen, wird das Speichern nachgeholt */
window.addEventListener('beforeunload', () => {
  stopOcrPoll();
  stopFacePoll();
  if (qualityStatusTimer) clearInterval(qualityStatusTimer);
  if (dirty) persist();
});

$('ocrPrepare').onclick = () => prepareOcr();
$('facePrepare').onclick = () => prepareFace();

$('export').onclick = async () => {
  if (loadReady) await loadReady;
  if (dirty) await persist();
  const data = await api.storage.local.get(['settings', 'lexicon', 'keywords']);
  const settings = Object.assign({}, data.settings || {});
  /* Entfernte Felder nicht in neue Exporte weiterschleppen. */
  delete settings.allowAll;
  delete settings.fuzzy;
  if (!AI_CHANNEL_MODES.includes(settings.aiChannelMode)) {
    settings.aiChannelMode = DEFAULT_SETTINGS.aiChannelMode;
  }
  /* Die im Popup bearbeitete Matrix ist maßgeblich; data.lexicon kann bei
     einem noch laufenden Debounce einen älteren Stand haben. */
  const lex = YB.lexicon.normalizeLexicon(lexicon);
  const out = {
    settings,
    lexicon: lex,
    keywords: lex.length ? YB.lexicon.toKeywords(lex) : (data.keywords || [])
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'youtube-blocker-list.json';
  a.click();
};

/* Import öffnet in einem eigenen Tab: In Firefox schließt sich das Popup, sobald
   der Systemdatei-Dialog aufgeht, und onchange geht verloren. In einem normalen
   Tab tritt dieses Problem nicht auf. */
$('import').onclick = () => {
  api.tabs.create({ url: api.runtime.getURL('popup/import.html') });
};

/* Statusspans liegen in den labels — ein Klick darauf darf die Einstellung nicht umschalten */
document.querySelectorAll('.stat').forEach(el => el.addEventListener('click', e => e.preventDefault()));

loadReady = load().then(() => {
  refreshQualityStatus();
  qualityStatusTimer = setInterval(refreshQualityStatus, 1200);
});
