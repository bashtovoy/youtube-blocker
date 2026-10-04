/* content.js — оркестратор: сканирует выдачу YouTube, детектит совпадения, отправляет «Не интересно» */
(function () {
  'use strict';

  const api = (typeof browser !== 'undefined') ? browser : chrome;

  const DEFAULTS = {
    enabled: true,
    mode: 'dismiss',            /* dismiss | hide */
    fuzzy: true,                /* нечёткое сравнение ключевых слов */
    checkTitle: true,
    checkThumbOcr: false,
    checkThumbHash: true,
    checkSpeech: false,
    ocrLangs: 'eng+rus',
    hashThreshold: 8,           /* расстояние Хэмминга для образцов фото (0..64) */
    speechLang: 'ru',
    speechModel: 'models/ggml-base.en.q8_0.bin',
    speechMaxSeconds: 120,
    actionDelayMs: 2500,        /* пауза между отправкой сигналов */
    logMatch: true
  };

  const state = {
    settings: Object.assign({}, DEFAULTS),
    keywords: [],
    photoSamples: [],           /* [{id, hash, label, dataUrl}] */
    processed: new Set(),       /* videoId|signature уже проверенных */
    inFlight: new Set(),
    lastActionAt: 0,
    observer: null,
    io: null,                   /* IntersectionObserver — обрабатываем только видимое */
    observed: new WeakSet(),    /* карточки, уже поставленные на наблюдение */
    scanTimer: null
  };

  const log = (...a) => {
    const line = a.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
    console.log('[YB]', ...a);
    if (window.YB.dev) window.YB.dev.log(line);
  };

  /* ---------- конфигурация ---------- */

  async function loadConfig() {
    const data = await api.storage.local.get({
      settings: DEFAULTS,
      keywords: [],
      photoSamples: []
    });
    state.settings = Object.assign({}, DEFAULTS, data.settings || {});
    state.keywords = (data.keywords || [])
      .map(k => (typeof k === 'string' ? { text: k, enabled: true } : k))
      .filter(k => k && k.text && k.enabled !== false)
      .map(k => k.text);
    state.photoSamples = data.photoSamples || [];
    log('config loaded', { keywords: state.keywords.length, photos: state.photoSamples.length });
    if (state.settings.checkSpeech && state.settings.enabled && hasDetectionTargets()) {
      api.runtime.sendMessage({ type: 'ybcfg', cfg: { keywords: state.keywords, settings: state.settings } }).catch(() => {});
      initSpeechSoon();
    }
  }

  function hasDetectionTargets() {
    return state.keywords.length > 0 || state.photoSamples.length > 0;
  }

  let speechInitTried = false;
  function initSpeechSoon() {
    if (speechInitTried) return;
    speechInitTried = true;
    /* инициализация тяжёлой модели — только когда страница простаивает */
    const go = () => window.YB.speech.init({
      modelPath: state.settings.speechModel,
      language: state.settings.speechLang,
      threadCount: 2
    }).then(() => log('speech model ready'))
      .catch(e => { log('speech init failed:', e.message); window.YB.speech.disabled = true; });
    if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 20000 });
    else setTimeout(go, 8000);
  }

  /* ---------- извлечение данных из элемента выдачи ---------- */

  const ITEM_SELECTOR = [
    'ytd-video-renderer',            /* поиск */
    'ytd-grid-video-renderer',       /* главная / канал */
    'ytd-rich-item-renderer',        /* home / subscriptions */
    'ytd-compact-video-renderer',    /* сайдбар просмотра */
    'ytd-playlist-panel-video-renderer'
  ].join(', ');

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
    const titleEl = item.querySelector('#video-title, yt-formatted-string#video-title, h3.ytd-rich-item-renderer');
    const title = (titleEl && (titleEl.getAttribute('title') || titleEl.textContent) || '').trim();
    if (!title) return null;
    const chanEl = item.querySelector('ytd-channel-name #text a, #channel-name a, a[href^="/@"]');
    const channel = ((chanEl && chanEl.textContent) || '').replace(/\s+/g, ' ').trim();
    const img = item.querySelector('img[src]');
    let thumb = img ? (img.getAttribute('src') || '') : '';
    if (!thumb || thumb.startsWith('data:')) {
      thumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    } else {
      thumb = thumb.replace(/=w\d+-h\d+[^:]*$/, '=w480-h270-c36-far-c');
    }
    return { videoId, title, channel, thumb, item };
  }

  /* ---------- детект и действие ---------- */

  async function throttleAction() {
    const wait = state.settings.actionDelayMs - (Date.now() - state.lastActionAt);
    if (wait > 0) await window.YB.dismiss.sleep(wait);
    state.lastActionAt = Date.now();
  }

  async function applyAction(v, reason) {
    await throttleAction();
    if (state.settings.mode === 'dismiss') {
      try {
        await window.YB.dismiss.notInterested(v.item);
        /* верификация: YouTube обязан показать снэкбар с «Отменить» */
        if (await window.YB.dismiss.waitForUndo(v.item)) {
          log('dismissed', v.videoId, '←', reason);
          api.runtime.sendMessage({ type: 'ybincrement', by: 1 }).catch(() => {});
          return;
        }
        log('dismiss unverified, fallback to hide:', v.videoId);
      } catch (e) {
        log('dismiss failed, fallback to hide:', v.videoId, e.message);
      }
    }
    window.YB.dismiss.hideItem(v.item);
    log('hidden', v.videoId, '←', reason);
    api.runtime.sendMessage({ type: 'ybincrement', by: 1 }).catch(() => {});
  }

  function matchTitle(v) {
    if (!state.settings.checkTitle) return null;
    const opt = { fuzzy: state.settings.fuzzy };
    const t = window.YB.matcher.matchKeywords(v.title, state.keywords, opt);
    if (t) return t;
    if (v.channel) {
      const c = window.YB.matcher.matchKeywords(v.channel, state.keywords, opt);
      if (c) return c;
    }
    return null;
  }

  async function matchThumbnail(v) {
    const hashNeeded = state.settings.checkThumbHash && state.photoSamples.length > 0;
    const ocrNeeded = state.settings.checkThumbOcr && state.keywords.length > 0;
    if (!hashNeeded && !ocrNeeded) return null;

    if (hashNeeded) {
      try {
        const hash = await window.YB.image.hashFromUrl(v.thumb);
        const m = window.YB.image.matchHash(hash, state.photoSamples, state.settings.hashThreshold);
        if (m) return { source: 'photo', keyword: m.sample.label || 'образец фото', distance: m.distance };
      } catch (e) { /* CORS/404 — пробуем OCR, если нужен */ }
    }
    if (ocrNeeded) {
      try {
        const text = await window.YB.ocr.recognizeUrl(v.thumb, v.videoId + ':' + state.settings.ocrLangs, state.settings.ocrLangs);
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
    const key = v.videoId + '|' + (v.title || '').slice(0, 60);
    if (state.processed.has(key) || state.inFlight.has(key)) return;
    state.inFlight.add(key);
    try {
      /* 1. быстрая проверка по названию */
      const titleKw = matchTitle(v);
      if (titleKw) {
        state.processed.add(key);
        await applyAction(v, 'title:' + titleKw);
        return;
      }
      /* 2. фото: хэш-образцы + OCR */
      const thumbHit = await matchThumbnail(v);
      if (thumbHit) {
        state.processed.add(key);
        await applyAction(v, thumbHit.source + ':' + thumbHit.keyword);
        return;
      }
      /* 3. речь — только если видео уже попало в зону видимости и режим включён */
      if (state.settings.checkSpeech) {
        const speechHit = await matchSpeech(v);
        if (speechHit) {
          state.processed.add(key);
          await applyAction(v, speechHit.source + ':' + speechHit.keyword);
          return;
        }
      }
      state.processed.add(key);
    } finally {
      state.inFlight.delete(key);
      /* элемент обработан — снимаем его с наблюдения, чтобы не держать в IO */
      if (state.io && v.item) state.io.unobserve(v.item);
    }
  }

  /* ---------- сканирование: наблюдение за зоной видимости ---------- */

  function ensureIO() {
    if (state.io) return state.io;
    /* rootMargin: запас сверху 600px и снизу 900px — успеваем проверить
       миниатюру немного до того, как карточка реально появится на экране */
    state.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const v = extract(e.target);
        if (v) processVideo(v);
      }
    }, { root: null, rootMargin: '600px 0px 900px 0px', threshold: 0.01 });
    return state.io;
  }

  function resetIO() {
    if (state.io) { state.io.disconnect(); state.io = null; }
    state.observed = new WeakSet();
  }

  function scanNow() {
    if (!state.settings.enabled || !hasDetectionTargets()) return;
    const obs = ensureIO();
    const items = document.querySelectorAll(ITEM_SELECTOR);
    for (const item of items) {
      if (item.classList.contains('yb-hidden')) continue;
      if (state.observed.has(item)) continue;
      state.observed.add(item);
      obs.observe(item);
    }
  }

  function scheduleScan() {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(scanNow, 400);
  }

  function startObservers() {
    if (state.observer) return;
    state.observer = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.addedNodes && m.addedNodes.length) { scheduleScan(); return; }
      }
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
    /* scroll-слушатель убран: саму видимость отслеживает IntersectionObserver,
       а новые карточки в DOM добавляет YouTube → ловит MutationObserver */
    scanNow();
  }

  /* ---------- сообщения и изменения настроек ---------- */

  api.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'config-changed') {
      state.processed.clear();
      resetIO();
      loadConfig().then(scheduleScan);
    } else if (msg.type === 'rescan' || msg.type === 'dev-rescan') {
      state.processed.clear();
      resetIO();
      startObservers();
      scanNow();
    }
  });

  /* ---------- старт ---------- */
  loadConfig().then(() => {
    if (state.settings.enabled && hasDetectionTargets()) startObservers();
  });
})();
