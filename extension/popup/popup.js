/* popup.js — управление списком, образцами фото и настройками */
'use strict';

const api = (typeof browser !== 'undefined') ? browser : chrome;
const $ = id => document.getElementById(id);

const SETTING_IDS = ['enabled', 'checkTitle', 'checkThumbHash', 'checkThumbOcr', 'checkSpeech', 'fuzzy'];
const VALUE_IDS = ['mode', 'ocrLangs', 'hashThreshold', 'actionDelayMs', 'speechLang', 'speechModel', 'speechMaxSeconds'];

let photoSamples = [];
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
    settings: {}, keywords: [], photoSamples: [], blockedCount: 0, dismissedCount: 0, hiddenCount: 0
  });
  const s = data.settings || {};
  SETTING_IDS.forEach(id => { $(id).checked = id in s ? s[id] : (id === 'enabled' || id === 'checkTitle' || id === 'checkThumbHash' || id === 'fuzzy'); });
  VALUE_IDS.forEach(id => { if (id in s) $(id).value = s[id]; });
  keywords = normalizeKeywords(data.keywords);
  renderKeywords();
  photoSamples = data.photoSamples || [];
  renderSamples();
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

function renderSamples() {
  const box = $('samples');
  box.innerHTML = '';
  for (const p of photoSamples) {
    const div = document.createElement('div');
    div.className = 'sample';
    const img = document.createElement('img');
    img.src = p.dataUrl;
    img.title = p.label + ` (hash: ${p.hash})`;
    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    lbl.textContent = p.label;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.onclick = () => { photoSamples = photoSamples.filter(x => x.id !== p.id); renderSamples(); };
    div.append(img, lbl, del);
    box.appendChild(div);
  }
  if (!photoSamples.length) {
    box.innerHTML = '<span class="hint">пока пусто</span>';
  }
}

async function fileToSample(file) {
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = dataUrl;
  });
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
    label: file.name.replace(/\.[^.]+$/, '').slice(0, 40),
    hash: window.YB.image.dhash(img),
    phash: window.YB.image.phash(img),
    /* храним уменьшенный превью, чтобы не раздувать storage */
    dataUrl: await thumbnailDataUrl(img, 64)
  };
}

function thumbnailDataUrl(img, size) {
  const c = document.createElement('canvas');
  const k = size / Math.max(img.naturalWidth, img.naturalHeight);
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.6);
}

async function save() {
  const settings = {};
  SETTING_IDS.forEach(id => settings[id] = $(id).checked);
  VALUE_IDS.forEach(id => settings[id] = $(id).value);
  settings.logMatch = true;
  const kws = keywords
    .map(k => ({ text: k.text.trim(), enabled: k.enabled !== false }))
    .filter(k => k.text);
  keywords = kws;
  renderKeywords();
  await api.storage.local.set({ settings, keywords: kws, photoSamples });
  /* уведомляем все вкладки YouTube */
  const tabs = await api.tabs.query({ url: ['*://*.youtube.com/*', '*://music.youtube.com/*'] });
  await Promise.all(tabs.map(t => api.tabs.sendMessage(t.id, { type: 'config-changed' }).catch(() => {})));
  status('Сохранено, вкладки обновлены');
}

$('addPhotos').onclick = () => $('photoFile').click();
$('photoFile').onchange = async (e) => {
  for (const f of Array.from(e.target.files)) {
    try { photoSamples.push(await fileToSample(f)); }
    catch (err) { status('Не удалось добавить ' + f.name + ': ' + err.message, false); }
  }
  e.target.value = '';
  renderSamples();
};
$('clearPhotos').onclick = () => { photoSamples = []; renderSamples(); };

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
      photoSamples: data.photoSamples || []
    });
    await load();
    status('Импортировано');
  } catch (err) {
    status('Ошибка импорта: ' + err.message, false);
  }
  e.target.value = '';
};

load();
