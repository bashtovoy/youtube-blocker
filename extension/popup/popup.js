/* popup.js — управление текстовым списком семантических понятий и настройками */
'use strict';

const api = (typeof browser !== 'undefined') ? browser : chrome;
const $ = id => document.getElementById(id);

const SETTING_IDS = ['enabled', 'checkTitle', 'checkSemanticImage', 'checkThumbOcr', 'checkSpeech', 'fuzzy'];
const VALUE_IDS = ['mode', 'ocrLangs', 'semanticThreshold', 'actionDelayMs', 'speechLang', 'speechModel', 'speechMaxSeconds'];

const DEFAULT_SETTINGS = {
  enabled: true,
  checkTitle: true,
  checkSemanticImage: true,
  checkThumbOcr: false,
  checkSpeech: false,
  fuzzy: true,
  mode: 'dismiss',
  ocrLangs: 'eng+rus',
  hashThreshold: 8,
  semanticThreshold: 0.15,
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
  $('blocked').textContent = (dis || hid) ? `YouTube: ${dis} · локально: ${hid}` : '';
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
    cb.title = 'Использовать это слово';
    cb.onchange = () => { kw.enabled = cb.checked; row.classList.toggle('off', !cb.checked); };

    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = kw.text;
    inp.oninput = () => { kw.text = inp.value; };

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Удалить';
    del.onclick = () => { keywords.splice(idx, 1); renderKeywords(); };

    row.append(cb, inp, del);
    box.appendChild(row);
  });
  const on = keywords.filter(k => k.enabled !== false && k.text.trim()).length;
  $('kwCount').textContent = keywords.length ? `всего: ${keywords.length} · активно: ${on}` : '';
  /* синхронизируем поле массового редактирования, когда оно свёрнуто */
  const bulk = $('keywordsBulk');
  if (bulk && !bulk.closest('details').open) bulk.value = keywords.map(k => k.text).join('\n');
}

function addKeyword(text) {
  const v = String(text || '').trim();
  if (!v) return false;
  if (keywords.some(k => k.text.toLowerCase() === v.toLowerCase())) {
    status('Такое слово уже есть', false);
    return false;
  }
  keywords.push({ text: v, enabled: true });
  renderKeywords();
  return true;
}

async function save() {
  const settings = {};
  SETTING_IDS.forEach(id => settings[id] = $(id).checked);
  VALUE_IDS.forEach(id => settings[id] = $(id).value);
  const semanticRaw = Number(settings.semanticThreshold);
  settings.semanticThreshold = Number.isFinite(semanticRaw) && semanticRaw >= 0.05 && semanticRaw <= 0.95
    ? semanticRaw
    : DEFAULT_SETTINGS.semanticThreshold;
  const hashRaw = Number(settings.hashThreshold);
  settings.hashThreshold = Number.isFinite(hashRaw) && hashRaw >= 0
    ? hashRaw
    : DEFAULT_SETTINGS.hashThreshold;
  settings.logMatch = true;
  const kws = keywords
    .map(k => ({ text: k.text.trim(), enabled: k.enabled !== false }))
    .filter(k => k.text);
  keywords = kws;
  renderKeywords();
  await api.storage.local.set({ settings, keywords: kws });
  /* уведомляем все вкладки YouTube */
  const tabs = await api.tabs.query({ url: ['*://*.youtube.com/*', '*://music.youtube.com/*'] });
  await Promise.all(tabs.map(t => api.tabs.sendMessage(t.id, { type: 'config-changed' }).catch(() => {})));
  status('Сохранено, вкладки обновлены');
}

$('kwAdd').onclick = () => { if (addKeyword($('kwInput').value)) $('kwInput').value = ''; };
$('kwInput').onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (addKeyword($('kwInput').value)) $('kwInput').value = ''; }
};
$('kwApplyBulk').onclick = () => {
  keywords = normalizeKeywords($('keywordsBulk').value.split('\n'));
  renderKeywords();
  status('Список обновлён из текста');
};
document.querySelector('details.bulk').addEventListener('toggle', (e) => {
  if (e.target.open) $('keywordsBulk').value = keywords.map(k => k.text).join('\n');
});

$('save').onclick = save;

$('export').onclick = async () => {
  const data = await api.storage.local.get(['settings', 'keywords', 'photoSamples']);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'youtube-blocker-list.json';
  a.click();
};

$('import').onclick = () => $('importFile').click();
$('importFile').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const text = await f.text();
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object') throw new Error('bad json');
    await api.storage.local.set({
      settings: data.settings || {},
      keywords: data.keywords || [],
    });
    await load();
    status('Импортировано');
  } catch (err) {
    status('Ошибка импорта: ' + err.message, false);
  }
  e.target.value = '';
};

load();
