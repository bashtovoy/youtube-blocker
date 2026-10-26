/* quality.js — MAIN-World-Controller für erzwungene Videoqualität.
   Läuft auf www.youtube.com, erzwingt aber nur auf /watch- und /live/-Seiten
   die im Popup gewählte Stufe. Das Isolated-Content-Skript veröffentlicht die
   Einstellung als DOM-Attribut; hier wird sie gelesen und auf den Player
   angewendet. Keine Extension-APIs, keine Netzwerkzugriffe. */
(function () {
  'use strict';

  const RULES = globalThis.YBQualityRules;
  if (!RULES || !RULES.isQualityHost(location.hostname)) return;

  const SETTING_ATTR = 'data-yb-video-quality';
  const STATUS_ATTR = 'data-yb-quality-status';
  const TICK_MS = 2000;
  const MENU_GUARD_MS = 1200;
  const MANUAL_CHECK_MS = 260;

  /* Bei erneuter Injektion (Manifest + Update-Reparatur) läuft sonst eine
     zweite Instanz mit eigenen Timern und Listenern weiter. */
  if (globalThis.__YB_QUALITY__ && typeof globalThis.__YB_QUALITY__.dispose === 'function') {
    try { globalThis.__YB_QUALITY__.dispose(); } catch (e) { /* Vorgänger war bereits beendet */ }
  }

  const docEl = document.documentElement;
  if (!docEl) return;

  const state = {
    disposed: false,
    setting: null,
    appliedVideoId: '',
    appliedTarget: '',
    wasEnforcing: false,
    manualVideoId: '',
    manualQuality: '',
    menuGuardUntil: 0,
    status: null,
    timer: null,
    applyTimer: null,
    manualTimer: null,
    observer: null
  };

  function isWatch() {
    return RULES.isWatchPath(location.pathname);
  }

  function readSetting() {
    const raw = docEl.getAttribute(SETTING_ATTR);
    if (raw === null || raw === '') return null;
    return RULES.normalize(raw, RULES.DEFAULT_QUALITY);
  }

  function getPlayer() {
    const player = document.getElementById('movie_player');
    return player && typeof player.setPlaybackQualityRange === 'function' ? player : null;
  }

  function getVideoId(player) {
    try {
      const data = player.getVideoData && player.getVideoData();
      if (data && data.video_id) return String(data.video_id);
    } catch (e) { /* Player noch nicht bereit */ }
    try {
      const url = new URL(location.href);
      const v = url.searchParams.get('v');
      if (v) return v;
      const live = url.pathname.match(/^\/live\/([^/?#]+)/);
      if (live) return live[1];
    } catch (e) { /* ungewöhnliche URL */ }
    return '';
  }

  function getLevels(player) {
    try {
      return player.getAvailableQualityLevels ? player.getAvailableQualityLevels() : [];
    } catch (e) { return []; }
  }

  function getCurrent(player) {
    try { return player.getPlaybackQuality ? player.getPlaybackQuality() : ''; }
    catch (e) { return ''; }
  }

  function getPreferred(player) {
    try { return player.getPreferredQuality ? player.getPreferredQuality() : ''; }
    catch (e) { return ''; }
  }

  function isAd(player) {
    try {
      if (player.classList && player.classList.contains('ad-showing')) return true;
    } catch (e) { /* kein DOM */ }
    try {
      if (typeof player.getAdState === 'function' && Number(player.getAdState()) > 0) return true;
    } catch (e) { /* API fehlt */ }
    return false;
  }

  function writeStatus(patch) {
    if (state.disposed) return;
    const next = Object.assign({
      setting: state.setting,
      requested: state.setting,
      actual: '',
      current: '',
      videoId: '',
      manual: false,
      mode: 'waiting'
    }, patch || {});
    const text = JSON.stringify(next);
    state.status = next;
    try {
      if (docEl.getAttribute(STATUS_ATTR) !== text) docEl.setAttribute(STATUS_ATTR, text);
    } catch (e) { /* Attribut ist nur eine lokale Anzeige */ }
  }

  function clearStatus() {
    state.status = null;
    try { docEl.removeAttribute(STATUS_ATTR); } catch (e) { /* egal */ }
  }

  function resetAuto() {
    const player = getPlayer();
    if (!player) return;
    try {
      player.setPlaybackQualityRange('auto', 'auto');
      state.wasEnforcing = false;
    } catch (e) { /* Player evtl. mitten im Wechsel */ }
  }

  function onSettingChanged() {
    const next = readSetting();
    state.setting = next;
    state.manualVideoId = '';
    state.manualQuality = '';
    state.appliedVideoId = '';
    state.appliedTarget = '';
    if (next === null) {
      if (state.wasEnforcing) resetAuto();
      state.wasEnforcing = false;
      clearStatus();
      return;
    }
    if (next === RULES.OFF) {
      if (state.wasEnforcing) resetAuto();
      state.wasEnforcing = false;
      writeStatus({ mode: 'off' });
      return;
    }
    scheduleApply(0);
  }

  function scheduleApply(delay) {
    if (state.disposed || state.applyTimer) return;
    state.applyTimer = setTimeout(() => {
      state.applyTimer = null;
      applyTarget();
    }, delay == null ? 120 : delay);
  }

  function checkManualSelection() {
    state.manualTimer = null;
    if (state.disposed || !isWatch()) return;
    if (state.setting === null || state.setting === RULES.OFF) return;
    const player = getPlayer();
    if (!player || isAd(player)) return;
    const videoId = getVideoId(player);
    if (!videoId) return;
    const target = state.appliedTarget || RULES.resolveQuality(state.setting, getLevels(player));
    if (!target) return;
    const preferred = getPreferred(player);
    if (!preferred || RULES.sameQuality(preferred, target)) return;
    state.manualVideoId = videoId;
    state.manualQuality = preferred;
    writeStatus({
      mode: 'manual',
      actual: preferred,
      current: getCurrent(player),
      videoId,
      manual: true
    });
  }

  function onMenuInteraction(event) {
    if (state.disposed || !isWatch()) return;
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    /* Klick/Kbd im Player-Einstellungsmenü: kurz nicht eingreifen, damit die
       Auswahl des Nutzers nicht vom Watchdog überschrieben wird. */
    if (!target.closest('.ytp-settings-menu, .ytp-quality-menu')) return;
    state.menuGuardUntil = Date.now() + MENU_GUARD_MS;
    if (state.manualTimer) clearTimeout(state.manualTimer);
    state.manualTimer = setTimeout(checkManualSelection, MANUAL_CHECK_MS);
  }

  function applyTarget() {
    if (state.disposed) return;

    if (!isWatch()) {
      if (!state.status || state.status.mode !== 'idle') writeStatus({ mode: 'idle' });
      return;
    }

    if (Date.now() < state.menuGuardUntil) {
      scheduleApply(Math.max(50, state.menuGuardUntil - Date.now() + 50));
      return;
    }

    if (state.setting === null) return;

    if (state.setting === RULES.OFF) {
      if (state.wasEnforcing) resetAuto();
      state.wasEnforcing = false;
      writeStatus({ mode: 'off' });
      return;
    }

    const player = getPlayer();
    if (!player) {
      writeStatus({ mode: 'waiting' });
      return;
    }

    if (isAd(player)) {
      writeStatus({
        mode: 'ad',
        actual: state.appliedTarget,
        current: getCurrent(player),
        videoId: getVideoId(player)
      });
      return;
    }

    const videoId = getVideoId(player);
    if (!videoId) {
      writeStatus({ mode: 'waiting' });
      return;
    }

    if (state.manualVideoId && state.manualVideoId !== videoId) {
      state.manualVideoId = '';
      state.manualQuality = '';
    }
    if (state.appliedVideoId && state.appliedVideoId !== videoId) {
      state.appliedVideoId = '';
      state.appliedTarget = '';
    }

    if (state.manualVideoId === videoId) {
      writeStatus({
        mode: 'manual',
        actual: state.manualQuality || getCurrent(player),
        current: getCurrent(player),
        videoId,
        manual: true
      });
      return;
    }

    const actual = RULES.resolveQuality(state.setting, getLevels(player));
    if (!actual) {
      writeStatus({ mode: 'waiting', current: getCurrent(player), videoId });
      return;
    }

    const current = getCurrent(player);
    const targetRank = RULES.rankOf(actual);
    const needsApply = state.appliedTarget !== actual || RULES.rankOf(current) !== targetRank;

    if (needsApply) {
      try {
        player.setPlaybackQualityRange(actual, actual);
        state.wasEnforcing = true;
      } catch (e) {
        writeStatus({
          mode: 'error',
          actual: '',
          current,
          videoId
        });
        return;
      }
    }

    state.appliedTarget = actual;
    state.appliedVideoId = videoId;
    const fallback = state.setting !== RULES.MAX && RULES.rankOf(actual) < RULES.rankOf(state.setting);
    writeStatus({
      mode: fallback ? 'fallback' : 'active',
      actual,
      current: getCurrent(player) || current,
      videoId
    });
  }

  function onNavigate() {
    if (state.disposed) return;
    state.menuGuardUntil = 0;
    if (state.manualTimer) {
      clearTimeout(state.manualTimer);
      state.manualTimer = null;
    }
    scheduleApply(200);
  }

  function onPlayerEvent() {
    if (state.disposed || !isWatch()) return;
    scheduleApply(120);
  }

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    if (state.timer) clearInterval(state.timer);
    if (state.applyTimer) clearTimeout(state.applyTimer);
    if (state.manualTimer) clearTimeout(state.manualTimer);
    if (state.observer) state.observer.disconnect();
    document.removeEventListener('click', onMenuInteraction, true);
    document.removeEventListener('keydown', onMenuInteraction, true);
    document.removeEventListener('yt-navigate-finish', onNavigate, true);
    document.removeEventListener('yt-page-data-updated', onNavigate, true);
    window.removeEventListener('popstate', onNavigate, true);
    for (const event of ['loadedmetadata', 'play', 'playing', 'canplay', 'seeked', 'ended']) {
      document.removeEventListener(event, onPlayerEvent, true);
    }
    clearStatus();
    if (globalThis.__YB_QUALITY__ === api) delete globalThis.__YB_QUALITY__;
  }

  const api = { dispose, state, version: '1.9.0' };
  globalThis.__YB_QUALITY__ = api;

  state.observer = new MutationObserver(onSettingChanged);
  state.observer.observe(docEl, { attributes: true, attributeFilter: [SETTING_ATTR] });

  document.addEventListener('click', onMenuInteraction, true);
  document.addEventListener('keydown', onMenuInteraction, true);
  document.addEventListener('yt-navigate-finish', onNavigate, true);
  document.addEventListener('yt-page-data-updated', onNavigate, true);
  window.addEventListener('popstate', onNavigate, true);
  for (const event of ['loadedmetadata', 'play', 'playing', 'canplay', 'seeked', 'ended']) {
    document.addEventListener(event, onPlayerEvent, true);
  }

  state.setting = readSetting();
  if (state.setting === RULES.OFF) writeStatus({ mode: 'off' });
  else if (state.setting !== null) scheduleApply(0);

  state.timer = setInterval(applyTarget, TICK_MS);
})();
