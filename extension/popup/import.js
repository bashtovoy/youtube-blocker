/* import.js — импорт списка слов из JSON в отдельной вкладке
   (в попапе Firefox это невозможно: диалог выбора файла закрывает попап до onchange). */
'use strict';

const api = (typeof browser !== 'undefined') ? browser : chrome;
const $ = id => document.getElementById(id);

function status(msg, ok = true) {
  const el = $('status');
  el.textContent = msg;
  el.className = ok ? '' : 'err';
}

/* приводим элементы к { text, enabled } — строки или объекты, как в попапе */
function normalizeKeywords(list) {
  return (list || [])
    .map(k => typeof k === 'string'
      ? { text: k.trim(), enabled: true }
      : { text: String((k && k.text) || '').trim(), enabled: !k || k.enabled !== false })
    .filter(k => k.text);
}

async function applyToTabs() {
  try {
    const tabs = await api.tabs.query({ url: ['*://*.youtube.com/*', '*://music.youtube.com/*'] });
    await Promise.all(tabs.map(t => api.tabs.sendMessage(t.id, { type: 'config-changed' }).catch(() => {})));
  } catch (_) { /* нет открытых вкладок YouTube — не страшно */ }
}

$('file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const text = await f.text();
    const data = JSON.parse(text);
    const raw = Array.isArray(data)
      ? data
      : (data && typeof data === 'object' ? data.keywords : null);
    if (!Array.isArray(raw)) throw new Error('в файле нет списка слов (ожидается массив или { "keywords": [...] })');
    const kws = normalizeKeywords(raw);
    if (!kws.length) throw new Error('список пуст — в файле нет непустых слов');
    const settings = (data && typeof data === 'object' && data.settings) ? data.settings : {};
    await api.storage.local.set({ settings, keywords: kws });
    await applyToTabs();
    status(`Импортировано слов: ${kws.length}. Можно закрыть эту вкладку.`);
  } catch (err) {
    status('Ошибка импорта: ' + err.message, false);
  }
  e.target.value = '';
};
