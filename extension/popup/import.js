/* import.js — Import der Wortliste aus JSON in einem eigenen Tab
   (im Firefox-Popup unmöglich: Der Datei-Dialog schließt das Popup vor onchange). */
'use strict';

const api = (typeof browser !== 'undefined') ? browser : chrome;
const $ = id => document.getElementById(id);
const i18n = YB.i18n;
const t = (key, vars) => i18n.t(key, vars);

/* Oberflächensprache aus den Einstellungen übernehmen (Erstlauf: Browsersprache) */
async function initLanguage() {
  try {
    const { settings } = await api.storage.local.get({ settings: {} });
    i18n.set(i18n.normalize(settings && settings.uiLang) || i18n.detect(api));
  } catch (_) { /* storage nicht lesbar → deutsche Defaults */ }
}

function status(msg, ok = true) {
  const el = $('status');
  el.textContent = msg;
  el.className = ok ? '' : 'err';
}

/* Einträge auf { text, enabled, route? } normalisieren — Strings oder Objekte, wie im Popup.
   route ∈ title|ocr|image|hybrid (docs/SEMANTIC_FILTER_ROUTING.md, Punkt 1);
   fehlende/ungültige Route = Auto (alle Kanäle). */
function normRoute(r) {
  return (r === 'title' || r === 'ocr' || r === 'image' || r === 'hybrid') ? r : '';
}

function normalizeKeywords(list) {
  return (list || [])
    .map(k => {
      if (typeof k === 'string') return { text: k.trim(), enabled: true };
      const o = { text: String((k && k.text) || '').trim(), enabled: !k || k.enabled !== false };
      const r = normRoute(k && k.route);
      if (r) o.route = r;
      return o;
    })
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
    if (!Array.isArray(raw)) throw new Error(t('import_no_list'));
    const kws = normalizeKeywords(raw);
    if (!kws.length) throw new Error(t('import_empty_list'));
    /* Nur die im Import enthaltenen Einstellungen überschreiben; der Rest
       bleibt erhalten. Eine reine Wortliste (Array) darf keine Einstellungen
       zurücksetzen. */
    const existing = await api.storage.local.get({ settings: {} });
    const settings = Object.assign({}, existing.settings || {},
      (data && typeof data === 'object' && data.settings) ? data.settings : {});
    if (!i18n.normalize(settings.uiLang)) settings.uiLang = i18n.current;   /* gewählte Oberflächensprache behalten */
    /* Leere Zahlfelder aus alten Exporten auf gültige Defaults heben. */
    for (const [key, fallback] of Object.entries({
      actionDelayMs: 2500, semanticMargin: 0.03, hashThreshold: 8, speechMaxSeconds: 120
    })) {
      const raw = settings[key];
      const n = Number(raw);
      settings[key] = (raw === '' || raw === null || raw === undefined || !Number.isFinite(n))
        ? fallback
        : n;
    }
    await api.storage.local.set({ settings, keywords: kws });
    await applyToTabs();
    status(t('import_ok', { n: kws.length }));
  } catch (err) {
    status(t('import_error', { msg: err.message }), false);
  }
  e.target.value = '';
};

initLanguage();
