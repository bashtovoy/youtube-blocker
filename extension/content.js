/* content.js — Erkennung im Scrollbereich, Kaskade Text → Bild → OCR → Sprache, danach offizielles „Kein Interesse“ */
(function () {
  'use strict';

  const api = (typeof browser !== 'undefined') ? browser : chrome;

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
    fuzzy: true,
    checkTitle: true,
    checkThumbOcr: false,
    checkSemanticImage: true,
    checkSpeech: false,
    hideMembersOnly: false,
    hideAiGenerated: true,
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
    logMatch: true,
    allowAll: []
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
    shotShown: new WeakMap(),   /* Karte → „videoId|Grund“: nur ein Bild je Ausblendung */
    titleKeywords: [],
    imageKeywords: [],
    ocrKeywords: [],
    allEntries: [],
    titleEntries: [],
    imageEntries: [],
    ocrEntries: [],
    allowAll: [],
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
      api.storage.local.set({ promoSuspects: state.suspects.slice(0, max) }).catch(() => {});
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

  async function loadConfig() {
    const data = await api.storage.local.get({ settings: DEFAULTS, keywords: [], promoSuspects: [] });
    const s = Object.assign({}, DEFAULTS, data.settings || {});
    /* Alte Importe können Zahlfelder als leere Strings enthalten; sonst würde
       z. B. actionDelayMs die Pause zwischen Signalen stillschweigend abschalten. */
    s.actionDelayMs = settingNumber(s.actionDelayMs, DEFAULTS.actionDelayMs, 0, 60000);
    s.semanticMargin = settingNumber(s.semanticMargin, DEFAULTS.semanticMargin, 0, 1);
    s.speechMaxSeconds = settingNumber(s.speechMaxSeconds, DEFAULTS.speechMaxSeconds, 10, 600);
    s.hashThreshold = settingNumber(s.hashThreshold, 8, 0, 30);
    state.settings = s;
    state.allowAll = window.YB.matcher.normalizeAllowAll(s.allowAll);
    s.allowAll = state.allowAll;
    const kwObjects = (data.keywords || [])
      .map(k => typeof k === 'string' ? { text: k, enabled: true } : k)
      .filter(k => k && String(k.text || '').trim() && k.enabled !== false);
    state.suspects = Array.isArray(data.promoSuspects) ? data.promoSuspects : [];
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
      allowAll: state.allowAll.length,
      exceptions: state.allEntries.filter(e => e.exceptions.length).length
    });
    if (state.settings.checkSpeech && state.settings.enabled && state.keywords.length) {
      api.runtime.sendMessage({ type: 'ybcfg', cfg: { keywords: state.keywords, settings: state.settings } }).catch(() => {});
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
    let chanEl = item.querySelector('ytd-channel-name #text a, #channel-name a, a[href^="/@"], a[href*="/channel/"]');
    let channel = ((chanEl && chanEl.textContent) || '').replace(/\s+/g, ' ').trim();
    if (!channel) {
      const md = item.querySelector('.ytContentMetadataViewModelMetadataText');
      if (md) channel = (md.textContent || '').replace(/\s+/g, ' ').trim();
    }
    const img = item.querySelector('img');
    const thumb = bestThumbUrl(img, videoId);
    return { videoId, title, channel, thumb, item, img };
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
     deshalb wartet das Ausblenden, bis die Karte vollständig im Fenster liegt
     (ohne Scrollen, höchstens WAIT_VISIBLE_MS). Danach wird gespeichert und erst
     dann ausgeblendet; ein Fehler verhindert das Ausblenden nie. */
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

  async function captureBeforeHide(v, reason) {
    const shots = window.YB.shots;
    const item = v.item;
    if (!shots || !item) return false;
    if (!(await waitForCardVisible(item, shots.WAIT_VISIBLE_MS))) {
      log('shot skipped (card not fully visible)', v.videoId || 'slot', '←', reason);
      return false;
    }
    const r = item.getBoundingClientRect();
    const msg = {
      type: 'ybshot',
      videoId: v.videoId || '',
      reason,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
      viewport: { w: window.innerWidth, h: window.innerHeight }
    };
    try {
      const res = await withTimeout(api.runtime.sendMessage(msg), 6000);
      if (res && res.ok) {
        log('shot saved', res.file);
        return true;
      }
      log('shot failed', v.videoId || 'slot', (res && res.error) || 'keine Antwort');
    } catch (e) {
      log('shot failed', v.videoId || 'slot', e.message);
    }
    return false;
  }

  /* Wrapper: ohne Einstellung sofort ausblenden; sonst erst das Bild versuchen.
     Die Buchung im WeakMap verhindert Doppelbilder, wenn mehrere Pfade dieselbe
     Karte treffen (Badge + spätes Signal + Dismiss-Rückfall). */
  function hideLocally(v, reason) {
    const item = v.item;
    const stamp = shotStamp(v, reason);
    if (!shotsOn() || !item || state.shotShown.get(item) === stamp) {
      hideLocallyNow(v, reason);
      return;
    }
    state.shotShown.set(item, stamp);
    captureBeforeHide(v, reason).then(
      () => hideLocallyNow(v, reason),
      () => hideLocallyNow(v, reason)
    );
  }

  function hideLocallyNow(v, reason) {
    if (state.disposed) return;
    window.YB.dismiss.hideItem(v.item);
    if (v.videoId) state.hiddenIds.add(v.videoId);
    log('hidden locally', v.videoId, '←', reason);
    api.runtime.sendMessage({ type: 'ybincrement', by: 1, kind: 'hidden' }).catch(() => {});
  }

  async function applyAction(v, reason) {
    /* Bild vor dem „Kein Interesse“-Klick: Das Menü darf den Rahmen nicht verdecken.
       Das Warten auf die sichtbare Karte liegt außerhalb der Aktionswarteschlange,
       damit andere Karten nicht blockiert werden. */
    const stamp = shotStamp(v, reason);
    if (shotsOn() && v.item && state.shotShown.get(v.item) !== stamp) {
      state.shotShown.set(v.item, stamp);
      await captureBeforeHide(v, reason);
    }
    return actionQueue.push(async () => {
      if (state.disposed) return false;
      await throttleAction();
      if (state.settings.mode === 'dismiss') {
        try {
          const info = await window.YB.dismiss.notInterested(v.item);
          const result = await window.YB.dismiss.waitForOutcome(v.item, info.undoBefore);
          if (result.ok) {
            log('dismissed', v.videoId, '←', reason, result.via);
            api.runtime.sendMessage({ type: 'ybincrement', by: 1, kind: 'dismissed' }).catch(() => {});
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

  function matchTitle(v) {
    if (!state.settings.checkTitle) return null;
    const contextText = [v.title, v.channel].filter(Boolean).join(' ');
    const opt = { fuzzy: state.settings.fuzzy, contextText };
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
        const text = await window.YB.ocr.recognizeUrl(v.thumb, state.settings.ocrLangs);
        const trimmed = String(text || '').trim();
        log('ocr', v.videoId, trimmed.length + ' chars', (Date.now() - t0) + 'ms',
          trimmed ? '« ' + trimmed.slice(0, 60) + ' »' : '(kein Text)');
        const contextText = [v.title, v.channel, text].filter(Boolean).join(' ');
        const kw = window.YB.matcher.matchEntries(text, state.ocrEntries, { fuzzy: false, contextText });
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
      const kw = window.YB.matcher.matchEntries(text, state.allEntries, {
        fuzzy: state.settings.fuzzy,
        contextText
      });
      if (kw) return { source: 'speech', keyword: kw.text };
    } catch (e) { log('speech fail', v.videoId, e.message); }
    return null;
  }

  async function processVideo(v) {
    if (!v || state.disposed) return;
    await waitForImage(v.img).catch(() => false);
    const current = extract(v.item) || v;
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
        window.YB.dismiss.hideItem(current.item);
        log('re-hidden (re-render)', current.videoId, '←', reason);
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
      /* Globale Freigaben gelten für die ganze Karte: „No Tesla“ lässt auch
         Karten durch, die zusätzlich ein anderes Wort der Liste treffen.
         Badges und Werbekarten bleiben davon unberührt (oben geprüft). */
      const allowContext = [current.title, current.channel].filter(Boolean).join(' ');
      const allowTerm = window.YB.matcher.firstException(allowContext, state.allowAll);
      if (allowTerm) {
        state.processed.set(key, null);
        log('global allow', current.videoId, '←', allowTerm);
        if ((state.settings.hideMembersOnly || state.settings.hideAiGenerated || state.settings.hidePromoted) && current.item) {
          state.badgeWatched.add(current.item);
        }
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
        const v = extract(e.target);
        if (!v) {
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
        processVideo(v);
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

  function scanNow() {
    if (state.disposed || !state.settings.enabled || !hasDetectionTargets()) return;
    const obs = ensureIO();
    for (const item of document.querySelectorAll(ITEM_SELECTOR)) {
      if (item.classList.contains('yb-hidden')) continue;
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
      if (state.observed.has(item)) {
        /* Spät gerenderter Badge: Die Karte wurde bereits als „kein Treffer“
           verbucht, YouTube liefert den Badge aber erst danach nach. Nur
           vorgemerkte Karten erneut prüfen — billig, kein zweites OCR/Semantik. */
        if ((state.settings.hideMembersOnly || state.settings.hideAiGenerated || state.settings.hidePromoted) && state.badgeWatched.has(item)) {
          const hit = matchBadge({ item });
          if (hit) {
            state.badgeWatched.delete(item);
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
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(scanNow, 350);
  }

  function startObservers() {
    if (state.observer) { scanNow(); return; }
    state.observer = new MutationObserver(muts => {
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

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    /* Lebenszeichen: Popup und Hintergrund erkennen damit Tabs, in denen nach
       einem Update noch die alte (verwaiste) Instanz läuft, und Tabs, die die
       aktuelle Version bereits ausführen. */
    if (msg.type === 'ybping') {
      sendResponse({ ok: true, version: api.runtime.getManifest().version });
      return;
    }
    if (msg.type === 'config-changed') {
      state.processed.clear();
      speechInitTried = false;
      resetIO();
      loadConfig().then(() => {
        /* Wurde die Seite mit leerer Liste geöffnet, existiert noch kein
           MutationObserver. Ohne startObservers würden nur die bereits
           sichtbaren Karten geprüft und neue beim Scrollen nie erreicht. */
        if (state.settings.enabled && hasDetectionTargets()) startObservers();
        else scheduleScan();
      });
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
      hidePromoted: state.settings.hidePromoted,
      shotBeforeHide: state.settings.shotBeforeHide,
      actionDelayMs: state.settings.actionDelayMs,
      checkTitle: state.settings.checkTitle,
      checkThumbOcr: state.settings.checkThumbOcr,
      checkSemanticImage: state.settings.checkSemanticImage,
      checkSpeech: state.settings.checkSpeech,
      fuzzy: state.settings.fuzzy,
      keywords: state.keywords.slice(),
      imageKeywords: state.imageKeywords.slice(),
      allowAll: state.allowAll.slice(),
      exceptions: state.allEntries.filter(e => e.exceptions.length).length,
      semanticReady: state.semanticReady,
      semanticFailed: state.semanticFailed,
      processedCount: state.processed.size,
      hiddenIds: state.hiddenIds.size,
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
  });

  /* Übergabe-Handle für die nächste Version (siehe Kopf dieses Skripts): Eine
     nach einem Update neu injizierte Instanz ruft dispose() auf und übernimmt
     die Seite, ohne dass zwei Instanzen parallel arbeiten. */
  window.YB = window.YB || {};
  window.YB.__instance = {
    version: api.runtime.getManifest().version,
    dispose: () => {
      state.disposed = true;
      try { if (state.observer) state.observer.disconnect(); } catch (e) { /* bereits getrennt */ }
      try { if (state.io) { state.io.disconnect(); state.io = null; } } catch (e) { /* bereits getrennt */ }
      clearTimeout(state.scanTimer);
      state.observer = null;
    }
  };
})();
