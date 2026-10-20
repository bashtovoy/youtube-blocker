/* popup.js — Verwaltung der Begriffsliste und Einstellungen */
'use strict';

const api = (typeof browser !== 'undefined') ? browser : chrome;
const $ = id => document.getElementById(id);
const i18n = YB.i18n;
const t = (key, vars) => i18n.t(key, vars);
console.log('[popup] import via tab v3 loaded');  /* Markierung: fehlt sie in der Konsole, läuft im Browser noch ein alter Build */
$('ver').textContent = 'v' + api.runtime.getManifest().version;  /* sichtbare Build-Nummer im Kopfbereich */

const SETTING_IDS = ['enabled', 'checkTitle', 'checkSemanticImage', 'checkThumbOcr', 'checkSpeech', 'hideMembersOnly', 'hideAiGenerated', 'hidePromoted', 'shotBeforeHide', 'fuzzy'];
/* uiLang gehört zu den Werten, wird beim Laden aber gesondert behandelt
   (ohne gespeicherte Wahl gilt beim ersten Öffnen die Browsersprache). */
const VALUE_IDS = ['uiLang', 'mode', 'ocrLangs', 'semanticMargin', 'actionDelayMs', 'speechLang', 'speechModel', 'speechMaxSeconds', 'hashThreshold'];

const DEFAULT_SETTINGS = {
  enabled: true,
  checkTitle: true,
  checkSemanticImage: true,
  checkThumbOcr: false,
  checkSpeech: false,
  hideMembersOnly: false,
  hideAiGenerated: true,
  hidePromoted: true,
  shotBeforeHide: false,
  fuzzy: true,
  mode: 'dismiss',
  ocrLangs: 'eng+rus',
  hashThreshold: 8,
  semanticMargin: 0.03,
  actionDelayMs: 2500,
  speechLang: 'ru',
  speechModel: 'models/ggml-base.bin',
  speechMaxSeconds: 120,
  allowAll: []
};

/* Importe aus älteren Versionen können Zahlfelder als leeren String enthalten.
   Number('') ist 0 — das würde z. B. die Pause zwischen Signalen abschalten. */
function numberOr(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/* Erkennungskanäle je Schlüsselwort (docs/SEMANTIC_FILTER_ROUTING.md, Punkt 1):
   '' = Auto (alle Kanäle, bisheriges Verhalten). Zweiter Wert = i18n-Schlüssel. */
const ROUTE_OPTIONS = [
  ['', 'route_auto'],
  ['title', 'route_title_lbl'],
  ['ocr', 'route_ocr'],
  ['image', 'route_image'],
  ['hybrid', 'route_hybrid']
];

let keywords = [];   /* [{ text, enabled, route? }] */
let lastSemStatus = null;   /* für Neu-Beschriftung beim Sprachwechsel */
let counts = { dis: 0, hid: 0 };   /* Kopfzeile: YouTube-Signale / lokale Ausblendungen */

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
let ocrState = 'pending';      /* pending | ok | err — Antwort des OCR-Hosts */
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
  setStat('statAi', on('hideAiGenerated') ? 'ok' : 'off', on('hideAiGenerated') ? 'stat_ok' : 'stat_off');
  setStat('statPromoted', on('hidePromoted') ? 'ok' : 'off', on('hidePromoted') ? 'stat_ok' : 'stat_off');
  setStat('statFuzzy', on('fuzzy') ? 'ok' : 'off', on('fuzzy') ? 'stat_ok' : 'stat_off');

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

  /* OCR: der Hintergrund-Host beantwortet die Statusabfrage */
  let ocr = ['pending', 'stat_pending'];
  if (!on('checkThumbOcr')) ocr = ['off', 'stat_off'];
  else if (ocrState === 'ok') ocr = ['ok', 'stat_ok'];
  else if (ocrState === 'err') ocr = ['err', 'stat_err'];
  setStat('statOcr', ocr[0], ocr[1]);

  /* Sprache: Whisper-Bibliothek installiert? (Modelldatei wird nicht geprüft) */
  let sp = ['pending', 'stat_pending'];
  if (!on('checkSpeech')) sp = ['off', 'stat_off'];
  else if (whisperState === 'ok') sp = ['ok', 'stat_ok'];
  else if (whisperState === 'missing') sp = ['pending', 'stat_speech_missing'];
  setStat('statSpeech', sp[0], sp[1]);

  /* Kontrollbilder: eingeschaltet, aber Berechtigung fehlt/entzogen → rot */
  if ($('statShots')) {
    let sh = ['off', 'stat_off'];
    if (on('shotBeforeHide')) sh = shotsPermOk === false ? ['err', 'shots_perm_missing'] : ['ok', 'stat_ok'];
    setStat('statShots', sh[0], sh[1]);
  }
}

