/* popup.js — Verwaltung der Begriffsliste und Einstellungen */
'use strict';

const api = (typeof browser !== 'undefined') ? browser : chrome;
const $ = id => document.getElementById(id);
console.log('[popup] import via tab v3 loaded');  /* Markierung: fehlt sie in der Konsole, läuft im Browser noch ein alter Build */
$('ver').textContent = 'v' + api.runtime.getManifest().version;  /* sichtbare Build-Nummer im Kopfbereich */

const SETTING_IDS = ['enabled', 'checkTitle', 'checkSemanticImage', 'checkExtremeFaces', 'checkThumbOcr', 'checkSpeech', 'hideMembersOnly', 'fuzzy'];
const VALUE_IDS = ['mode', 'ocrLangs', 'semanticThreshold', 'extremeFaceThreshold', 'actionDelayMs', 'speechLang', 'speechModel', 'speechMaxSeconds'];

const DEFAULT_SETTINGS = {
  enabled: true,
  checkTitle: true,
  checkSemanticImage: true,
  checkExtremeFaces: false,
  checkThumbOcr: false,
  checkSpeech: false,
  hideMembersOnly: false,
  fuzzy: true,
  mode: 'dismiss',
  ocrLangs: 'eng+rus',
  hashThreshold: 8,
  semanticThreshold: 0.15,
  extremeFaceThreshold: 0.45,
  actionDelayMs: 2500,
  speechLang: 'ru',
  speechModel: 'models/ggml-base.bin',
  speechMaxSeconds: 120
};

let keywords = [];   /* [{ text, enabled }] */

function status(msg, ok = true) {
  const el = $('status');
  el.textContent = msg;
  el.style.color = ok ? '#12a150' : '#e0356a';
  if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
}

function normalizeKeywords(list) {
  return (list || [])
    .map(k => typeof k === 'string'
      ? { text: k.trim(), enabled: true }
      : { text: String(k.text || '').trim(), enabled: k.enabled !== false })
    .filter(k => k.text);
}

async function load() {
  const data = await api.storage.local.get({
    settings: {}, keywords: [], blockedCount: 0, dismissedCount: 0, hiddenCount: 0
  });
  const s = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  SETTING_IDS.forEach(id => { $(id).checked = id in s ? s[id] : (id === 'enabled' || id === 'checkTitle' || id === 'checkSemanticImage' || id === 'fuzzy'); });
  VALUE_IDS.forEach(id => { $(id).value = s[id]; });
  keywords = normalizeKeywords(data.keywords);
  renderKeywords();
  const dis = data.dismissedCount || 0, hid = data.hiddenCount || 0;
  $('blocked').textContent = (dis || hid) ? `YouTube: ${dis} · lokal: ${hid}` : '';
}

function updateCount() {
  const on = keywords.filter(k => k.enabled !== false && String(k.text).trim()).length;
  $('kwCount').textContent = keywords.length ? `gesamt: ${keywords.length} · aktiv: ${on}` : '';
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
    cb.title = 'Dieses Wort verwenden';
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

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Löschen';
    del.onclick = () => { keywords.splice(idx, 1); renderKeywords(); schedulePersist(0); };

    row.append(cb, inp, del);
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
    status('Dieses Wort ist bereits vorhanden', false);
    return false;
  }
  keywords.push({ text: v, enabled: true });
  renderKeywords();
  schedulePersist(0);
  return true;
}

let saveTimer = null;
let dirty = false;

function markDirty() {
  dirty = true;
  status('Speichern…');
}

function markSaved() {
  dirty = false;
  status('Gespeichert, Tabs aktualisiert');
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
  const semanticRaw = Number(settings.semanticThreshold);
  settings.semanticThreshold = Number.isFinite(semanticRaw) && semanticRaw >= 0.05 && semanticRaw <= 0.95
    ? semanticRaw
    : DEFAULT_SETTINGS.semanticThreshold;
  const faceRaw = Number(settings.extremeFaceThreshold);
  settings.extremeFaceThreshold = Number.isFinite(faceRaw) && faceRaw >= 0.05 && faceRaw <= 0.95
    ? faceRaw
    : DEFAULT_SETTINGS.extremeFaceThreshold;
  const hashRaw = Number(settings.hashThreshold);
  settings.hashThreshold = Number.isFinite(hashRaw) && hashRaw >= 0
    ? hashRaw
    : DEFAULT_SETTINGS.hashThreshold;
  settings.logMatch = true;
  const kws = keywords
    .map(k => ({ text: String(k.text || '').trim(), enabled: k.enabled !== false }))
    .filter(k => k.text);
  try {
    await api.storage.local.set({ settings, keywords: kws });
    /* alle YouTube-Tabs benachrichtigen */
    const tabs = await api.tabs.query({ url: ['*://*.youtube.com/*', '*://music.youtube.com/*'] });
    await Promise.all(tabs.map(t => api.tabs.sendMessage(t.id, { type: 'config-changed' }).catch(() => {})));
    markSaved();
  } catch (e) {
    dirty = true;
    status('Speichern fehlgeschlagen: ' + e.message, false);
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
SETTING_IDS.forEach(id => { const el = $(id); if (el) el.addEventListener('change', () => schedulePersist(0)); });
VALUE_IDS.forEach(id => {
  const el = $(id);
  if (!el) return;
  const isText = el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number');
  el.addEventListener(isText ? 'input' : 'change', () => schedulePersist(isText ? 700 : 0));
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

load();
