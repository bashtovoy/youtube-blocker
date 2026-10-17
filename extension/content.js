/* content.js — Erkennung im Scrollbereich, Kaskade Text → Bild → OCR → Sprache, danach offizielles „Kein Interesse“ */
(function () {
  'use strict';

  const api = (typeof browser !== 'undefined') ? browser : chrome;
  const DEFAULTS = {
    enabled: true,
    mode: 'dismiss',
    fuzzy: true,
    checkTitle: true,
    checkThumbOcr: false,
    checkSemanticImage: true,
    checkSpeech: false,
    hideMembersOnly: false,
    ocrLangs: 'eng+rus',
    semanticMargin: 0.1,
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
    inFlight: new Set(),
    lastActionAt: 0,
    observer: null,
    io: null,
    observed: new WeakSet(),
    retryCounts: new WeakMap(),
    imageListeners: new WeakSet(),
    scanTimer: null,
    imageCache: new Map(),
    titleKeywords: [],
    imageKeywords: [],
    ocrKeywords: [],
    semanticKeywordsKey: '',
    semanticReady: false,
    semanticFailed: false,
    semanticRetryNeeded: false,
    ocrFailed: false
  };

  const log = (...a) => {
    console.log('[YB]', ...a);
    if (window.YB.dev) window.YB.dev.log(a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' '));
  };

  function hasDetectionTargets() {
    return state.keywords.length > 0 || state.settings.hideMembersOnly;
  }

  /* YouTube hat die Badges auf neue View-Model-Komponenten umgestellt:
     <badge-shape class="ytBadgeShapeHost ..."><div class="ytBadgeShapeText">Members only</div></badge-shape>
     innerhalb von yt-badge-view-model / yt-content-metadata-view-model. Der alte
     ytd-badge-supported-renderer-Vorfahre existiert nicht mehr, daher suchen wir den Badge selbst. */
  const BADGE_SELECTOR = 'badge-shape, yt-badge-view-model, .ytBadgeShapeText, .yt-badge-shape__text';
  const MEMBERS_ONLY_RE = /members?\s*only|member-only|für mitglieder|для учасників|для участников|учасник|участник|член/i;

  function matchBadge(v) {
    if (!state.settings.hideMembersOnly || !v.item) return null;
    for (const b of v.item.querySelectorAll(BADGE_SELECTOR)) {
      const txt = (b.textContent || '').trim();
      if (MEMBERS_ONLY_RE.test(txt)) return 'members-only';
    }
    return null;
  }

  async function loadConfig() {
    const data = await api.storage.local.get({ settings: DEFAULTS, keywords: [] });
    state.settings = Object.assign({}, DEFAULTS, data.settings || {});
    const kwObjects = (data.keywords || [])
      .map(k => typeof k === 'string' ? { text: k, enabled: true } : k)
      .filter(k => k && k.text && k.enabled !== false);
    state.keywords = kwObjects.map(k => String(k.text));
    /* Kanalspezifische Listen aus den optionalen Routen (matcher.channelKeywords):
       ohne Route gilt ein Schlüsselwort weiterhin für alle Kanäle. */
    state.titleKeywords = window.YB.matcher.channelKeywords(kwObjects, 'title');
    state.imageKeywords = window.YB.matcher.channelKeywords(kwObjects, 'image');
    state.ocrKeywords = window.YB.matcher.channelKeywords(kwObjects, 'ocr');
    state.semanticKeywordsKey = '';
    state.semanticReady = false;
    state.semanticFailed = false;
    state.semanticRetryNeeded = false;
    state.ocrFailed = false;
    log('config loaded', {
      keywords: state.keywords.length,
      title: state.titleKeywords.length,
      image: state.imageKeywords.length,
      ocr: state.ocrKeywords.length
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

  async function applyAction(v, reason) {
    return actionQueue.push(async () => {
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
      window.YB.dismiss.hideItem(v.item);
      state.hiddenIds.add(v.videoId);
      log('hidden locally', v.videoId, '←', reason);
      api.runtime.sendMessage({ type: 'ybincrement', by: 1, kind: 'hidden' }).catch(() => {});
      return false;
    });
  }

  function matchTitle(v) {
    if (!state.settings.checkTitle) return null;
    const opt = { fuzzy: state.settings.fuzzy };
    const t = window.YB.matcher.matchKeywords(v.title, state.titleKeywords, opt);
    if (t) return { source: 'title', keyword: t };
    if (v.channel) {
      const c = window.YB.matcher.matchKeywords(v.channel, state.titleKeywords, opt);
      if (c) return { source: 'channel', keyword: c };
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
        const m = window.YB.semantic.marginDecision(scores, state.settings.semanticMargin);
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
        const kw = window.YB.matcher.matchKeywords(text, state.ocrKeywords, { fuzzy: false });
        if (kw) return { source: 'ocr', keyword: kw };
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
    if (!state.settings.checkSpeech || !window.YB.speech.isAvailable() || !state.keywords.length) return null;
    try {
      const text = await window.YB.speech.transcribeVideo(v.videoId, state.settings.speechMaxSeconds);
      const kw = window.YB.matcher.matchKeywords(text, state.keywords, { fuzzy: state.settings.fuzzy });
      if (kw) return { source: 'speech', keyword: kw };
    } catch (e) { log('speech fail', v.videoId, e.message); }
    return null;
  }

  async function processVideo(v) {
    if (!v) return;
    await waitForImage(v.img).catch(() => false);
    const current = extract(v.item) || v;
    const key = current.videoId + '|' + current.title.slice(0, 100) + '|' + current.thumb;
    if (state.inFlight.has(key)) return;
    if (state.processed.has(key)) {
      /* YouTube rendert Karten neu (Shelf-/Feed-Recycling) und verliert dabei unsere Klasse.
         Bereits getroffene Karten lokal erneut ausblenden — ohne zweites offizielles Signal
         und ohne den Zähler erneut zu erhöhen. */
      const reason = state.processed.get(key);
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
        await applyAction(current, badgeHit);
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
    if (!state.settings.enabled || !hasDetectionTargets()) return;
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
      if (state.observed.has(item)) continue;
      state.observed.add(item);
      obs.observe(item);
    }
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

  api.runtime.onMessage.addListener(msg => {
    if (!msg) return;
    if (msg.type === 'config-changed') {
      state.processed.clear();
      speechInitTried = false;
      resetIO();
      loadConfig().then(scheduleScan);
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
      checkTitle: state.settings.checkTitle,
      fuzzy: state.settings.fuzzy,
      keywords: state.keywords.slice(),
      processedCount: state.processed.size
    }),
    scan: () => {
      const out = [];
      for (const item of document.querySelectorAll(ITEM_SELECTOR)) {
        const hidden = item.classList.contains('yb-hidden');
        const v = extract(item);
        if (!v) { out.push({ status: 'extract-null', hidden }); continue; }
        const hit = matchTitle(v);
        out.push({
          status: hit ? 'MATCH' : 'no-match',
          keyword: hit ? hit.keyword : '',
          id: v.videoId,
          title: v.title.slice(0, 70),
          hidden
        });
      }
      console.table(out);
      return { total: out.length, matches: out.filter(r => r.status === 'MATCH').length, items: out };
    }
  };

  loadConfig().then(() => {
    if (state.settings.enabled && (state.keywords.length || state.settings.hideMembersOnly)) startObservers();
  });
})();
