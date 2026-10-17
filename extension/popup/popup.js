/* popup.js — Verwaltung der Begriffsliste und Einstellungen */
'use strict';

const api = (typeof browser !== 'undefined') ? browser : chrome;
const $ = id => document.getElementById(id);
const i18n = YB.i18n;
const t = (key, vars) => i18n.t(key, vars);
console.log('[popup] import via tab v3 loaded');  /* Markierung: fehlt sie in der Konsole, läuft im Browser noch ein alter Build */
$('ver').textContent = 'v' + api.runtime.getManifest().version;  /* sichtbare Build-Nummer im Kopfbereich */

const SETTING_IDS = ['enabled', 'checkTitle', 'checkSemanticImage', 'checkThumbOcr', 'checkSpeech', 'hideMembersOnly', 'fuzzy'];
/* uiLang gehört zu den Werten, wird beim Laden aber gesondert behandelt
   (ohne gespeicherte Wahl gilt beim ersten Öffnen die Browsersprache). */
const VALUE_IDS = ['uiLang', 'mode', 'ocrLangs', 'semanticMargin', 'actionDelayMs', 'speechLang', 'speechModel', 'speechMaxSeconds'];

const DEFAULT_SETTINGS = {
  enabled: true,
  checkTitle: true,
  checkSemanticImage: true,
  checkThumbOcr: false,
  checkSpeech: false,
  hideMembersOnly: false,
  fuzzy: true,
  mode: 'dismiss',
  ocrLangs: 'eng+rus',
  hashThreshold: 8,
  semanticMargin: 0.1,
  actionDelayMs: 2500,
  speechLang: 'ru',
  speechModel: 'models/ggml-base.bin',
  speechMaxSeconds: 120
};

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
  setStat('statFuzzy', on('fuzzy') ? 'ok' : 'off', on('fuzzy') ? 'stat_ok' : 'stat_off');

  /* Semantik: Live-Status des Hosts (Modelle bereit / laden / Fehler).
     „off“ mit lastUsedAt = Worker wurde nach Leerlauf bewusst beendet und
     startet bei Bedarf in Sekunden neu → gilt als einsatzbereit (grün). */
  let sem = ['pending', 'stat_pending'];
  if (!on('checkSemanticImage')) sem = ['off', 'stat_off'];
  else if (lastSemStatus && lastSemStatus.state === 'ready') sem = ['ok', 'stat_ok'];
  else if (lastSemStatus && lastSemStatus.state === 'off' && lastSemStatus.lastUsedAt) sem = ['ok', 'stat_ok_idle'];
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

api.storage.local.onChanged.addListener(changes => {
  if (changes.semStatus) renderSemStatus(changes.semStatus.newValue);
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

function normalizeKeywords(list) {
  return (list || [])
    .map(k => typeof k === 'string'
      ? { text: k.trim(), enabled: true, route: '' }
      : { text: String(k.text || '').trim(), enabled: k.enabled !== false, route: normRoute(k.route) })
    .filter(k => k.text);
}

async function load() {
  const data = await api.storage.local.get({
    settings: {}, keywords: [], blockedCount: 0, dismissedCount: 0, hiddenCount: 0, semStatus: null
  });
  const s = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  SETTING_IDS.forEach(id => { $(id).checked = id in s ? s[id] : (id === 'enabled' || id === 'checkTitle' || id === 'checkSemanticImage' || id === 'fuzzy'); });
  VALUE_IDS.forEach(id => { if (id !== 'uiLang') $(id).value = s[id]; });
  keywords = normalizeKeywords(data.keywords);
  counts = { dis: data.dismissedCount || 0, hid: data.hiddenCount || 0 };
  lastSemStatus = data.semStatus;
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

    row.append(cb, inp, route, del);
    box.appendChild(row);
  });
  updateCount();
  /* Massenbearbeitungsfeld synchronisieren, wenn es eingeklappt ist */
  const bulk = $('keywordsBulk');
  if (bulk && !bulk.closest('details').open) bulk.value = keywords.map(k => k.text).join('\n');
}

function addKeyword(text) {
  const v = String(text || '').trim();
  if (!v) return false;
  if (keywords.some(k => k.text.toLowerCase() === v.toLowerCase())) {
    status(t('kw_dup'), false);
    return false;
  }
  keywords.push({ text: v, enabled: true, route: '' });
  renderKeywords();
  schedulePersist(0);
  return true;
}

let saveTimer = null;
let dirty = false;

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
  const settings = {};
  SETTING_IDS.forEach(id => settings[id] = $(id).checked);
  VALUE_IDS.forEach(id => settings[id] = $(id).value);
  const marginRaw = Number(settings.semanticMargin);
  settings.semanticMargin = Number.isFinite(marginRaw) && marginRaw >= 0 && marginRaw <= 1
    ? marginRaw
    : DEFAULT_SETTINGS.semanticMargin;
  const hashRaw = Number(settings.hashThreshold);
  settings.hashThreshold = Number.isFinite(hashRaw) && hashRaw >= 0
    ? hashRaw
    : DEFAULT_SETTINGS.hashThreshold;
  settings.logMatch = true;
  const kws = keywords
    .map(k => {
      const o = { text: String(k.text || '').trim(), enabled: k.enabled !== false };
      const r = normRoute(k.route);
      if (r) o.route = r;   /* '' = Auto → Feld weglassen (Altformat-kompatibel) */
      return o;
    })
    .filter(k => k.text);
  try {
    await api.storage.local.set({ settings, keywords: kws });
    /* alle YouTube-Tabs benachrichtigen */
    const tabs = await api.tabs.query({ url: ['*://*.youtube.com/*', '*://music.youtube.com/*'] });
    await Promise.all(tabs.map(t => api.tabs.sendMessage(t.id, { type: 'config-changed' }).catch(() => {})));
    markSaved();
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
  keywords = normalizeKeywords($('keywordsBulk').value.split('\n'));
  renderKeywords();
  schedulePersist(0);
};
document.querySelector('details.bulk').addEventListener('toggle', (e) => {
  if (e.target.open) $('keywordsBulk').value = keywords.map(k => k.text).join('\n');
});

/* Automatisches Speichern der Einstellungen: Häkchen/Auswahl wirken sofort, Text/Zahl mit Debounce */
SETTING_IDS.forEach(id => {
  const el = $(id);
  if (el) el.addEventListener('change', () => {
    if (id === 'checkSpeech' && el.checked) checkWhisper();
    renderStats();
    schedulePersist(0);
  });
});
VALUE_IDS.forEach(id => {
  const el = $(id);
  if (!el || id === 'uiLang') return;   /* uiLang: eigener Listener unten (Sprache sofort anwenden) */
  const isText = el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number');
  el.addEventListener(isText ? 'input' : 'change', () => schedulePersist(isText ? 700 : 0));
});

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

load();