/* ---- Kontrollbilder: optionale Berechtigungen -------------------------------
   Aufnehmen des Tabs verlangt <all_urls>, Speichern „downloads“. Beide werden
   erst beim Einschalten angefragt — wer die Funktion nie nutzt, sieht keinen
   Hinweis und keine Installationswarnung. */
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
    shotsPermOk = await api.permissions.contains({ permissions: ['downloads'], origins: ['<all_urls>'] });
  } catch (e) {
    shotsPermOk = false;
  }
  renderShotsPerm();
  renderStats();
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
  if (changes.promoSuspects) {
    promoSuspects = Array.isArray(changes.promoSuspects.newValue) ? changes.promoSuspects.newValue : [];
    renderPromoDiag();
  }
});

function renderCounts() {
  $('blocked').textContent = (counts.dis || counts.hid)
    ? t('counter_yt_local', { dis: counts.dis, hid: counts.hid })
    : '';
}

/* Sprache anwenden: Wörterbuch aufs DOM plus alle dynamischen Teile neu beschriften */
function applyLanguage(lang) {
  i18n.set(lang);
  $('uiLang').value = i18n.current;
  $('kwList').dataset.empty = t('kw_empty');
  renderKeywords();
  renderSemStatus(lastSemStatus);
  renderCounts();
  renderPromoDiag();
}

