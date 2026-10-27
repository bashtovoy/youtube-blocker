/* lex-table.js — breite Bearbeitungsseite der Begriffsmatrix.
   Ein Konzept = eine Zeile; Varianten sind exakte Schreibweisen, ein Prompt
   pro Gruppe für SigLIP. Speichert debounced in storage.local und stößt die
   offenen YouTube-Tabs an. Keine Netzwerkzugriffe. */
'use strict';

const api = (typeof browser !== 'undefined') ? browser : chrome;
const $ = id => document.getElementById(id);
const i18n = YB.i18n;
const t = (key, vars) => i18n.t(key, vars);

let lexicon = [];
let saveTimer = null;
let statusTimer = null;
let search = '';
let dupIds = new Set();
const rows = new Map();   /* id → { row, label, variants, count, prompt } */

function templates() {
  return YB.lexiconData && Array.isArray(YB.lexiconData.groups)
    ? YB.lexiconData.groups : [];
}

/* Beim ersten Öffnen nach dem Update liegt noch kein lexicon vor: das flache
   keywords-Array wird über die kuratierten Vorlagen in Gruppen überführt.
   Unbekannte Wörter bleiben als Einzelgruppe erhalten. */
function loadLexicon(data) {
  if (Array.isArray(data.lexicon)) {
    return { lexicon: YB.lexicon.normalizeLexicon(data.lexicon), migrated: false };
  }
  const flat = Array.isArray(data.keywords) ? data.keywords : [];
  if (!flat.length) return { lexicon: [], migrated: false };
  const res = YB.lexicon.migrate(flat, templates());
  return { lexicon: res.lexicon, migrated: true };
}

function routeLabel(route) {
  const key = route === 'title' ? 'route_title_lbl' : ('route_' + (route || 'auto'));
  return t(key);
}

function statusText(msg, ok = true, hideAfter = 0) {
  const el = $('save');
  el.textContent = msg;
  el.className = ok ? '' : 'err';
  clearTimeout(statusTimer);
  if (hideAfter) {
    statusTimer = setTimeout(() => {
      if (el.textContent === msg) el.textContent = '';
    }, hideAfter);
  }
}

function updateTotal() {
  const st = YB.lexicon.stats(lexicon);
  $('total').textContent = st.groups ? t('lex_total', { groups: st.groups, variants: st.variants }) : '';
}

function makeField(labelKey, control, hintKey, full) {
  const box = document.createElement('div');
  box.className = 'field' + (full ? ' full' : '');
  const label = document.createElement('label');
  label.textContent = t(labelKey);
  box.appendChild(label);
  box.appendChild(control);
  if (hintKey) {
    const hint = document.createElement('span');
    hint.className = 'sub';
    hint.textContent = t(hintKey);
    box.appendChild(hint);
  }
  return box;
}

function makeRow(g) {
  const row = document.createElement('section');
  row.className = 'group' + (g.enabled === false ? ' off' : '');
  row.dataset.id = g.id;

  const head = document.createElement('div');
  head.className = 'ghead';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = g.enabled !== false;
  cb.title = t('lex_enabled');
  cb.onchange = () => {
    g.enabled = cb.checked;
    row.classList.toggle('off', !cb.checked);
    scheduleSave(0);
  };

  const label = document.createElement('input');
  label.className = 'label';
  label.type = 'text';
  label.value = g.label || g.id;
  label.placeholder = t('lex_label');
  label.title = t('lex_label');
  label.oninput = () => {
    const oldLabel = g.label || '';
    g.label = label.value;
    /* Nur den automatisch abgeleiteten Prompt mitziehen, nie einen eigenen. */
    const promptEl = rows.get(g.id) && rows.get(g.id).prompt;
    if (promptEl && (!g.prompt || g.prompt === oldLabel.toLowerCase())) {
      g.prompt = label.value.toLowerCase();
      promptEl.value = g.prompt;
    }
    scheduleSave(600);
  };

  const route = document.createElement('select');
  route.title = t('lex_route_hint');
  route.setAttribute('aria-label', t('lex_route'));
  YB.lexicon.ROUTES.forEach(value => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = routeLabel(value);
    route.appendChild(opt);
  });
  route.value = YB.lexicon.normalizeRoute(g.route);
  route.onchange = () => {
    g.route = YB.lexicon.normalizeRoute(route.value);
    scheduleSave(0);
  };

  const count = document.createElement('span');
  count.className = 'gcount';

  const del = document.createElement('button');
  del.className = 'del';
  del.type = 'button';
  del.textContent = '×';
  del.title = t('lex_delete');
  del.onclick = () => {
    const n = (g.variants || []).length;
    if (!confirm(t('lex_delete_confirm', { group: g.label || g.id, n }))) return;
    const idx = lexicon.indexOf(g);
    if (idx >= 0) lexicon.splice(idx, 1);
    render();
    scheduleSave(0);
  };

  head.append(cb, label, route, count, del);

  const body = document.createElement('div');
  body.className = 'gbody';

  const prompt = document.createElement('input');
  prompt.type = 'text';
  prompt.value = g.prompt || '';
  prompt.placeholder = g.label || g.id;
  prompt.oninput = () => { g.prompt = prompt.value; scheduleSave(600); };

  const variants = document.createElement('textarea');
  variants.value = (g.variants || []).join('\n');
  variants.spellcheck = false;
  variants.oninput = () => {
    g.variants = variants.value.split('\n').map(v => v.trim()).filter(Boolean);
    count.textContent = t('lex_meta', { n: g.variants.length });
    updateTotal();
    markDuplicates();
    scheduleSave(600);
  };

  const exceptions = document.createElement('input');
  exceptions.type = 'text';
  exceptions.value = YB.matcher.normalizeExceptions(g.exceptions).join(', ');
  exceptions.oninput = () => {
    g.exceptions = YB.matcher.normalizeExceptions(exceptions.value);
    scheduleSave(600);
  };

  body.append(
    makeField('lex_prompt', prompt, 'lex_prompt_hint', true),
    makeField('lex_variants', variants, 'lex_variants_hint', false),
    makeField('lex_exceptions', exceptions, 'lex_exceptions_hint', false)
  );

  count.textContent = t('lex_meta', { n: (g.variants || []).length });
  row.append(head, body);
  rows.set(g.id, { row, label, prompt, variants, count });
  return row;
}

