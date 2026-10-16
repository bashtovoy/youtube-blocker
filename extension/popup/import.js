/* import.js — Import der Wortliste aus JSON in einem eigenen Tab
   (im Firefox-Popup unmöglich: Der Datei-Dialog schließt das Popup vor onchange). */
'use strict';

const api = (typeof browser !== 'undefined') ? browser : chrome;
const $ = id => document.getElementById(id);

function status(msg, ok = true) {
  const el = $('status');
  el.textContent = msg;
  el.className = ok ? '' : 'err';
}

/* Einträge auf { text, enabled } normalisieren — Strings oder Objekte, wie im Popup */
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
  } catch (_) { /* keine offenen YouTube-Tabs — unkritisch */ }
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
    if (!Array.isArray(raw)) throw new Error('Die Datei enthält keine Wortliste (erwartet wird ein Array oder { "keywords": [...] })');
    const kws = normalizeKeywords(raw);
    if (!kws.length) throw new Error('Die Liste ist leer — die Datei enthält keine nicht-leeren Wörter');
    const settings = (data && typeof data === 'object' && data.settings) ? data.settings : {};
    await api.storage.local.set({ settings, keywords: kws });
    await applyToTabs();
    status(`Importierte Wörter: ${kws.length}. Dieser Tab kann geschlossen werden.`);
  } catch (err) {
    status('Importfehler: ' + err.message, false);
  }
  e.target.value = '';
};