function normRoute(r) {
  return (r === 'title' || r === 'ocr' || r === 'image' || r === 'hybrid') ? r : '';
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

function normalizeKeywords(list) {
  return (list || [])
    .map(k => {
      const isObj = k !== null && typeof k === 'object';
      const o = {
        text: String((isObj ? k.text : k) || '').trim(),
        enabled: isObj ? k.enabled !== false : true,
        route: isObj ? normRoute(k.route) : ''
      };
      const ex = YB.matcher.normalizeExceptions(isObj ? k.exceptions : null);
      if (ex.length) o.exceptions = ex;
      return o;
    })
    .filter(k => k.text);
}

/* Eine Zeile im Massenfeld: „Wort => Tennis, Tischtennis“. */
function formatKeywordLine(k) {
  const ex = YB.matcher.normalizeExceptions(k && k.exceptions);
  return String((k && k.text) || '').trim() + (ex.length ? ' => ' + ex.join(', ') : '');
}

/* Massenfeld übernehmen: enabled/route bereits vorhandener Wörter bleiben
   erhalten, damit das Bearbeiten der Freigaben keine Häkchen zurücksetzt. */
function parseKeywordLines(text) {
  const prev = new Map(keywords.map(k => [String(k.text || '').trim().toLowerCase(), k]));
  return String(text || '').split('\n').map(line => {
    const raw = line.trim();
    if (!raw) return null;
    const at = raw.indexOf('=>');
    const word = (at >= 0 ? raw.slice(0, at) : raw).trim();
    if (!word) return null;
    const ex = at >= 0 ? YB.matcher.normalizeExceptions(raw.slice(at + 2)) : [];
    const old = prev.get(word.toLowerCase());
    const o = {
      text: word,
      enabled: old ? old.enabled !== false : true,
      route: old ? normRoute(old.route) : ''
    };
    if (ex.length) o.exceptions = ex;
    return o;
  }).filter(Boolean);
}

async function load() {
  const data = await api.storage.local.get({
    settings: {}, keywords: [], blockedCount: 0, dismissedCount: 0, hiddenCount: 0, semStatus: null, promoSuspects: []
  });
  const s = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  s.actionDelayMs = numberOr(s.actionDelayMs, DEFAULT_SETTINGS.actionDelayMs);
  s.speechMaxSeconds = numberOr(s.speechMaxSeconds, DEFAULT_SETTINGS.speechMaxSeconds);
  s.semanticMargin = numberOr(s.semanticMargin, DEFAULT_SETTINGS.semanticMargin);
  s.hashThreshold = numberOr(s.hashThreshold, DEFAULT_SETTINGS.hashThreshold);
  SETTING_IDS.forEach(id => { $(id).checked = id in s ? s[id] : (id === 'enabled' || id === 'checkTitle' || id === 'checkSemanticImage' || id === 'fuzzy'); });
  VALUE_IDS.forEach(id => { if (id !== 'uiLang') $(id).value = s[id]; });
  s.allowAll = YB.matcher.normalizeAllowAll(s.allowAll);
  if ($('allowAll')) $('allowAll').value = s.allowAll.join('\n');
  keywords = normalizeKeywords(data.keywords);
  counts = { dis: data.dismissedCount || 0, hid: data.hiddenCount || 0 };
  lastSemStatus = data.semStatus;
  promoSuspects = Array.isArray(data.promoSuspects) ? data.promoSuspects : [];
  /* Sprache: gespeicherte Wahl; ohne Wahl einmalig aus der Browsersprache ableiten */
  applyLanguage(i18n.normalize(s.uiLang) || i18n.detect(api));
  /* Live-Status beim Host erfragen: der gespeicherte semStatus kann fehlen oder
     veraltet sein (z. B. direkt nach dem Browserstart, bevor etwas lief). */
  api.runtime.sendMessage({ type: 'ybsem', op: 'status' })
    .then(res => { if (res && res.ok && res.status) renderSemStatus(res.status); })
    .catch(() => { /* Host nicht erreichbar → gespeicherter Stand bleibt stehen */ });
  /* OCR-Host-Status für den Kanal-Indikator abfragen */
  api.runtime.sendMessage({ type: 'ybocr', op: 'status' })
    .then(res => { ocrState = (res && res.ok) ? 'ok' : 'err'; renderStats(); })
    .catch(() => { ocrState = 'err'; renderStats(); });
  /* Whisper-Bibliothek nur prüfen, wenn die Spracherkennung eingeschaltet ist */
  if ($('checkSpeech').checked) checkWhisper();
  /* Optionale Berechtigungen der Kontrollbilder prüfen (Häkchen + Warnhinweis) */
  checkShotsPermission();
  /* Läuft in einem offenen YouTube-Tab noch die alte Skript-Instanz? */
  checkStaleTabs();
}

function updateCount() {
  const on = keywords.filter(k => k.enabled !== false && String(k.text).trim()).length;
  $('kwCount').textContent = keywords.length ? t('kw_count', { n: keywords.length, on }) : '';
}

function renderKeywords() {
  const box = $('kwList');
  box.innerHTML = '';
  keywords.forEach((kw, idx) => {
    const row = document.createElement('div');
    row.className = 'kwrow' + (kw.enabled ? '' : ' off');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = kw.enabled !== false;
    cb.title = t('kw_use_title');
    cb.onchange = () => {
      kw.enabled = cb.checked;
      row.classList.toggle('off', !cb.checked);
      updateCount();
      schedulePersist(0);
    };

    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'kwtext';
    inp.value = kw.text;
    inp.oninput = () => {
      kw.text = inp.value;
      updateCount();
      schedulePersist(700);
    };

    const route = document.createElement('select');
    route.className = 'route';
    ROUTE_OPTIONS.forEach(([val, lblKey]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = t(lblKey);
      route.appendChild(opt);
    });
    route.value = kw.route || '';
    route.title = t('route_title');
    route.onchange = () => { kw.route = route.value; schedulePersist(0); };

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = t('del_title');
    del.onclick = () => { keywords.splice(idx, 1); renderKeywords(); schedulePersist(0); };

    const exc = document.createElement('input');
    exc.type = 'text';
    exc.className = 'kwexcinput';
    exc.value = YB.matcher.normalizeExceptions(kw.exceptions).join(', ');
    exc.placeholder = t('kw_exc_ph');
    exc.title = t('kw_exc_hint');
    exc.oninput = () => {
      kw.exceptions = YB.matcher.normalizeExceptions(exc.value);
      schedulePersist(700);
    };
    const excRow = document.createElement('div');
    excRow.className = 'kwexc';
    excRow.appendChild(exc);

    row.append(cb, inp, route, del, excRow);
    box.appendChild(row);
  });
  updateCount();
  /* Massenbearbeitungsfeld synchronisieren, wenn es eingeklappt ist */
  const bulk = $('keywordsBulk');
  if (bulk && !bulk.closest('details').open) bulk.value = keywords.map(formatKeywordLine).join('\n');
}

function addKeyword(text) {
  const v = String(text || '').trim();
  if (!v) return false;
  if (keywords.some(k => k.text.toLowerCase() === v.toLowerCase())) {
    status(t('kw_dup'), false);
    return false;
  }
  keywords.push({ text: v, enabled: true, route: '', exceptions: [] });
  renderKeywords();
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
  settings.allowAll = YB.matcher.normalizeAllowAll($('allowAll') ? $('allowAll').value : []);
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
  const kws = keywords
    .map(k => {
      const o = { text: String(k.text || '').trim(), enabled: k.enabled !== false };
      const r = normRoute(k.route);
      if (r) o.route = r;   /* '' = Auto → Feld weglassen (Altformat-kompatibel) */
      const ex = YB.matcher.normalizeExceptions(k.exceptions);
      if (ex.length) o.exceptions = ex;
      return o;
    })
    .filter(k => k.text);
  try {
    await api.storage.local.set({ settings, keywords: kws });
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
  return kws;
}

$('kwAdd').onclick = () => { if (addKeyword($('kwInput').value)) $('kwInput').value = ''; };
$('kwInput').onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (addKeyword($('kwInput').value)) $('kwInput').value = ''; }
};
$('kwApplyBulk').onclick = () => {
  keywords = parseKeywordLines($('keywordsBulk').value);
  renderKeywords();
  schedulePersist(0);
};
document.querySelector('#kwBulk').addEventListener('toggle', (e) => {
  if (e.target.open) $('keywordsBulk').value = keywords.map(formatKeywordLine).join('\n');
});

