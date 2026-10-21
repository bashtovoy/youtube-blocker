/* folder-access.js — dauerhaften Ordnerzugriff in Chrome einrichten.
   Warum eine eigene Seite? Chrome zeigt den Berechtigungsdialog für das
   File System Access API nur in einem echten Tab; im Popup (eigenes
   WebContents ohne PermissionRequestManager) wird der Zugriff still und nur
   für den Augenblick erteilt. Genau daher kam nach jedem Öffnen erneut
   „Zugriff bestätigen“, und der Service Worker sah die Freigabe nicht.

   Ablauf:
   1. Seite im Tab öffnen (aus dem Popup) → Ordner wählen bzw. Zugriff erlauben.
   2. Nach der Freigabe schließt der Hintergrund den Tab und öffnet diese Seite
      mit ?verify=1 neu. Erst ohne offene Seite wird aus dem flüchtigen ein
      ruhender Grant; ist er dauerhaft, meldet Chrome sofort „granted“.
   3. Meldet Chrome weiter „prompt“, war es nur ein Einmal-Zugriff: Die Seite
      erklärt den zweiten Schritt und öffnet den Dialog erneut. Diesmal bietet
      Chrome „Bei jedem Besuch erlauben“ an.
   4. Danach schreibt die Seite wartende Bilder nach und meldet den Erfolg. */
'use strict';