function applyFilter() {
  const q = search.trim().toLowerCase();
  let shown = 0;
  lexicon.forEach(g => {
    const ref = rows.get(g.id);
    if (!ref) return;
    const hay = [g.label || '', g.id || ''].concat(g.variants || []).join('\n').toLowerCase();
    const visible = !q || hay.indexOf(q) >= 0;
    ref.row.hidden = !visible;
    if (visible) shown++;
  });
  $('noResults').hidden = shown > 0 || !lexicon.length;
}

function render() {
  rows.clear();
  const box = $('groups');
  box.innerHTML = '';
  if (!lexicon.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = t('lex_empty');
    box.appendChild(empty);
  } else {
    lexicon.forEach(g => box.appendChild(makeRow(g)));
  }
  updateTotal();
  markDuplicates();
  applyFilter();
}

/* doppelte Varianten über Gruppen hinweg markieren; gespeichert wird dann
   nicht, bis der Konflikt behoben ist (nichts wird still verworfen). */
function markDuplicates() {
  const dups = YB.lexicon.duplicateVariants(lexicon);
  dupIds = new Set();
  dups.forEach(d => { dupIds.add(d.group); if (d.first) dupIds.add(d.first); });
  rows.forEach((ref, id) => ref.row.classList.toggle('dup', dupIds.has(id)));
  return dups;
}

function scheduleSave(delay) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; persist(); }, delay);
}

async function persist() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const dups = markDuplicates();
  if (dups.length) {
    statusText(t('lex_duplicate', { text: dups[0].text }), false);
    return false;
  }
  const normalized = YB.lexicon.normalizeLexicon(lexicon);
  const kws = YB.lexicon.toKeywords(normalized);
  try {
    await api.storage.local.set({ lexicon: normalized, keywords: kws });
    try {
      const tabs = await api.tabs.query({ url: ['*://*.youtube.com/*', '*://music.youtube.com/*'] });
      await Promise.all(tabs.map(tab =>
        api.tabs.sendMessage(tab.id, { type: 'config-changed' }).catch(() => {})));
    } catch (_) { /* Tabs sind optional; storage.onChanged greift trotzdem */ }
    statusText(t('lex_saved'), true, 2500);
    return true;
  } catch (e) {
    statusText(t('lex_save_error', { msg: e.message }), false);
    return false;
  }
}

function focusGroup(id) {
  const ref = rows.get(id);
  if (!ref) return;
  ref.row.classList.add('hit');
  ref.row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  ref.label.focus({ preventScroll: true });
  setTimeout(() => ref.row.classList.remove('hit'), 2600);
}

function addGroup() {
  const g = YB.lexicon.createGroup(t('lex_new_label'), lexicon);
  lexicon.push(g);
  search = '';
  $('search').value = '';
  render();
  focusGroup(g.id);
  scheduleSave(0);
}

async function init() {
  const data = await api.storage.local.get({ settings: {}, lexicon: null, keywords: [] });
  i18n.set(i18n.normalize(data.settings && data.settings.uiLang) || i18n.detect(api));
  document.title = t('lex_editor_title');
  const loaded = loadLexicon(data);
  lexicon = loaded.lexicon;
  render();
  if (loaded.migrated) {
    const ok = await persist();
    if (ok) statusText(t('lex_migrated', { groups: lexicon.length }));
  }
  const hash = decodeURIComponent(String(location.hash || '').slice(1));
  if (hash) focusGroup(hash);
}

$('back').onclick = () => { location.href = 'popup.html'; };
$('add').onclick = addGroup;
$('search').oninput = () => { search = $('search').value; applyFilter(); };
$('search').onkeydown = (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const first = lexicon.find(g => {
      const q = search.trim().toLowerCase();
      if (!q) return false;
      return [g.label || '', g.id || ''].concat(g.variants || []).join('\n').toLowerCase().indexOf(q) >= 0;
    });
    if (first) focusGroup(first.id);
  }
};

/* Beim Verlassen noch offene Änderungen sichern. */
window.addEventListener('pagehide', () => { if (saveTimer) persist(); });

init().catch(e => statusText(t('lex_save_error', { msg: e.message }), false));