/* Automatisches Speichern der Einstellungen: Häkchen/Auswahl wirken sofort, Text/Zahl mit Debounce */
SETTING_IDS.forEach(id => {
  const el = $(id);
  if (!el || id === 'shotBeforeHide') return;   /* eigener Listener: Berechtigung vor dem Speichern */
  el.addEventListener('change', () => {
    if (id === 'checkSpeech' && el.checked) checkWhisper();
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
      granted = await api.permissions.request({ permissions: ['downloads'], origins: ['<all_urls>'] });
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
  status(t('shots_on'));
});
VALUE_IDS.forEach(id => {
  const el = $(id);
  if (!el || id === 'uiLang') return;   /* uiLang: eigener Listener unten (Sprache sofort anwenden) */
  const isText = el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number');
  el.addEventListener(isText ? 'input' : 'change', () => schedulePersist(isText ? 700 : 0));
});
if ($('allowAll')) {
  $('allowAll').addEventListener('input', () => schedulePersist(700));
}

/* Sprachwechsel: Oberfläche sofort umstellen und die Wahl speichern */
$('uiLang').addEventListener('change', () => {
  applyLanguage(i18n.normalize($('uiLang').value) || 'de');
  schedulePersist(0);
});

/* Wird das Popup mit ausstehendem Debounce geschlossen, wird das Speichern nachgeholt */
window.addEventListener('beforeunload', () => { if (dirty) persist(); });

$('export').onclick = async () => {
  const data = await api.storage.local.get(['settings', 'keywords']);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
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

loadReady = load();