(function () {
  const api = (typeof browser !== 'undefined') ? browser : chrome;
  const $ = id => document.getElementById(id);
  const i18n = YB.i18n;
  const t = (key, vars) => i18n.t(key, vars);
  const folder = YB.folder;

  const params = new URLSearchParams(location.search);
  const isVerify = params.get('verify') === '1';
  /* Höchstens drei Anläufe: erster Versuch + zwei Bestätigungsrunden. */
  const attempt = Math.max(0, Math.min(3, Number(params.get('n')) || 0));

  let busy = false;
  let status = null;

  function setMsg(text, kind) {
    const el = $('faMsg');
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  /* Aktionen ein-/ausblenden. choose: '' | 'choose' | 'change' */
  function showActions(opts) {
    const o = opts || {};
    const grant = $('faGrant');
    const choose = $('faChoose');
    const close = $('faClose');
    grant.hidden = !o.grant;
    if (o.grant) grant.textContent = t('fa_grant');
    choose.hidden = !o.choose;
    if (o.choose) choose.textContent = t(o.choose === 'change' ? 'folder_change' : 'folder_choose');
    close.hidden = !o.close;
    setBusy(busy);
  }

  function setBusy(on) {
    $('faGrant').disabled = on;
    $('faChoose').disabled = on;
  }

  function pendingSuffix() {
    return (status && status.pending) ? ' · ' + t('folder_pending', { n: status.pending }) : '';
  }

  async function loadLanguage() {
    let lang = '';
    try {
      const data = await api.storage.local.get('settings');
      lang = i18n.normalize(data && data.settings && data.settings.uiLang) || '';
    } catch (e) { /* Standardsprache */ }
    i18n.set(lang || i18n.detect(api));
  }

  function renderPick() {
    document.body.dataset.state = 'pick';
    $('faStatus').textContent = t('folder_none') + pendingSuffix();
    $('faHelp').textContent = t('fa_help_pick');
    setMsg('');
    showActions({ choose: 'choose' });
  }

  function renderGrant() {
    document.body.dataset.state = 'grant';
    $('faStatus').textContent = t('folder_permission', { name: status.name }) + pendingSuffix();
    $('faHelp').textContent = t('fa_help_grant');
    setMsg('');
    showActions({ grant: true, choose: 'change' });
  }

  function renderRetry() {
    document.body.dataset.state = 'retry';
    $('faStatus').textContent = t('folder_permission', { name: status.name }) + pendingSuffix();
    if (attempt >= 3) {
      /* Drei Anläufe ohne dauerhaften Zugriff: keinen weiteren Automatiklauf
         starten; der Nutzer beginnt im Popup neu. */
      document.body.dataset.state = 'failed';
      $('faHelp').textContent = t('fa_help_failed');
      setMsg(t('fa_failed_hint'), 'err');
      showActions({ close: true });
      return;
    }
    $('faHelp').textContent = t(attempt >= 2 ? 'fa_help_failed' : 'fa_help_retry');
    setMsg('');
    showActions({ grant: true, choose: 'change' });
  }

  /* Nach der Freigabe ist nicht erkennbar, ob sie dauerhaft ist: Solange diese
     Seite offen ist, meldet Chrome in jedem Fall „granted“. Deshalb den Tab
     schließen und neu öffnen — die Prüfung passiert dann auf einer frischen
     Seite ohne aktiven Grant. */
  async function verify() {
    document.body.dataset.state = 'verifying';
    $('faHelp').textContent = '';
    setMsg(t('fa_checking'));
    showActions({});
    const n = Math.min(3, (isVerify ? attempt : 0) + 1);
    let ok = false;
    try {
      const res = await api.runtime.sendMessage({ type: 'ybfolder-reopen', n });
      ok = !!(res && res.ok);
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      busy = false;
      showActions({ close: true });
      setMsg(t('fa_manual_close'), 'err');
      return;
    }
    /* Kommt der Hintergrund nicht zum Schließen, bleibt die Seite sichtbar. */
    setTimeout(() => {
      if (!document.hidden) {
        busy = false;
        showActions({ close: true });
        setMsg(t('fa_manual_close'), 'err');
      }
    }, 3500);
  }

  async function chooseFolder() {
    if (busy) return;
    busy = true;
    setBusy(true);
    setMsg(t('fa_wait'));
    try {
      await folder.chooseFolder();
      await verify();
    } catch (e) {
      busy = false;
      setBusy(false);
      if (e && e.name === 'AbortError') {
        setMsg(t('folder_cancelled'), 'err');
      } else if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
        setMsg(t('fa_denied'), 'err');
      } else {
        setMsg(t('fa_error', { msg: String((e && e.message) || e) }), 'err');
      }
    }
  }

  async function grantAccess() {
    if (busy) return;
    busy = true;
    setBusy(true);
    setMsg(t('fa_wait'));
    try {
      const ok = await folder.requestStoredPermission();
      if (!ok) {
        busy = false;
        setBusy(false);
        setMsg(t('fa_denied'), 'err');
        return;
      }
      await verify();
    } catch (e) {
      busy = false;
      setBusy(false);
      setMsg(t('fa_error', { msg: String((e && e.message) || e) }), 'err');
    }
  }

  async function finish() {
    document.body.dataset.state = 'ready';
    const name = status.name;
    $('faStatus').textContent = t('folder_ready', { name });
    $('faHelp').textContent = t('fa_success') + ' ' + t('fa_success_hint');
    busy = true;
    showActions({ choose: 'change', close: true });

    let res = null;
    try {
      res = await folder.flushPending();
    } catch (e) {
      res = { ok: false, error: String((e && e.message) || e) };
    }
    if (res && res.saved) {
      api.runtime.sendMessage({
        type: 'ybshot-folder-note',
        saved: res.saved,
        savedIds: res.savedIds,
        lastSaved: res.lastSaved
      }).catch(() => { /* Statuspflege ist optional */ });
    }
    busy = false;
    setBusy(false);

    if (res && res.failed) setMsg(t('fa_error', { msg: t('folder_reason_write') }), 'err');
    else if (res && res.saved) setMsg(t('folder_flushed', { n: res.saved }), 'ok');
    else if (res && res.reason === 'permission') setMsg(t('folder_flush_permission'), 'err');
    else setMsg(t('fa_queue_empty'));
  }

  async function closePage() {
    try {
      if (api.tabs && api.tabs.getCurrent) {
        const tab = await api.tabs.getCurrent();
        if (tab && tab.id != null) {
          await api.tabs.remove(tab.id);
          return;
        }
      }
    } catch (e) { /* Fallback unten */ }
    try { window.close(); } catch (e) { /* nichts mehr möglich */ }
  }

  async function main() {
    await loadLanguage();
    document.body.classList.remove('loading');
    document.title = t('fa_page_title');

    if (!folder || !folder.storeSupported() || !folder.pickerSupported()) {
      document.body.dataset.state = 'unsupported';
      $('faStatus').textContent = t('fa_unsupported');
      setMsg(t('fa_unsupported'), 'err');
      showActions({});
      return;
    }

    try {
      status = await folder.getStatus();
    } catch (e) {
      document.body.dataset.state = 'error';
      $('faStatus').textContent = t('fa_error', { msg: String((e && e.message) || e) });
      setMsg(t('fa_error', { msg: String((e && e.message) || e) }), 'err');
      showActions({});
      return;
    }

    if (!status.name) return renderPick();
    /* „granted“ direkt beim Laden heißt: kein flüchtiger Grant aktiv, also
       wurde der Zugriff dauerhaft erteilt (oder die Seite wurde neu geladen,
       was im Ablauf nicht vorkommt). */
    if (status.permission === 'granted') return finish();
    return isVerify ? renderRetry() : renderGrant();
  }

  $('faGrant').addEventListener('click', grantAccess);
  $('faChoose').addEventListener('click', chooseFolder);
  $('faClose').addEventListener('click', closePage);

  main();
})();
