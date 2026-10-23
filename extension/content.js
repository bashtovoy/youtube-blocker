/* content.js — Erkennung im Scrollbereich, Kaskade Text → Bild → OCR → Sprache, danach offizielles „Kein Interesse“ */
(function () {
  'use strict';

  const api = (typeof browser !== 'undefined') ? browser : chrome;

  /* Ein bereits offener Tab behält nach einem Update die alte Instanz. Sobald
     die Extension neu geladen wurde, wirft der nächste API-Zugriff synchron
     „Extension context invalidated.“; ein `.catch` erreicht diesen Fehler
     nicht. `safeApi` prüft den Kontext vorab und beendet die verwaiste
     Instanz, statt eine unbehandelte Ausnahme zu erzeugen. */
  function extensionAlive() {
    try { return !!(api && api.runtime && api.runtime.id); } catch (e) { return false; }
  }

  function isContextInvalidated(error) {
    return /extension context invalidated/i.test(String((error && error.message) || error || ''));
  }

  function safeApi(fn, onError) {
    if (!extensionAlive()) {
      disposeInstance();
      return undefined;
    }
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        result.catch(error => {
          if (isContextInvalidated(error)) disposeInstance();
          else if (onError) onError(error);
        });
      }
      return result;
    } catch (error) {
      if (isContextInvalidated(error)) disposeInstance();
      else if (onError) onError(error);
      return undefined;
    }
  }

  const VERSION = (() => {
    try { return api.runtime.getManifest().version; } catch (e) { return ''; }
  })();

  /* Nach einem Extension-Update behält ein bereits offener Tab die alte Instanz
     dieses Skripts (Browser tauschen Content-Scripts in offenen Tabs nicht aus;
     background.js injiziert deshalb nach einem Update erneut). Läuft in dieser
     Isolated World noch eine frühere Instanz, melden wir ihre Beobachter ab,
     damit nichts doppelt läuft. */
  if (window.YB && window.YB.__instance && typeof window.YB.__instance.dispose === 'function') {
    try { window.YB.__instance.dispose(); } catch (e) { /* Vorgänger war bereits beendet */ }
  }

  const DEFAULTS = {
    enabled: true,
    mode: 'dismiss',
    checkTitle: true,
    checkThumbOcr: false,
    checkSemanticImage: true,
    checkSpeech: false,
    hideMembersOnly: false,
    hideAiGenerated: true,
    /* Kanalweite KI-Markierung: standardmäßig aus, nur auf Basis offizieller Befunde. */
    aiChannelMode: 'off',
    hidePromoted: true,
    shotBeforeHide: false,
    ocrLangs: 'eng+rus',
    /* Kalibrierung 10/2026 (Kontrollbilder, q8): echte Treffer liegen bei
       Margin 0.037–0.079, Rauschen unter 0.03. Der alte Standard 0.1 war
       praktisch unerreichbar (keine semantischen Treffer). */
    semanticMargin: 0.03,
    speechLang: 'ru',
    speechModel: 'models/ggml-base.bin',
    speechMaxSeconds: 120,
    actionDelayMs: 2500,
    logMatch: true
  };

  const state = {
    settings: Object.assign({}, DEFAULTS),
    keywords: [],
    processed: new Map(),   /* key → Grund (null = kein Treffer); erlaubt Re-Hide nach YouTube-Re-Render */
    hiddenIds: new Set(),   /* videoIds, die wir lokal ausgeblendet haben (für Re-Hide-Sweep) */
    promoSeen: new WeakSet(),   /* bereits ausgeblendete Werbe-Container (keine Doppelzählung) */
    suspects: [],   /* lokale Diagnose verdächtiger Werbekarten (storage: promoSuspects) */
    suspectTimer: null,
    inFlight: new Set(),
    lastActionAt: 0,
    observer: null,
    io: null,
    observed: new WeakSet(),
    badgeWatched: new WeakSet(),   /* ohne Badge geprüft: auf spätes Badge achten */
    retryCounts: new WeakMap(),
    imageListeners: new WeakSet(),
    scanTimer: null,
    imageCache: new Map(),
    shotShown: new WeakMap(),   /* Karte → „videoId|Grund“: Ausblendung abgeschlossen */
    shotWaiting: new WeakSet(), /* Karte wartet gerade auf Sichtbarkeit/Aufnahme */
    pending: new Map(),         /* noch nicht sichtbare Karten, die auf Aufnahme warten */
    pendingTimer: null,
    pendingChain: Promise.resolve(),
    pendingRuns: 0,
    lastPendingError: '',
    ioSeen: 0,
    ioExtractNull: 0,
    processStarted: 0,
    lastProcessError: '',
    aiBlockedIds: new Set(),    /* lokal erkannte, offiziell KI-gekennzeichnete Videos */
    aiChannels: {},             /* lokaler Kanalzähler: storage.aiChannels */
    aiFeedback: { allowChannels: {}, allowVideos: {} },
    aiChannelSent: new Set(),   /* pro Video nur ein Kanal-Hit an den Hintergrund */
    aiOverlay: null,
    aiOverlayId: '',
    watchAiTimer: null,
    titleKeywords: [],
    imageKeywords: [],
    ocrKeywords: [],
    allEntries: [],
    titleEntries: [],
    imageEntries: [],
    ocrEntries: [],
    semanticKeywordsKey: '',
    semanticReady: false,
    semanticFailed: false,
    semanticRetryNeeded: false,
    ocrFailed: false,
    disposed: false   /* true, wenn eine neuere Skript-Instanz die Seite übernommen hat */
  };

  const log = (...a) => {
    console.log('[YB]', ...a);
    if (window.YB.dev) window.YB.dev.log(a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' '));
  };

  function hasDetectionTargets() {
    return state.keywords.length > 0 || state.settings.hideMembersOnly ||
      state.settings.hideAiGenerated || state.settings.hidePromoted;
  }

  /* YouTube hat die Badges auf neue View-Model-Komponenten umgestellt:
     <badge-shape class="ytBadgeShapeHost ..."><div class="ytBadgeShapeText">Members only</div></badge-shape>
     innerhalb von yt-badge-view-model / yt-content-metadata-view-model. Der alte
     ytd-badge-supported-renderer-Vorfahre existiert nicht mehr, daher suchen wir den Badge selbst. */
  const BADGE_SELECTOR = [
    'badge-shape',
    'yt-badge-view-model',
    'yt-thumbnail-badge-view-model',
    'yt-thumbnail-overlay-badge-view-model',
    'yt-thumbnail-overlay-badge-renderer',
    'ytd-badge-supported-renderer',
    '.ytBadgeShapeText',
    '.yt-badge-shape__text',
    '.badge-style-type-members-only'
  ].join(', ');
  /* Badge-Felder einzeln prüfen: „Members“ ist ein Teilstring-Muster, der
     KI-Token zählt dagegen nur als ganzes Feld — zusammengeklebt wäre
     „AI AI: Content was made with AI“ kein Token mehr. */
  function badgeFieldHit(b) {
    const fields = [
      b.textContent,
      b.getAttribute && b.getAttribute('aria-label'),
      b.getAttribute && b.getAttribute('title')
    ];
    for (const f of fields) {
      if (!f) continue;
      if (state.settings.hideMembersOnly && window.YB.matcher.isMembersOnlyText(f)) return 'members-only';
      if (state.settings.hideAiGenerated && window.YB.matcher.isAiBadgeText(f)) return 'ai-generated';
    }
    return null;
  }

  function matchBadge(v) {
    if ((!state.settings.hideMembersOnly && !state.settings.hideAiGenerated) || !v.item) return null;
    for (const b of v.item.querySelectorAll(BADGE_SELECTOR)) {
      const hit = badgeFieldHit(b);
      if (hit) return hit;
      /* Text bzw. aria-label kann am Kindknoten des Badges hängen. */
      for (const d of b.querySelectorAll('[aria-label], [title]')) {
        const childHit = badgeFieldHit(d);
        if (childHit) return childHit;
      }
    }
    return null;
  }

  /* ---- KI-Kennzeichnung auf der Videoseite ---------------------------------
     Der offizielle KI-Badge erscheint bei YouTube oft nur in den Metadaten der
     Videoseite, nicht auf der Feed-Karte. Dort erkennen, die Video-Kennung
     lokal merken und die Wiedergabe blockieren. Feed-Karten mit bekannter
     Kennung werden anschließend auch ohne sichtbaren Badge ausgeblendet. */
  function currentWatchId() {
    return (window.YB.ai && window.YB.ai.watchId(location.href)) || '';
  }

  function removeAiOverlay() {
    if (state.aiOverlay && state.aiOverlay.parentNode) {
      state.aiOverlay.parentNode.removeChild(state.aiOverlay);
    }
    state.aiOverlay = null;
    state.aiOverlayId = '';
  }

  function showAiOverlay(id) {
    if (state.aiOverlay && state.aiOverlayId === id) {
      if (state.aiOverlay.isConnected) {
        const video = document.querySelector('video');
        if (video) { try { video.pause(); } catch (e) { /* Video noch nicht bereit */ } }
        return;
      }
      state.aiOverlay = null;
      state.aiOverlayId = '';
    }
    removeAiOverlay();
    const ai = window.YB.ai;
    if (!ai) return;
    const text = ai.overlayText(state.settings.uiLang || document.documentElement.lang);
    const wrap = document.createElement('div');
    wrap.id = 'yb-ai-block';
    wrap.setAttribute('role', 'alertdialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'display:flex', 'align-items:center', 'justify-content:center',
      'padding:24px', 'box-sizing:border-box',
      'background:#0f0f0f', 'color:#f1f1f1',
      'font:16px/1.5 Roboto,Arial,sans-serif', 'text-align:center'
    ].join(';');
    const box = document.createElement('div');
    box.style.cssText = 'max-width:560px;width:100%;background:#212121;border:1px solid #3f3f3f;border-radius:12px;padding:24px;box-sizing:border-box';
    const title = document.createElement('h1');
    title.textContent = text.title;
    title.style.cssText = 'margin:0 0 12px;font-size:20px;line-height:1.3;color:#fff';
    const body = document.createElement('p');
    body.textContent = text.body;
    body.style.cssText = 'margin:0 0 20px;color:#d0d0d0';
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = text.back;
    back.style.cssText = 'padding:10px 18px;border:0;border-radius:20px;background:#f1f1f1;color:#0f0f0f;font:inherit;font-weight:600;cursor:pointer';
    back.addEventListener('click', () => {
      if (history.length > 1) history.back();
      else location.assign('https://www.youtube.com/');
    });
    box.appendChild(title);
    box.appendChild(body);
    box.appendChild(back);
    wrap.appendChild(box);
    (document.body || document.documentElement).appendChild(wrap);
    state.aiOverlay = wrap;
    state.aiOverlayId = id;
    const video = document.querySelector('video');
    if (video) {
      try { video.pause(); } catch (e) { /* Video noch nicht bereit */ }
    }
    log('AI video blocked', id);
  }

  function rememberAiVideo(id) {
    if (!id || state.aiBlockedIds.has(id)) return;
    state.aiBlockedIds.add(id);
    const ids = Array.from(state.aiBlockedIds).slice(-500);
    state.aiBlockedIds = new Set(ids);
    safeApi(() => api.storage.local.set({ aiBlockedIds: ids }));
    log('AI video remembered', id);
  }

  function checkWatchAi() {
    if (state.disposed || !window.YB.ai || !window.YB.matcher) return;
    if (!state.settings.enabled || !state.settings.hideAiGenerated) {
      removeAiOverlay();
      return;
    }
    const id = currentWatchId();
    if (!id) {
      removeAiOverlay();
      return;
    }
    if (state.aiBlockedIds.has(id)) {
      /* Die Kennung kann von einer Feed-Karte stammen, deren Kanal-Link
         damals noch nicht gerendert war. Beim Watch-Besuch nachreichen. */
      sendAiChannelHit({ videoId: id, channelRef: watchChannelRef() });
      showAiOverlay(id);
      return;
    }
    /* Bei SPA-Navigation kann der alte Badge noch kurz im DOM stehen. Nur
       verwenden, wenn die Metadaten bereits zum aktuellen Video gehören. */
    const meta = document.querySelector('ytd-watch-metadata[video-id], ytd-watch-flexy[video-id]');
    const metaId = meta && meta.getAttribute('video-id');
    if (metaId !== id) {
      if (state.aiOverlayId && state.aiOverlayId !== id) removeAiOverlay();
      return;
    }
    const badge = window.YB.ai.findBadge(document, text => window.YB.matcher.isAiBadgeText(text));
    if (badge) {
      rememberAiVideo(id);
      sendAiChannelHit({ videoId: id, channelRef: watchChannelRef(), item: meta });
      showAiOverlay(id);
      return;
    }
    /* Beim Wechsel auf ein anderes Video den alten Sperrbildschirm entfernen. */
    if (state.aiOverlayId && state.aiOverlayId !== id) removeAiOverlay();
  }

  function scheduleWatchAiCheck(delay) {
    if (state.watchAiTimer || state.disposed) return;
    state.watchAiTimer = setTimeout(() => {
      state.watchAiTimer = null;
      checkWatchAi();
    }, delay == null ? 250 : delay);
  }

  /* Ein während der Sperre neu gestartetes Video sofort wieder anhalten. */
  document.addEventListener('play', event => {
    if (!state.aiOverlayId) return;
    const target = event.target;
    if (target && target.tagName === 'VIDEO') {
      try { target.pause(); } catch (e) { /* bereits beendet */ }
    }
  }, true);
  document.addEventListener('yt-navigate-finish', () => scheduleWatchAiCheck(0));
  window.addEventListener('popstate', () => scheduleWatchAiCheck(0));

  /* ---- Werbekarten („YouTube empfiehlt“) -------------------------------------
     Mehrstufige Erkennung statt fester DOM-Selektoren: Textmarker, Struktur
     und bekannte Werbe-Container zählen zusammen; erst ab der Regelschwelle
     wird lokal ausgeblendet (kein „Kein Interesse“). Regeln: promo-rules.js. */
  function promoInfo(v) {
    if (!state.settings.hidePromoted || !v || !v.item) return null;
    try {
      return window.YB.promo.analyze(v.item, { title: v.title });
    } catch (e) {
      return null;   /* Ein defekter Regelsatz darf die übrige Erkennung nicht stoppen. */
    }
  }

  function scheduleSuspectSave() {
    clearTimeout(state.suspectTimer);
    state.suspectTimer = setTimeout(() => {
      const max = window.YB.promoRules.suspectsMax || 50;
      safeApi(() => api.storage.local.set({ promoSuspects: state.suspects.slice(0, max) }));
    }, 1200);
  }

  /* Verdächtige Karten (schwache Signale, aber unter der Schwelle) landen nur
     lokal — Grundlage für die Diagnose im Popup, ohne Netzverkehr. */
  function notePromoSuspect(v, info) {
    if (!info || info.isHit) return;
    if (!info.signals.length && !(info.suspects && info.suspects.length)) return;
    const fp = window.YB.promo.fingerprint(info, v.item, { title: v.title });
    if (state.suspects.some(e => e && e.hash === fp.hash)) return;
    state.suspects = window.YB.promo.addSuspect(state.suspects, fp, window.YB.promoRules.suspectsMax);
    scheduleSuspectSave();
  }

  /* Bekannte Werbe-Container ohne Video-Bezug (reine Werbeplätze) direkt ausblenden. */
  function hideAdContainers() {
    if (!state.settings.hidePromoted) return;
    let nodes;
    try {
      nodes = document.querySelectorAll(window.YB.promoRules.containers.join(', '));
    } catch (e) {
      return;
    }
    for (const el of nodes) {
      if (!el.isConnected || el.closest('.yb-hidden')) continue;
      if (state.promoSeen.has(el)) {
        window.YB.dismiss.hideItem(el);   /* Re-Render: Klasse wiederherstellen, nicht erneut zählen */
        continue;
      }
      state.promoSeen.add(el);
      hideLocally({ item: el }, 'promo');
    }
  }

  function settingNumber(value, fallback, min, max) {
    if (value === '' || value === null || value === undefined) return fallback;
    const n = Number(value);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  }

  function aiIdSet(value) {
    return new Set(
      (Array.isArray(value) ? value : [])
        .map(id => String(id || ''))
        .filter(id => /^[A-Za-z0-9_-]{11}$/.test(id))
        .slice(-500)
    );
  }

  async function loadConfig() {
    const data = await api.storage.local.get({
      settings: DEFAULTS, keywords: [], promoSuspects: [], aiBlockedIds: [],
      aiChannels: {}, aiFeedback: {}
    });
    const s = Object.assign({}, DEFAULTS, data.settings || {});
    /* Alte Importe können Zahlfelder als leere Strings enthalten; sonst würde
       z. B. actionDelayMs die Pause zwischen Signalen stillschweigend abschalten. */
    s.actionDelayMs = settingNumber(s.actionDelayMs, DEFAULTS.actionDelayMs, 0, 60000);
    s.semanticMargin = settingNumber(s.semanticMargin, DEFAULTS.semanticMargin, 0, 1);
    s.speechMaxSeconds = settingNumber(s.speechMaxSeconds, DEFAULTS.speechMaxSeconds, 10, 600);
    s.hashThreshold = settingNumber(s.hashThreshold, 8, 0, 30);
    s.aiChannelMode = ['off', 'badge', 'dim'].includes(s.aiChannelMode)
      ? s.aiChannelMode : 'off';
    state.settings = s;
    const kwObjects = (data.keywords || [])
      .map(k => typeof k === 'string' ? { text: k, enabled: true } : k)
      .filter(k => k && String(k.text || '').trim() && k.enabled !== false);
    state.suspects = Array.isArray(data.promoSuspects) ? data.promoSuspects : [];
    state.aiBlockedIds = aiIdSet(data.aiBlockedIds);
    state.aiChannels = (data.aiChannels && typeof data.aiChannels === 'object' && !Array.isArray(data.aiChannels))
      ? data.aiChannels : {};
    const feedback = data.aiFeedback && typeof data.aiFeedback === 'object' ? data.aiFeedback : {};
    state.aiFeedback = {
      allowChannels: feedback.allowChannels && typeof feedback.allowChannels === 'object' ? feedback.allowChannels : {},
      allowVideos: feedback.allowVideos && typeof feedback.allowVideos === 'object' ? feedback.allowVideos : {}
    };
    /* Kanalspezifische Listen aus den optionalen Routen (matcher.channelEntries):
       ohne Route gilt ein Schlüsselwort weiterhin für alle Kanäle. Einträge
       tragen ihre Freigaben mit; state.*Keywords bleibt für Host/Debug. */
    state.allEntries = kwObjects.map(k => ({
      text: String(k.text || '').trim(),
      exceptions: window.YB.matcher.exceptionsOf(k)
    })).filter(e => e.text);
    state.titleEntries = window.YB.matcher.channelEntries(kwObjects, 'title');
    state.imageEntries = window.YB.matcher.channelEntries(kwObjects, 'image');
    state.ocrEntries = window.YB.matcher.channelEntries(kwObjects, 'ocr');
    state.keywords = state.allEntries.map(e => e.text);
    state.titleKeywords = state.titleEntries.map(e => e.text);
    state.imageKeywords = state.imageEntries.map(e => e.text);
    state.ocrKeywords = state.ocrEntries.map(e => e.text);
    state.semanticKeywordsKey = '';
    state.semanticReady = false;
    state.semanticFailed = false;
    state.semanticRetryNeeded = false;
    state.ocrFailed = false;
    log('config loaded', {
      keywords: state.keywords.length,
      title: state.titleKeywords.length,
      image: state.imageKeywords.length,
      ocr: state.ocrKeywords.length,
      exceptions: state.allEntries.filter(e => e.exceptions.length).length,
      aiChannelMode: state.settings.aiChannelMode,
      aiChannels: Object.keys(state.aiChannels).length
    });
    if (state.settings.checkSpeech && state.settings.enabled && state.keywords.length) {
      safeApi(() => api.runtime.sendMessage({ type: 'ybcfg', cfg: { keywords: state.keywords, settings: state.settings } }));
      initSpeechSoon();
    }
  }

  let speechInitTried = false;
  function initSpeechSoon() {
    if (speechInitTried) return;
    speechInitTried = true;
    const go = () => window.YB.speech.init({
      modelPath: state.settings.speechModel,
      language: state.settings.speechLang,
      threadCount: 2
    }).then(() => log('speech model ready'))
      .catch(e => { log('speech init failed:', e.message); window.YB.speech.disabled = true; });
    if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 20000 });
    else setTimeout(go, 8000);
  }

  const ITEM_SELECTOR = [
    'ytd-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-rich-item-renderer',
    'ytd-compact-video-renderer',
    'ytd-playlist-panel-video-renderer',
    'ytd-reel-item-renderer',
    /* Shorts-Regale im neuen View-Model-Layout (grid-shelf-view-model):
       ytm-shorts-lockup-view-model-v2 umschließt ytm-shorts-lockup-view-model. */
    'ytm-shorts-lockup-view-model-v2',
    'ytm-shorts-lockup-view-model'
  ].join(', ');

  /* Ein Ort für Karten- und Watch-Seiten-Links; die Reihenfolge bevorzugt
     stabile Kanal-IDs/Handles vor dem schwachen Anzeigenamen. */
  const CHANNEL_LINK_SELECTOR = [
    'ytd-channel-name #text a',
    '#channel-name a',
    'ytd-channel-name a',
    '#owner #channel-name a',
    'a[href^="/@"]',
    'a[href*="/channel/"]',
    'a[href^="/c/"]',
    'a[href^="/user/"]'
  ].join(', ');

  function bestThumbUrl(img, videoId) {
    if (!img) return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    const candidates = [
      img.currentSrc,
      img.getAttribute('src'),
      img.getAttribute('data-thumb'),
      img.getAttribute('data-src'),
      img.getAttribute('data-img-src')
    ].filter(Boolean).filter(v => !v.startsWith('data:'));
    let url = candidates[0] || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    if (url.includes('googleusercontent') || url.includes('ytimg')) {
      url = url.replace(/=w\d+-h\d+[^:]*$/, '=w480-h270-c36-far-c');
    }
    return url;
  }

  /* YouTube hat Feed/Shorts auf View-Model-Komponenten umgestellt (yt-lockup-view-model,
     shortsLockupViewModel): Das Legacy-Element #video-title fehlt in vielen Layouts.
     Wir suchen den Titel daher sowohl über alte als auch über neue *.ViewModelTitle-Klassen —
     sonst liefert extract() auf jeder Karte null und es wird nichts blockiert. */
  const TITLE_SELECTOR = [
    '#video-title',
    'yt-formatted-string#video-title',
    '.ytLockupMetadataViewModelTitle',
    '.shortsLockupViewModelHostMetadataTitle',
    'h3.ytLockupMetadataViewModelHeadingReset',
    '[id="video-title"]'
  ].join(', ');

  function extract(item) {
    let videoId = (item.getAttribute && item.getAttribute('data-video-id')) || '';
    if (!videoId) {
      for (const el of item.querySelectorAll('a[href]')) {
        const h = el.getAttribute('href') || '';
        const m = h.match(/[?&]v=([\w-]{11})/) || h.match(/\/shorts\/([\w-]{11})/) || h.match(/\/embed\/([\w-]{11})/);
        if (m) { videoId = m[1]; break; }
      }
    }
    if (!videoId) return null;
    const titleEl = item.querySelector(TITLE_SELECTOR);
    const title = ((titleEl && (titleEl.getAttribute('title') || titleEl.textContent)) || '').replace(/\s+/g, ' ').trim();
    if (!title) return null;
    let chanEl = item.querySelector(CHANNEL_LINK_SELECTOR);
    let channel = ((chanEl && chanEl.textContent) || '').replace(/\s+/g, ' ').trim();
    if (!channel) {
      const md = item.querySelector('.ytContentMetadataViewModelMetadataText');
      if (md) channel = (md.textContent || '').replace(/\s+/g, ' ').trim();
    }
    const channelRef = (window.YB.aiChannel && window.YB.aiChannel.refFromHref(
      (chanEl && chanEl.getAttribute('href')) || '',
      channel
    )) || null;
    const img = item.querySelector('img');
    const thumb = bestThumbUrl(img, videoId);
    return { videoId, title, channel, channelRef, thumb, item, img };
  }

  function waitForImage(img, timeout = 1600) {
    if (!img || img.complete && img.naturalWidth > 0) return Promise.resolve(true);
    return new Promise(resolve => {
      let done = false;
      const finish = ok => { if (done) return; done = true; img.removeEventListener('load', onload); img.removeEventListener('error', onerror); resolve(ok); };
      const onload = () => finish(true);
      const onerror = () => finish(false);
      img.addEventListener('load', onload, { once: true });
      img.addEventListener('error', onerror, { once: true });
      setTimeout(() => finish(img.complete && img.naturalWidth > 0), timeout);
    });
  }

  function descriptorCached(url) {
    if (state.imageCache.has(url)) return state.imageCache.get(url);
    const p = window.YB.image.descriptorFromUrl(url).then(desc => {
      state.imageCache.set(url, Promise.resolve(desc));
      while (state.imageCache.size > 120) state.imageCache.delete(state.imageCache.keys().next().value);
      return desc;
    }).catch(err => {
      state.imageCache.delete(url);
      throw err;
    });
    state.imageCache.set(url, p);
    return p;
  }

  async function throttleAction() {
    const wait = state.settings.actionDelayMs - (Date.now() - state.lastActionAt);
    if (wait > 0) await window.YB.dismiss.sleep(wait);
    state.lastActionAt = Date.now();
  }

  const actionQueue = { tail: Promise.resolve(), push(fn) { const p = this.tail.then(fn, fn); this.tail = p.catch(() => {}); return p; } };

  /* ---- Kontrollbilder -----------------------------------------------------
     Nur wenn die Einstellung aktiv ist, wird vor dem Ausblenden der Kartenrahmen
     aufgenommen. Der Browser liefert ausschließlich den sichtbaren Bereich —
     deshalb wartet das Ausblenden zunächst bis zu WAIT_VISIBLE_MS auf eine
     vollständig sichtbare Karte. Ist sie danach nur teilweise sichtbar, wird
     der sichtbare Teil aufgenommen; ist sie ganz außerhalb des Fensters, bleibt
     sie vorgemerkt und wird erst beim Erscheinen aufgenommen und ausgeblendet.
     Ein Aufnahmefehler verhindert das Ausblenden nie. */
  const PENDING_POLL_MS = 500;
  const PENDING_PARTIAL_MS = 15000;
  const PENDING_EXPIRE_MS = 120000;
  function shotsOn() {
    return !!(state.settings.shotBeforeHide && window.YB.shots);
  }

  function shotStamp(v, reason) {
    return (v.videoId || 'slot') + '|' + (reason || '');
  }

  /* Feste Balken (Masthead) verdecken die obere Kante der Karte — dann wäre der
     Screenshot unvollständig. Als Sperrflächen in Fensterkoordinaten melden. */
  function fixedBlockers() {
    const out = [];
    for (const sel of ['ytd-masthead', '#masthead-container', '#masthead', 'ytmusic-nav-bar']) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
    return out;
  }

  function cardVisibleNow(item) {
    if (document.visibilityState !== 'visible') return false;
    const r = item.getBoundingClientRect();
    if (!(r.width >= 8 && r.height >= 8)) return false;
    return window.YB.shots.fullyVisible(
      { x: r.left, y: r.top, w: r.width, h: r.height },
      { w: window.innerWidth, h: window.innerHeight },
      fixedBlockers()
    );
  }

  function waitForCardVisible(item, timeoutMs) {
    return new Promise(resolve => {
      let timer = null, done = false;
      const deadline = Date.now() + timeoutMs;
      const finish = ok => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', tick);
        window.removeEventListener('scroll', tick, true);
        window.removeEventListener('resize', tick);
        resolve(ok);
      };
      const tick = () => {
        if (done) return;
        if (state.disposed || !item.isConnected) { finish(false); return; }
        if (cardVisibleNow(item)) { finish(true); return; }
        if (Date.now() >= deadline) { finish(false); return; }
        clearTimeout(timer);
        timer = setTimeout(tick, 180);
      };
      document.addEventListener('visibilitychange', tick);
      window.addEventListener('scroll', tick, true);
      window.addEventListener('resize', tick);
      tick();
    });
  }

  function withTimeout(promise, ms) {
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Zeitüberschreitung')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /* Letzten Aufnahmeversuch auch dann sichtbar machen, wenn das Bild gar nicht
     erst an den Hintergrund geht (z. B. Karte außerhalb des Viewports). */
  function reportShot(status, v, reason, extra) {
    const payload = Object.assign({
      at: Date.now(),
      status,
      ok: status === 'saved',
      videoId: (v && v.videoId) || '',
      reason: reason || '',
      source: 'auto',
      /* Auch ein übersprungener Versuch soll im Popup erkennen lassen, dass
         er aus einem Privatfenster kam. */
      incognito: (() => {
        try { return !!(api.extension && api.extension.inIncognitoContext); } catch (e) { return false; }
      })()
    }, extra || {});
    safeApi(() => api.storage.local.set({ lastShot: payload }));
  }

  function fullCardRect(item) {
    const r = item.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  /* Sichtbarer Kartenausschnitt. Nur bei sichtbarer Registerkarte; im
     Hintergrund würde ein Screenshot ohnehin die falsche Seite zeigen. */
  function visibleCardRect(item) {
    if (document.visibilityState !== 'visible') return null;
    const shots = window.YB.shots;
    if (!shots || typeof shots.visiblePart !== 'function') return null;
    return shots.visiblePart(
      fullCardRect(item),
      { w: window.innerWidth, h: window.innerHeight },
      fixedBlockers()
    );
  }

  /* Nimmt einen bereits geprüften Ausschnitt auf. Die Sichtbarkeit wird vom
     Aufrufer geprüft; so kann eine außerhalb des Fensters liegende Karte später
     ohne zweiten 8-Sekunden-Block aufgenommen werden. */
  async function captureBeforeHide(v, reason, rect, partial) {
    const item = v.item;
    if (!window.YB.shots || !item || !rect) return false;
    const msg = {
      type: 'ybshot',
      videoId: v.videoId || '',
      reason,
      visible: true,
      partial: !!partial,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.w),
        h: Math.round(rect.h)
      },
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
      viewport: { w: window.innerWidth, h: window.innerHeight }
    };
    try {
      const res = await withTimeout(api.runtime.sendMessage(msg), 6000);
      if (res && res.ok) {
        log(partial ? 'partial shot saved' : 'shot saved', res.file);
        return true;
      }
      const error = (res && res.error) || 'keine Antwort';
      reportShot('failed', v, reason, { error, visible: true, partial: !!partial });
      log('shot failed', v.videoId || 'slot', error);
    } catch (e) {
      if (isContextInvalidated(e)) {
        disposeInstance();
        return false;
      }
      reportShot('failed', v, reason, { error: e.message, visible: true, partial: !!partial });
      log('shot failed', v.videoId || 'slot', e.message);
    }
    return false;
  }

  function hideLocallyNow(v, reason) {
    if (state.disposed) return;
    window.YB.dismiss.hideItem(v.item);
    if (v.videoId) state.hiddenIds.add(v.videoId);
    /* Jeder offizielle KI-Treffer nährt den Kanalzähler — unabhängig davon,
       ob er über Karte, Watch-Seite oder aiBlockedIds gefunden wurde. */
    if (reason === 'ai-generated') sendAiChannelHit(v);
    log('hidden locally', v.videoId, '←', reason);
    safeApi(() => api.runtime.sendMessage({ type: 'ybincrement', by: 1, kind: 'hidden' }));
  }

  function enqueueAction(v, reason) {
    return actionQueue.push(async () => {
      if (state.disposed) return false;
      await throttleAction();
      if (state.settings.mode === 'dismiss') {
        try {
          const info = await window.YB.dismiss.notInterested(v.item);
          const result = await window.YB.dismiss.waitForOutcome(v.item, info.undoBefore);
          if (result.ok) {
            log('dismissed', v.videoId, '←', reason, result.via);
            safeApi(() => api.runtime.sendMessage({ type: 'ybincrement', by: 1, kind: 'dismissed' }));
            return true;
          }
          log('dismiss unverified, local hide:', v.videoId, reason);
        } catch (e) {
          log('dismiss unavailable, local hide:', v.videoId, e.message);
        }
      }
      hideLocallyNow(v, reason);
      return false;
    });
  }

  function executeHide(kind, v, reason) {
    if (kind === 'action') return enqueueAction(v, reason);
    hideLocallyNow(v, reason);
    return Promise.resolve(false);
  }

  /* Ein Pfad für alle Ausblendungen: erst Aufnahme, dann Ausblenden. Ist die
     Karte (noch) nicht sichtbar, wird sie vorgemerkt statt still ohne Bild
     ausgeblendet. Mehrere Trefferpfade (Badge, spätes Signal, Dismiss-Rückfall)
     buchen dieselbe Karte nur einmal. */
  async function requestHide(v, reason, kind) {
    const item = v && v.item;
    if (!item) return executeHide(kind, v, reason);
    if (!shotsOn()) {
      state.pending.delete(item);
      return executeHide(kind, v, reason);
    }
    const stamp = shotStamp(v, reason);
    if (state.pending.has(item) || state.shotWaiting.has(item)) return false;
    if (state.shotShown.get(item) === stamp) {
      if (kind === 'local') hideLocallyNow(v, reason);
      return false;
    }
    state.shotWaiting.add(item);
    try {
      const full = await waitForCardVisible(item, window.YB.shots.WAIT_VISIBLE_MS);
      if (!shotsOn()) {
        state.pending.delete(item);
        return executeHide(kind, v, reason);
      }
      if (full) {
        await captureBeforeHide(v, reason, fullCardRect(item), false);
        state.shotShown.set(item, stamp);
        return executeHide(kind, v, reason);
      }
      /* Teilweise sichtbar: nach dem Warten den sichtbaren Teil aufnehmen,
         statt die Karte ohne Kontrollbild auszublenden. */
      const part = visibleCardRect(item);
      if (part) {
        await captureBeforeHide(v, reason, part, true);
        state.shotShown.set(item, stamp);
        return executeHide(kind, v, reason);
      }
      if (item.isConnected) queuePending(v, reason, kind, stamp);
      return false;
    } finally {
      state.shotWaiting.delete(item);
    }
  }

  function hideLocally(v, reason) {
    requestHide(v, reason, 'local').catch(e => log('hide failed:', e.message));
  }

  async function applyAction(v, reason) {
    try {
      return await requestHide(v, reason, 'action');
    } catch (e) {
      log('action failed:', e.message);
      return false;
    }
  }

  function schedulePendingCheck(delay) {
    if (state.pendingTimer || state.disposed || !state.pending.size) return;
    state.pendingTimer = setTimeout(() => {
      state.pendingTimer = null;
      checkPending();
    }, delay == null ? PENDING_POLL_MS : delay);
  }

  function queuePending(v, reason, kind, stamp) {
    const item = v.item;
    if (!item || state.pending.has(item)) return;
    state.pending.set(item, { item, v, reason, kind, stamp, at: Date.now() });
    schedulePendingCheck(200);
    log('shot deferred until visible', v.videoId || 'slot', '←', reason);
  }

  function runPending(entry) {
    state.pendingChain = state.pendingChain.then(async () => {
      state.pendingRuns += 1;
      if (state.disposed || !entry.item.isConnected || entry.item.classList.contains('yb-hidden')) {
        if (!state.disposed && !entry.item.isConnected) state.lastPendingError = 'disconnected';
        return;
      }
      state.shotWaiting.add(entry.item);
      try {
        /* Zwischen Prüfung und serieller Aufnahme kann gescrollt worden sein.
           Deshalb den Ausschnitt unmittelbar vor dem Bild neu bestimmen; ist die
           Karte inzwischen ganz weg, bleibt sie erneut vorgemerkt. */
        if (shotsOn()) {
          let rect = null;
          let partial = false;
          if (cardVisibleNow(entry.item)) {
            rect = fullCardRect(entry.item);
          } else {
            const part = visibleCardRect(entry.item);
            if (part) {
              rect = part;
              partial = true;
            }
          }
          if (!rect) {
            state.pending.set(entry.item, entry);
            schedulePendingCheck(200);
            return;
          }
          await captureBeforeHide(entry.v, entry.reason, rect, partial);
        }
        await executeHide(entry.kind, entry.v, entry.reason);
        state.shotShown.set(entry.item, entry.stamp);
      } finally {
        state.shotWaiting.delete(entry.item);
      }
    }).catch(e => {
      state.lastPendingError = e.message;
      log('pending hide failed:', e.message);
    });
    return state.pendingChain;
  }

  function flushPending() {
    const entries = Array.from(state.pending.values());
    state.pending.clear();
    for (const entry of entries) runPending(entry);
  }

  function checkPending() {
    if (state.disposed) {
      state.pending.clear();
      return;
    }
    if (!state.pending.size) return;
    if (!state.settings.enabled) {
      state.pending.clear();
      return;
    }
    if (!shotsOn()) {
      flushPending();
      return;
    }
    if (document.visibilityState !== 'visible') {
      schedulePendingCheck(1000);
      return;
    }
    for (const [item, entry] of Array.from(state.pending)) {
      if (!item.isConnected || item.classList.contains('yb-hidden')) {
        state.pending.delete(item);
        continue;
      }
      if (cardVisibleNow(item)) {
        state.pending.delete(item);
        runPending(entry);
        continue;
      }
      const age = Date.now() - entry.at;
      if (age >= PENDING_PARTIAL_MS) {
        const part = visibleCardRect(item);
        if (part) {
          state.pending.delete(item);
          runPending(entry);
          continue;
        }
      }
      if (age >= PENDING_EXPIRE_MS) {
        state.pending.delete(item);
        reportShot('skipped', entry.v, entry.reason, {
          error: 'nicht-sichtbar', visible: false, deferred: true
        });
        executeHide(entry.kind, entry.v, entry.reason);
      }
    }
    if (state.pending.size) schedulePendingCheck(PENDING_POLL_MS);
  }

  window.addEventListener('scroll', () => schedulePendingCheck(80), true);
  window.addEventListener('resize', () => schedulePendingCheck(80));
  document.addEventListener('visibilitychange', () => schedulePendingCheck(80));

  function matchTitle(v) {
    if (!state.settings.checkTitle) return null;
    const contextText = [v.title, v.channel].filter(Boolean).join(' ');
    const opt = { contextText };
    const t = window.YB.matcher.matchEntries(v.title, state.titleEntries, opt);
    if (t) return { source: 'title', keyword: t.text };
    if (v.channel) {
      const c = window.YB.matcher.matchEntries(v.channel, state.titleEntries, opt);
      if (c) return { source: 'channel', keyword: c.text };
    }
    return null;
  }

  async function ensureSemanticTexts() {
    if (!state.settings.checkSemanticImage || !state.imageKeywords.length) return false;
    const key = state.imageKeywords.join('\u0001');
    if (state.semanticReady && state.semanticKeywordsKey === key) return true;
    const firstReady = !state.semanticReady;
    await window.YB.semantic.setTexts(state.imageKeywords);
    state.semanticKeywordsKey = key;
    state.semanticReady = true;
    log('semantic text concepts ready', state.imageKeywords.length);
    /* Der Kanal stand anfangs nicht zur Verfügung (z. B. erster Modell-
       Download): bereits geprüfte Karten erneut bewerten, statt auf einen
       manuellen Reload zu warten. */
    if (firstReady && state.semanticRetryNeeded) {
      state.semanticRetryNeeded = false;
      log('semantic channel ready after delay → rescan');
      setTimeout(() => {
        state.processed.clear();
        resetIO();
        startObservers();
        scanNow();
      }, 800);
    }
    return true;
  }

  async function matchThumbnail(v) {
    const semanticNeeded = state.settings.checkSemanticImage && state.imageKeywords.length > 0 && !state.semanticFailed;
    const ocrNeeded = state.settings.checkThumbOcr && state.ocrKeywords.length > 0 && !state.ocrFailed;
    if (!semanticNeeded && !ocrNeeded) return null;

    if (semanticNeeded) {
      try {
        await ensureSemanticTexts();
        const scores = await window.YB.semantic.scoreImage(v.thumb);
        const contextText = [v.title, v.channel].filter(Boolean).join(' ');
        const active = window.YB.matcher.activeScores(scores, state.imageEntries, contextText);
        if (active.length !== (scores || []).length) {
          log('semantic exceptions', v.videoId, 'skipped', (scores || []).length - active.length);
        }
        const m = window.YB.semantic.marginDecision(active, state.settings.semanticMargin);
        if (m) {
          /* Diagnose (Punkt 10 des Routing-Dokuments): Ziel-Kosinus, beste
             Konkurrenz, kontrastive Margin, Schwelle und Profilkennung. */
          log('semantic hit', m.text,
            'cos=' + m.cos.toFixed(4),
            'ref=' + (m.refText || '-') + ' ' + (Number.isFinite(m.refCos) ? m.refCos.toFixed(4) : '-'),
            'margin=' + m.margin.toFixed(4),
            'thr=' + Number(state.settings.semanticMargin).toFixed(3),
            'profile=margin-v1');
          return {
            source: 'semantic-image',
            keyword: m.text,
            score: Number(m.cos.toFixed(4)),
            margin: Number(m.margin.toFixed(4))
          };
        }
      } catch (e) {
        /* Fatale Fehler (Worker/Modell) einmal melden und den Kanal für diese
           Seitensession abschalten statt pro Karte erneut zu scheitern.
           Wiederholbare Fehler (Erstbezug/Netz, Timeout) nur vormerken:
           Sobald der Kanal steht, werden die Karten erneut bewertet. */
        if (e.fatal) {
          state.semanticFailed = true;
          log('semantic channel unavailable:', e.message);
        } else {
          state.semanticRetryNeeded = true;
          log('semantic image fail', v.videoId, e.message);
        }
      }
    }

    if (ocrNeeded) {
      try {
        const t0 = Date.now();
        const hint = [v.title, v.channel].filter(Boolean).join(' ');
        const text = await window.YB.ocr.recognizeUrl(v.thumb, state.settings.ocrLangs, hint);
        const trimmed = String(text || '').trim();
        log('ocr', v.videoId, trimmed.length + ' chars', (Date.now() - t0) + 'ms',
          trimmed ? '« ' + trimmed.slice(0, 60) + ' »' : '(kein Text)');
        const contextText = [v.title, v.channel, text].filter(Boolean).join(' ');
        const kw = window.YB.matcher.matchEntries(text, state.ocrEntries, { contextText });
        if (kw) return { source: 'ocr', keyword: kw.text };
      } catch (e) {
        /* Nur fatale Fehler (Bibliothek/Worker/Sprachdaten defekt) schalten den
           Kanal für diese Seitensession ab; einzelne Bildfehler nicht. */
        if (e && e.fatal) {
          state.ocrFailed = true;
          log('ocr channel unavailable:', e.message);
        } else {
          log('ocr image fail', v.videoId, e.message);
        }
      }
    }
    return null;
  }

  async function matchSpeech(v) {
    if (!state.settings.checkSpeech || !window.YB.speech.isAvailable() || !state.allEntries.length) return null;
    try {
      const text = await window.YB.speech.transcribeVideo(v.videoId, state.settings.speechMaxSeconds);
      const contextText = [v.title, v.channel, text].filter(Boolean).join(' ');
      const kw = window.YB.matcher.matchEntries(text, state.allEntries, { contextText });
      if (kw) return { source: 'speech', keyword: kw.text };
    } catch (e) { log('speech fail', v.videoId, e.message); }
    return null;
  }

  async function processVideo(v) {
    if (!v || state.disposed) return;
    await waitForImage(v.img).catch(() => false);
    const current = extract(v.item) || v;
    if (state.settings.hideAiGenerated && state.aiBlockedIds.has(current.videoId)) {
      hideLocally(current, 'ai-generated');
      if (state.io && current.item) state.io.unobserve(current.item);
      return;
    }
    const channelMode = channelModeFor(current.item, current.videoId);
    if (channelMode !== 'off') markAiChannel(current.item, channelMode);
    const key = current.videoId + '|' + current.title.slice(0, 100) + '|' + current.thumb;
    if (state.inFlight.has(key)) return;
    if (state.processed.has(key)) {
      /* YouTube rendert Karten neu (Shelf-/Feed-Recycling) und verliert dabei unsere Klasse.
         Bereits getroffene Karten lokal erneut ausblenden — ohne zweites offizielles Signal
         und ohne den Zähler erneut zu erhöhen. */
      let reason = state.processed.get(key);
      /* Neu gerenderter Knoten ohne Treffer: Badge kann jetzt — oder später —
         vorhanden sein. Prüfen und ggf. vormerken, sonst bleibt genau diese
         Karte dauerhaft sichtbar (früher `return` ohne Badge-Test). */
      if (!reason && (state.settings.hideMembersOnly || state.settings.hideAiGenerated || state.settings.hidePromoted)) {
        const lateHit = matchBadge(current);
        if (lateHit) {
          state.processed.set(key, lateHit);
          hideLocally(current, lateHit);
          if (state.io && current.item) state.io.unobserve(current.item);
          return;
        }
        /* Auch der Werbe-Marker („YouTube empfiehlt“) kann spät gerendert werden. */
        const latePromo = promoInfo(current);
        if (latePromo && latePromo.isHit) {
          state.processed.set(key, 'promo');
          hideLocally(current, 'promo');
          if (state.io && current.item) state.io.unobserve(current.item);
          return;
        }
        state.badgeWatched.add(current.item);
      }
      if (reason && !current.item.classList.contains('yb-hidden')) {
        /* Neuer Knoten nach YouTube-Re-Render: die Aufnahme muss noch einmal
           versucht werden, statt den Rahmen ohne Kontrollbild zu verstecken. */
        requestHide(current, reason, 'local').catch(e => log('re-hide failed:', e.message));
        log('re-hide (re-render)', current.videoId, '←', reason);
      }
      if (state.io && current.item) state.io.unobserve(current.item);
      return;
    }
    state.inFlight.add(key);
    try {
      const badgeHit = matchBadge(current);
      if (badgeHit) {
        state.processed.set(key, badgeHit);
        /* Badge-Treffer („Members only“ / KI-Hinweis) sind Eigenschaften des
           Angebots, kein Interessensignal: lokal ausblenden, kein Klick. */
        if (badgeHit === 'ai-generated') sendAiChannelHit(current);
        hideLocally(current, badgeHit);
        return;
      }
      const promo = promoInfo(current);
      if (promo && promo.isHit) {
        state.processed.set(key, 'promo');
        /* Werbekarten sind eine Eigenschaft des Angebots, kein Interessensignal:
           lokal ausblenden, kein „Kein Interesse“-Klick. */
        hideLocally(current, 'promo');
        return;
      }
      const titleHit = matchTitle(current);
      if (titleHit) {
        const reason = titleHit.source + ':' + titleHit.keyword;
        state.processed.set(key, reason);
        await applyAction(current, reason);
        return;
      }
      const thumbHit = await matchThumbnail(current);
      if (thumbHit) {
        const reason = thumbHit.source + ':' + thumbHit.keyword;
        state.processed.set(key, reason);
        await applyAction(current, reason);
        return;
      }
      if (state.settings.checkSpeech) {
        const speechHit = await matchSpeech(current);
        if (speechHit) {
          const reason = speechHit.source + ':' + speechHit.keyword;
          state.processed.set(key, reason);
          await applyAction(current, reason);
          return;
        }
      }
      state.processed.set(key, null);
      notePromoSuspect(current, promo);
      /* YouTube hängt Badges teils erst nach dem ersten Rendern an. Karte
         vormerken und in scanNow erneut auf Badges prüfen. */
      if ((state.settings.hideMembersOnly || state.settings.hideAiGenerated || state.settings.hidePromoted) && current.item) state.badgeWatched.add(current.item);
    } finally {
      state.inFlight.delete(key);
      if (state.io && current.item) state.io.unobserve(current.item);
    }
  }

  function ensureIO() {
    if (state.io) return state.io;
    state.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        state.ioSeen += 1;
        const v = extract(e.target);
        if (!v) {
          state.ioExtractNull += 1;
          /* Die Karten-Metadaten (Titel/videoId) sind von YouTube noch nicht gerendert.
             Die Karte nicht „verbrennen“: aus observed entlassen und Beobachtung abmelden,
             damit scanNow es erneut versucht, sobald eine DOM-Mutation durch die
             Karten-Hydration wieder ein Scannen auslöst. Sonst feuert der IO für das
             bereits sichtbare Element nie wieder und das Video bliebe dauerhaft ungeprüft. */
          state.observed.delete(e.target);
          state.io.unobserve(e.target);
          const tries = (state.retryCounts.get(e.target) || 0) + 1;
          state.retryCounts.set(e.target, tries);
          if (tries <= 8) scheduleScan();
          continue;
        }
        state.processStarted += 1;
        processVideo(v).catch(e => {
          state.lastProcessError = e.message;
          log('process failed:', e.message);
        });
      }
    }, { root: null, rootMargin: '600px 0px 900px 0px', threshold: 0.01 });
    return state.io;
  }

  function resetIO() {
    if (state.io) { state.io.disconnect(); state.io = null; }
    state.observed = new WeakSet();
    state.badgeWatched = new WeakSet();
    state.retryCounts = new WeakMap();
    state.imageListeners = new WeakSet();
    state.imageCache.clear();
  }

  /* Nur die videoId — deutlich billiger als extract(); für den Re-Hide-Sweep. */
  function quickVideoId(item) {
    const a = item.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
    if (!a) return null;
    const href = a.getAttribute('href') || '';
    const m = href.match(/[?&]v=([\w-]{11})/) || href.match(/\/shorts\/([\w-]{11})/);
    return m ? m[1] : null;
  }

  function aiChannelLib() {
    return window.YB && window.YB.aiChannel;
  }

  /* Kanal-Link aus einer Feed-/Suchkarte. Bewusst billig: kein extract(),
     damit die Prüfung auch bei noch nicht hydratisierten Karten funktioniert. */
  function quickChannelRef(item) {
    const lib = aiChannelLib();
    if (!lib || !item || !item.querySelector) return null;
    const a = item.querySelector(CHANNEL_LINK_SELECTOR);
    if (!a) return null;
    const name = (a.textContent || '').replace(/\s+/g, ' ').trim();
    return lib.refFromHref(a.getAttribute('href') || '', name);
  }

  /* Auf der Watch-Seite liegt der Kanal-Link in ytd-watch-metadata; die
     Empfehlungen daneben dürfen nicht versehentlich genommen werden. */
  function watchChannelRef() {
    const lib = aiChannelLib();
    if (!lib) return null;
    const scope = document.querySelector('ytd-watch-metadata, ytd-video-primary-info-renderer') || document;
    const a = scope.querySelector(CHANNEL_LINK_SELECTOR);
    if (!a) return null;
    const name = (a.textContent || '').replace(/\s+/g, ' ').trim();
    return lib.refFromHref(a.getAttribute('href') || '', name);
  }

  function sendAiChannelHit(v) {
    const lib = aiChannelLib();
    if (!lib || !v || !v.videoId || state.aiChannelSent.has(v.videoId)) return;
    const ref = v.channelRef || quickChannelRef(v.item);
    if (!ref || !ref.key) return;
    state.aiChannelSent.add(v.videoId);
    const retry = e => {
      state.aiChannelSent.delete(v.videoId);
      log('ai-channel hit failed:', (e && e.message) || e);
    };
    safeApi(() => api.runtime.sendMessage({
      type: 'yb-ai-channel-hit',
      channel: ref,
      videoId: v.videoId
    }).then(res => {
      if (!res || !res.ok) retry(res && res.error);
    }), retry);
  }

  function channelModeFor(item, videoId) {
    const lib = aiChannelLib();
    if (!lib || !state.settings.hideAiGenerated) return 'off';
    if (!state.settings.aiChannelMode || state.settings.aiChannelMode === 'off') return 'off';
    const ref = quickChannelRef(item);
    if (!ref || !ref.key) return 'off';
    return lib.decision(
      state.aiChannels, ref, state.settings, state.aiFeedback, videoId, Date.now()
    );
  }

  function markAiChannel(item, mode) {
    const lib = aiChannelLib();
    if (!lib || !item || (mode !== 'badge' && mode !== 'dim')) return;
    const text = lib.badgeText(state.settings.uiLang || 'de');
    item.classList.add('yb-ai-channel-badge');
    item.classList.toggle('yb-ai-channel-dim', mode === 'dim');
    item.setAttribute('data-yb-ai-channel', mode);
    let mark = item.querySelector('.yb-ai-channel-mark');
    if (!mark) {
      mark = document.createElement('span');
      mark.className = 'yb-ai-channel-mark';
      mark.textContent = text.mark;
      mark.setAttribute('aria-label', text.aria);
      mark.title = text.hint;
      item.appendChild(mark);
    }
  }

  function unmarkAiChannel(item) {
    if (!item) return;
    item.classList.remove('yb-ai-channel-dim', 'yb-ai-channel-badge');
    item.removeAttribute('data-yb-ai-channel');
    for (const mark of item.querySelectorAll('.yb-ai-channel-mark')) mark.remove();
  }

  /* Entfernt nur die Kanal-Markierung. Offizielle KI-Treffer und Keyword-
     Ausblendungen bleiben unberührt. Wird nach Moduswechseln aufgerufen;
     scanNow entscheidet danach neu. */
  function clearAiChannelMarks() {
    for (const item of document.querySelectorAll('[data-yb-ai-channel]')) unmarkAiChannel(item);
  }

  /* Gezielte Aktualisierung ohne erneutes Markieren: nur Karten, deren
     Kanal inzwischen nicht mehr auffällig oder per Feedback erlaubt ist,
     werden zurückgenommen. Alles andere bleibt unangetastet. */
  function refreshAiChannelMarks() {
    for (const item of document.querySelectorAll('[data-yb-ai-channel]')) {
      if (channelModeFor(item, quickVideoId(item)) === 'off') unmarkAiChannel(item);
    }
    scheduleScan();
  }

  function scanNow() {
    if (state.disposed || !state.settings.enabled || !hasDetectionTargets()) return;
    const obs = ensureIO();
    for (const item of document.querySelectorAll(ITEM_SELECTOR)) {
      if (item.classList.contains('yb-hidden')) continue;
      /* Lokal bekannte KI-Kennung: nach dem Besuch der Videoseite wird die
         Karte auch dann ausgeblendet, wenn YouTube den Badge im Feed nicht
         rendert (das ist bei YouTube häufig der Fall). */
      if (state.settings.hideAiGenerated && state.aiBlockedIds.size) {
        const knownAi = quickVideoId(item);
        if (knownAi && state.aiBlockedIds.has(knownAi)) {
          sendAiChannelHit({ item, videoId: knownAi });
          hideLocally({ item, videoId: knownAi }, 'ai-generated');
          continue;
        }
      }
      /* Bereits getroffene Videos: YouTube kann Karten neu rendern oder Klassen zurücksetzen
         (Attribute-Mutation, kein childList) — dann fehlt yb-hidden, obwohl das Video schon
         ausgeblendet war. Lokal erneut ausblenden: ohne Signal, ohne Zähler. */
      if (state.hiddenIds.size) {
        const vid = quickVideoId(item);
        if (vid && state.hiddenIds.has(vid)) {
          window.YB.dismiss.hideItem(item);
          log('re-hidden (re-render)', vid, '← hidden');
          continue;
        }
      }
      /* Kanalweite KI-Markierung: nur auf Basis mehrerer offizieller Befunde.
         Sie markiert oder dunkelt ab; die normale Keyword-Prüfung läuft weiter. */
      const channelMode = channelModeFor(item, quickVideoId(item));
      if (channelMode !== 'off') markAiChannel(item, channelMode);
      if (state.observed.has(item)) {
        /* Spät gerenderter Badge: Die Karte wurde bereits als „kein Treffer“
           verbucht, YouTube liefert den Badge aber erst danach nach. Nur
           vorgemerkte Karten erneut prüfen — billig, kein zweites OCR/Semantik. */
        if ((state.settings.hideMembersOnly || state.settings.hideAiGenerated || state.settings.hidePromoted) && state.badgeWatched.has(item)) {
          const hit = matchBadge({ item });
          if (hit) {
            state.badgeWatched.delete(item);
            if (hit === 'ai-generated') sendAiChannelHit({ item, videoId: quickVideoId(item) });
            hideLocally({ item, videoId: quickVideoId(item) }, hit);
          } else {
            /* Spät gerenderter Werbe-Marker (z. B. „YouTube empfiehlt“) */
            const lateV = extract(item);
            const latePromo = lateV ? promoInfo(lateV) : null;
            if (latePromo && latePromo.isHit) {
              state.badgeWatched.delete(item);
              const lateKey = lateV.videoId + '|' + lateV.title.slice(0, 100) + '|' + lateV.thumb;
              state.processed.set(lateKey, 'promo');
              hideLocally(lateV, 'promo');
            }
          }
        }
        continue;
      }
      state.observed.add(item);
      obs.observe(item);
    }
    hideAdContainers();
  }

  function scheduleScan() {
    /* Throttle statt Debounce: YouTube mutiert große Teile der Seite oft
       häufiger als alle 350 ms. Ein immer wieder zurückgesetzter Timer würde
       dann nie feuern und neue Karten blieben ungeprüft. */
    if (state.scanTimer) return;
    state.scanTimer = setTimeout(() => {
      state.scanTimer = null;
      scanNow();
    }, 350);
  }

  function startObservers() {
    if (state.observer) { scanNow(); return; }
    state.observer = new MutationObserver(muts => {
      scheduleWatchAiCheck();
      for (const m of muts) {
        if (m.type === 'childList' && m.addedNodes && m.addedNodes.length) { scheduleScan(); return; }
        /* class-Attribut einer Karte geändert (z. B. YouTube setzt Klassen neu) */
        if (m.type === 'attributes' && m.target && m.target.matches && m.target.matches(ITEM_SELECTOR)
            && !m.target.classList.contains('yb-hidden')) { scheduleScan(); return; }
      }
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    scanNow();
  }

  /* Einstellungen können auch aus einem anderen Fenster (oder direkt über
     storage) geändert werden. storage.onChanged hält den Content dann ohne
     Neuladen aktuell — wichtig für „Screenshot vor dem Ausblenden“. */
  let configReloadTimer = null;
  function reloadConfigSoon(delay) {
    if (configReloadTimer) clearTimeout(configReloadTimer);
    configReloadTimer = setTimeout(() => {
      configReloadTimer = null;
      state.processed.clear();
      state.shotShown = new WeakMap();
      speechInitTried = false;
      resetIO();
      loadConfig().then(() => {
        /* Wurde die Seite mit leerer Liste geöffnet, existiert noch kein
           MutationObserver. Ohne startObservers würden nur die bereits
           sichtbaren Karten geprüft und neue beim Scrollen nie erreicht. */
        if (state.settings.enabled && hasDetectionTargets()) startObservers();
        else scheduleScan();
        /* Kontrollbilder ausgeschaltet: vorgemerkte Karten sofort ausblenden,
           statt sie weiter auf eine Aufnahme warten zu lassen. */
        if (!state.settings.enabled) state.pending.clear();
        else if (!shotsOn()) flushPending();
        scheduleWatchAiCheck(0);
      }).catch(e => {
        if (isContextInvalidated(e)) disposeInstance();
        else log('config reload failed', e.message);
      });
    }, delay == null ? 30 : delay);
  }

  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.aiBlockedIds) {
      state.aiBlockedIds = aiIdSet(changes.aiBlockedIds.newValue);
      scheduleScan();
    }
    if (changes.aiChannels) {
      state.aiChannels = (changes.aiChannels.newValue && typeof changes.aiChannels.newValue === 'object' &&
        !Array.isArray(changes.aiChannels.newValue))
        ? changes.aiChannels.newValue : {};
      /* Gezielt nur inzwischen erlaubte/abgelaufene Kanäle zurücknehmen. */
      refreshAiChannelMarks();
    }
    if (changes.aiFeedback) {
      const f = changes.aiFeedback.newValue && typeof changes.aiFeedback.newValue === 'object'
        ? changes.aiFeedback.newValue : {};
      state.aiFeedback = {
        allowChannels: f.allowChannels && typeof f.allowChannels === 'object' ? f.allowChannels : {},
        allowVideos: f.allowVideos && typeof f.allowVideos === 'object' ? f.allowVideos : {}
      };
      refreshAiChannelMarks();
    }
    if (!changes.settings) return;
    /* Nur bei einem AI-relevanten Wechsel alte Kanal-Markierungen
       zurücknehmen. Ein Sprach- oder OCR-Wechsel darf keine erneuten
       Zähler/Screenshots auslösen. */
    const prevSettings = state.settings || {};
    const nextSettings = changes.settings.newValue || {};
    if (prevSettings.hideAiGenerated !== nextSettings.hideAiGenerated ||
        prevSettings.aiChannelMode !== nextSettings.aiChannelMode) {
      clearAiChannelMarks();
    }
    reloadConfigSoon();
  });

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    /* Lebenszeichen: Popup und Hintergrund erkennen damit Tabs, in denen nach
       einem Update noch die alte (verwaiste) Instanz läuft, und Tabs, die die
       aktuelle Version bereits ausführen. */
    if (msg.type === 'ybping') {
      sendResponse({ ok: true, version: VERSION });
      return;
    }
    if (msg.type === 'config-changed') {
      reloadConfigSoon(0);
    } else if (msg.type === 'rescan' || msg.type === 'dev-rescan') {
      state.processed.clear();
      resetIO();
      startObservers();
      scanNow();
    }
  });

  /* Diagnose für das Debuggen in der Konsole des Content-Skripts (Kontext moz-extension://…/content.js):
     YB.debug.state()  — was tatsächlich im Content geladen ist (Schlüssel, Flags);
     YB.debug.scan()   — pro Karte: extract/matchTitle/hidden. Damit lässt sich
     mit einem Aufruf unterscheiden: kaputter DOM-Selektor, „Wort nicht angekommen“ oder „matcht, aber nicht ausgeblendet“. */
  window.YB = window.YB || {};
  window.YB.debug = {
    state: () => ({
      enabled: state.settings.enabled,
      mode: state.settings.mode,
      hideMembersOnly: state.settings.hideMembersOnly,
      hideAiGenerated: state.settings.hideAiGenerated,
      aiChannelMode: state.settings.aiChannelMode,
      aiChannels: Object.keys(state.aiChannels).length,
      hidePromoted: state.settings.hidePromoted,
      shotBeforeHide: state.settings.shotBeforeHide,
      shotLibrary: !!(window.YB && window.YB.shots),
      shotWaitVisibleMs: (window.YB && window.YB.shots && window.YB.shots.WAIT_VISIBLE_MS) || 0,
      documentVisibility: document.visibilityState,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      actionDelayMs: state.settings.actionDelayMs,
      checkTitle: state.settings.checkTitle,
      checkThumbOcr: state.settings.checkThumbOcr,
      checkSemanticImage: state.settings.checkSemanticImage,
      checkSpeech: state.settings.checkSpeech,
      keywords: state.keywords.slice(),
      imageKeywords: state.imageKeywords.slice(),
      exceptions: state.allEntries.filter(e => e.exceptions.length).length,
      semanticReady: state.semanticReady,
      semanticFailed: state.semanticFailed,
      processedCount: state.processed.size,
      hiddenIds: state.hiddenIds.size,
      pendingShots: state.pending.size,
      pendingRuns: state.pendingRuns,
      lastPendingError: state.lastPendingError,
      ioSeen: state.ioSeen,
      ioExtractNull: state.ioExtractNull,
      processStarted: state.processStarted,
      lastProcessError: state.lastProcessError,
      aiBlockedIds: state.aiBlockedIds.size,
      aiOverlay: !!state.aiOverlay,
      promoSuspects: state.suspects.length
    }),
    scan: () => {
      const out = [];
      for (const item of document.querySelectorAll(ITEM_SELECTOR)) {
        const hidden = item.classList.contains('yb-hidden');
        const v = extract(item);
        if (!v) { out.push({ status: 'extract-null', hidden }); continue; }
        const hit = matchTitle(v);
        const key = v.videoId + '|' + v.title.slice(0, 100) + '|' + v.thumb;
        out.push({
          status: hit ? 'MATCH' : 'no-match',
          keyword: hit ? hit.keyword : '',
          badge: matchBadge({ item }),
          processed: state.processed.has(key),
          reason: state.processed.get(key) || null,
          id: v.videoId,
          title: v.title.slice(0, 70),
          hidden
        });
      }
      console.table(out);
      return { total: out.length, matches: out.filter(r => r.status === 'MATCH').length, items: out };
    },
    promoSuspects: () => state.suspects.slice(),
    /* Aggregat für Tests: nutzt exakt extract/matchBadge/processed des Contents. */
    audit: () => {
      const res = {
        members: 0, membersHidden: 0, membersProcessedUnhidden: [],
        ai: 0, aiHidden: 0, aiProcessedUnhidden: [],
        promo: 0, promoHidden: 0, promoProcessedUnhidden: [],
        nonMembersHidden: []
      };
      for (const item of document.querySelectorAll(ITEM_SELECTOR)) {
        const v = extract(item);
        if (!v) continue;
        const badge = matchBadge({ item });
        const promo = state.settings.hidePromoted ? window.YB.promo.analyze(item, { title: v.title }) : null;
        const promoHit = !!(promo && promo.isHit);
        const key = v.videoId + '|' + v.title.slice(0, 100) + '|' + v.thumb;
        const hidden = item.classList.contains('yb-hidden');
        if (badge === 'members-only') {
          res.members++;
          if (hidden) res.membersHidden++;
          else if (state.processed.has(key)) res.membersProcessedUnhidden.push(v.title.slice(0, 60));
        } else if (badge === 'ai-generated') {
          res.ai++;
          if (hidden) res.aiHidden++;
          else if (state.processed.has(key)) res.aiProcessedUnhidden.push(v.title.slice(0, 60));
        } else if (promoHit) {
          res.promo++;
          if (hidden) res.promoHidden++;
          else if (state.processed.has(key)) res.promoProcessedUnhidden.push(v.title.slice(0, 60));
        } else if (hidden) {
          res.nonMembersHidden.push(v.title.slice(0, 60));
        }
      }
      return res;
    }
  };

  loadConfig().then(() => {
    if (state.settings.enabled && hasDetectionTargets()) startObservers();
    scheduleWatchAiCheck(0);
  }).catch(e => {
    if (isContextInvalidated(e)) disposeInstance();
    else log('config load failed', e.message);
  });

  function disposeInstance() {
    if (state.disposed) return;
    state.disposed = true;
    try { if (state.observer) state.observer.disconnect(); } catch (e) { /* bereits getrennt */ }
    try { if (state.io) { state.io.disconnect(); state.io = null; } } catch (e) { /* bereits getrennt */ }
    clearTimeout(state.scanTimer);
    clearTimeout(state.pendingTimer);
    clearTimeout(state.watchAiTimer);
    clearTimeout(state.suspectTimer);
    clearTimeout(configReloadTimer);
    state.pending.clear();
    removeAiOverlay();
    state.observer = null;
  }

  /* Übergabe-Handle für die nächste Version (siehe Kopf dieses Skripts): Eine
     nach einem Update neu injizierte Instanz ruft dispose() auf und übernimmt
     die Seite, ohne dass zwei Instanzen parallel arbeiten. */
  window.YB = window.YB || {};
  window.YB.__instance = {
    version: VERSION,
    dispose: disposeInstance
  };
})();
