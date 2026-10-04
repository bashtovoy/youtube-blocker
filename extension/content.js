/* content.js — детект в зоне прокрутки, каскад текст → image → OCR → речь, затем штатное «Не интересно» */
(function () {
  'use strict';

  const api = (typeof browser !== 'undefined') ? browser : chrome;
  const DEFAULTS = {
    enabled: true,
    mode: 'dismiss',
    fuzzy: true,
    checkTitle: true,
    checkThumbOcr: false,
    checkThumbHash: true,
    checkSemanticImage: true,
    checkSpeech: false,
    ocrLangs: 'eng+rus',
    hashThreshold: 8,
    semanticThreshold: 0.82,
    speechLang: 'ru',
    speechModel: 'models/ggml-base.bin',
    speechMaxSeconds: 120,
    actionDelayMs: 2500,
    logMatch: true
  };

  const state = {
    settings: Object.assign({}, DEFAULTS),
    keywords: [],
    photoSamples: [],
    processed: new Set(),
    inFlight: new Set(),
    lastActionAt: 0,
    observer: null,
    io: null,
    observed: new WeakSet(),
    imageListeners: new WeakSet(),
    scanTimer: null,
    imageCache: new Map()
  };

  const log = (...a) => {
    console.log('[YB]', ...a);
    if (window.YB.dev) window.YB.dev.log(a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' '));
  };

  function hasDetectionTargets() {
    return state.keywords.length > 0 || state.photoSamples.length > 0;
  }

  async function loadConfig() {
    const data = await api.storage.local.get({ settings: DEFAULTS, keywords: [], photoSamples: [] });
    state.settings = Object.assign({}, DEFAULTS, data.settings || {});
    state.keywords = (data.keywords || [])
      .map(k => typeof k === 'string' ? { text: k, enabled: true } : k)
      .filter(k => k && k.text && k.enabled !== false)
      .map(k => k.text);
    state.photoSamples = data.photoSamples || [];
    log('config loaded', { keywords: state.keywords.length, photos: state.photoSamples.length });
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
    'ytd-reel-item-renderer'
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

  function extract(item) {
    const a = item.querySelector('a#video-title, a#thumbnail, a.yt-simple-endpoint[href*="videoId"], a[href*="/watch"], a[href*="/shorts/"]');
    if (!a) return null;
    const href = a.getAttribute('href') || '';
    let videoId = a.getAttribute('data-video-id') || '';
    if (!videoId) {
      const m = href.match(/[?&]v=([\w-]{11})/) || href.match(/\/shorts\/([\w-]{11})/);
      videoId = m ? m[1] : '';
    }
    if (!videoId) return null;
    const titleEl = item.querySelector('#video-title, yt-formatted-string#video-title, h3.ytd-rich-item-renderer, [id="video-title"]');
    const title = (titleEl && (titleEl.getAttribute('title') || titleEl.textContent) || '').replace(/\s+/g, ' ').trim();
    if (!title) return null;
    const chanEl = item.querySelector('ytd-channel-name #text a, #channel-name a, a[href^="/@"], a[href*="/channel/"]');
    const channel = ((chanEl && chanEl.textContent) || '').replace(/\s+/g, ' ').trim();
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

  function thumbKey(v) {
    return v.videoId + '|' + v.thumb;
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
      log('hidden locally', v.videoId, '←', reason);
      api.runtime.sendMessage({ type: 'ybincrement', by: 1, kind: 'hidden' }).catch(() => {});
      return false;
    });
  }

  function matchTitle(v) {
    if (!state.settings.checkTitle) return null;
    const opt = { fuzzy: state.settings.fuzzy };
    const t = window.YB.matcher.matchKeywords(v.title, state.keywords, opt);
    if (t) return { source: 'title', keyword: t };
    if (v.channel) {
      const c = window.YB.matcher.matchKeywords(v.channel, state.keywords, opt);
      if (c) return { source: 'channel', keyword: c };
    }
    return null;
  }

  async function matchThumbnail(v) {
    const hashNeeded = state.settings.checkThumbHash && state.photoSamples.length > 0;
    const semanticNeeded = state.settings.checkSemanticImage && state.photoSamples.some(s => Array.isArray(s.embedding) && s.embedding.length);
    const ocrNeeded = state.settings.checkThumbOcr && state.keywords.length > 0;
    if (!hashNeeded && !semanticNeeded && !ocrNeeded) return null;
    if (hashNeeded) {
      try {
        const desc = await descriptorCached(v.thumb);
        const m = window.YB.image.matchHash(desc, state.photoSamples, state.settings.hashThreshold);
        if (m) return { source: 'photo', keyword: m.sample.label || 'образец фото', distance: m.distance, phashDistance: m.phashDistance };
      } catch (e) { log('image descriptor fail', v.videoId, e.message); }
    }
    if (semanticNeeded) {
      try {
        const vector = await window.YB.semantic.embed(v.thumb);
        const m = window.YB.semantic.bestMatch(vector, state.photoSamples, state.settings.semanticThreshold);
        if (m) return {
          source: 'semantic-image',
          keyword: m.sample.label || 'семантический образ',
          score: Number(m.score.toFixed(4))
        };
      } catch (e) { log('semantic image fail', v.videoId, e.message); }
    }
    if (ocrNeeded) {
      try {
        const text = await window.YB.ocr.recognizeUrl(v.thumb, thumbKey(v) + ':' + state.settings.ocrLangs, state.settings.ocrLangs);
        const kw = window.YB.matcher.matchKeywords(text, state.keywords, { fuzzy: false });
        if (kw) return { source: 'ocr', keyword: kw };
      } catch (e) { log('ocr fail', v.videoId, e.message); }
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
    if (state.processed.has(key) || state.inFlight.has(key)) return;
    state.inFlight.add(key);
    try {
      const titleHit = matchTitle(current);
      if (titleHit) {
        state.processed.add(key);
        await applyAction(current, titleHit.source + ':' + titleHit.keyword);
        return;
      }
      const thumbHit = await matchThumbnail(current);
      if (thumbHit) {
        state.processed.add(key);
        await applyAction(current, thumbHit.source + ':' + thumbHit.keyword);
        return;
      }
      if (state.settings.checkSpeech) {
        const speechHit = await matchSpeech(current);
        if (speechHit) {
          state.processed.add(key);
          await applyAction(current, speechHit.source + ':' + speechHit.keyword);
          return;
        }
      }
      state.processed.add(key);
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
        if (!v) continue;
        processVideo(v);
      }
    }, { root: null, rootMargin: '600px 0px 900px 0px', threshold: 0.01 });
    return state.io;
  }

  function resetIO() {
    if (state.io) { state.io.disconnect(); state.io = null; }
    state.observed = new WeakSet();
    state.imageListeners = new WeakSet();
    state.imageCache.clear();
  }

  function scanNow() {
    if (!state.settings.enabled || !hasDetectionTargets()) return;
    const obs = ensureIO();
    for (const item of document.querySelectorAll(ITEM_SELECTOR)) {
      if (item.classList.contains('yb-hidden') || state.observed.has(item)) continue;
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
      for (const m of muts) if (m.addedNodes && m.addedNodes.length) { scheduleScan(); return; }
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
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

  loadConfig().then(() => {
    if (state.settings.enabled && hasDetectionTargets()) startObservers();
  });
})();
