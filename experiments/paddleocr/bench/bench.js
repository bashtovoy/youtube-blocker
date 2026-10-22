/* Browser-side benchmark harness for the isolated PaddleOCR experiment.
 *
 * Two arms are supported:
 *   - tess-fast: one Tesseract pass, exactly like the 1.6.1 fast pass
 *   - tess-161:  the adaptive 1.6.1 pipeline (fast + quick/full deep)
 *   - paddle-en / paddle-eslav: PaddleOCR.js PP-OCRv5
 *
 * The page never talks to the network.  The runner records every request and
 * fails the offline assertion if anything outside 127.0.0.1 is requested.
 */
(() => {
  'use strict';

  const LIB_DIR = '/extension/lib/';
  const WORKER_URL = '/extension/ocr-worker.js';
  const FIXTURE_SET = new URLSearchParams(location.search).get('fixtures') === '480'
    ? 'fixtures-480' : 'fixtures';
  const FIXTURE_DIR = '/experiments/paddleocr/' + FIXTURE_SET + '/';
  const MODEL_DIR = '/experiments/paddleocr/models/';
  const PADDLE_BUNDLE = '/experiments/paddleocr/bench/paddle.bundle.js';

  const OCR_PSM = '11';
  const OCR_DPI = '300';
  const FAST_MIN_CHARS = 16;
  const FAST_MIN_CONFIDENCE = 55;
  const FAST_MIN_WORD_CONFIDENCE = 60;
  const OCR_NOISE_RE = /[\[\]{}<>|~^]/;
  const QUICK_DEEP_MODES = ['gray', 'bright'];
  const FULL_DEEP_MODES = ['gray', 'red', 'bright', 'gray-inv', 'dark'];
  const DEEP_SCALE = 2;
  const DEEP_MAX_SIDE = 2600;
  const OCR_BORDER = 10;
  const MASK_MIN_COVERAGE = 0.0015;
  const MASK_MAX_COVERAGE = 0.70;
  const GRAY_MIN_COVERAGE = 0.0005;
  const GRAY_MAX_COVERAGE = 0.9995;

  const workers = new Map();
  let paddle = null;
  let paddleArm = '';
  let loadPromise = null;

  function log(...args) {
    console.log('[bench]', ...args);
  }

  function loadScript(src) {
    if (loadPromise) return loadPromise;
    loadPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('script failed: ' + src));
      document.head.appendChild(s);
    });
    return loadPromise;
  }

  function padBytesForOcr(bytes) {
    return (async () => {
      let bitmap;
      try {
        bitmap = await createImageBitmap(new Blob([bytes]));
      } catch (e) {
        return null;
      }
      try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width + OCR_BORDER * 2;
        canvas.height = bitmap.height + OCR_BORDER * 2;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, OCR_BORDER, OCR_BORDER);
        return canvas;
      } finally {
        if (typeof bitmap.close === 'function') bitmap.close();
      }
    })();
  }

  function pixelLuma(r, g, b) {
    return (r * 299 + g * 587 + b * 114) / 1000;
  }

  function makeBaseImage(bitmap) {
    const bw = Number(bitmap && bitmap.width) || 0;
    const bh = Number(bitmap && bitmap.height) || 0;
    if (!bw || !bh) return null;
    const maxSide = Math.max(bw, bh);
    const scale = Math.min(DEEP_SCALE, DEEP_MAX_SIDE / maxSide);
    const width = Math.max(1, Math.round(bw * scale));
    const height = Math.max(1, Math.round(bh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = true;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    if (!image || !image.data) return null;
    return { data: image.data, width, height };
  }

  function otsuThreshold(data, width, height) {
    const hist = new Uint32Array(256);
    const total = width * height;
    for (let i = 0; i < data.length; i += 4) {
      const l = Math.round(pixelLuma(data[i], data[i + 1], data[i + 2]));
      hist[Math.max(0, Math.min(255, l))]++;
    }
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0;
    let weightB = 0;
    let best = -1;
    let threshold = 127;
    for (let i = 0; i < 256; i++) {
      weightB += hist[i];
      if (!weightB) continue;
      const weightF = total - weightB;
      if (!weightF) break;
      sumB += i * hist[i];
      const meanB = sumB / weightB;
      const meanF = (sum - sumB) / weightF;
      const between = weightB * weightF * (meanB - meanF) * (meanB - meanF);
      if (between > best) {
        best = between;
        threshold = i;
      }
    }
    return threshold;
  }

  function variantCanvas(base, mode, threshold) {
    const { data, width, height } = base;
    const outW = width + OCR_BORDER * 2;
    const outH = height + OCR_BORDER * 2;
    const out = new Uint8ClampedArray(outW * outH * 4);
    out.fill(255);
    let foreground = 0;
    let i = 0;
    for (let y = 0; y < height; y++) {
      let o = ((y + OCR_BORDER) * outW + OCR_BORDER) * 4;
      for (let x = 0; x < width; x++, i += 4, o += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        let on = false;
        if (a >= 32) {
          const l = pixelLuma(r, g, b);
          if (mode === 'gray') on = l <= threshold;
          else if (mode === 'gray-inv') on = l > threshold;
          else if (mode === 'red') on = r >= 70 && r - Math.max(g, b) >= 20;
          else if (mode === 'bright') on = l >= 175 && (Math.max(r, g, b) - Math.min(r, g, b)) <= 90;
          else if (mode === 'dark') on = l <= 75;
        }
        if (on) {
          foreground++;
          out[o] = 0;
          out[o + 1] = 0;
          out[o + 2] = 0;
        }
      }
    }
    const coverage = foreground / (width * height);
    const min = (mode === 'gray' || mode === 'gray-inv') ? GRAY_MIN_COVERAGE : MASK_MIN_COVERAGE;
    const max = (mode === 'gray' || mode === 'gray-inv') ? GRAY_MAX_COVERAGE : MASK_MAX_COVERAGE;
    if (coverage < min || coverage > max) return null;
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const image = ctx.createImageData(outW, outH);
    image.data.set(out);
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  async function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas export failed'))), 'image/png');
    });
  }

  async function recognizePass(w, image) {
    const res = await w.recognize(image);
    const data = (res && res.data) || {};
    const confidence = Number(data.confidence);
    const words = Array.isArray(data.words) ? data.words.map((word) => {
      const wc = Number(word && word.confidence);
      return {
        text: String((word && word.text) || '').trim(),
        confidence: Number.isFinite(wc) ? wc : null,
      };
    }).filter((word) => word.text) : [];
    return {
      text: String(data.text || ''),
      confidence: Number.isFinite(confidence) ? confidence : null,
      words,
    };
  }

  async function recognizeCanvas(w, canvas) {
    try {
      return await recognizePass(w, canvas);
    } catch (e) {
      try {
        const blob = await canvasToPngBlob(canvas);
        return await recognizePass(w, new Uint8Array(await blob.arrayBuffer()));
      } catch (e2) {
        throw e;
      }
    }
  }

  async function deepPass(w, bytes, modes) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(new Blob([bytes]));
    } catch (e) {
      return [];
    }
    const out = [];
    try {
      const base = makeBaseImage(bitmap);
      if (!base) return out;
      const threshold = otsuThreshold(base.data, base.width, base.height);
      for (const mode of (modes || FULL_DEEP_MODES)) {
        const canvas = variantCanvas(base, mode, threshold);
        if (!canvas) continue;
        try {
          const res = await recognizeCanvas(w, canvas);
          const text = String(res.text || '').trim();
          if (text) out.push({ mode, text, confidence: res.confidence });
        } catch (e) {
          log('deep pass failed', mode, e && e.message);
        }
      }
    } finally {
      if (typeof bitmap.close === 'function') bitmap.close();
    }
    return out;
  }

  function deepPlan(text, confidence, words) {
    const s = String(text || '').trim();
    if (!s) return 'full';
    if (s.length < FAST_MIN_CHARS) return 'full';
    if (!/[\p{L}\p{N}]{3}/u.test(s)) return 'full';
    if (Number.isFinite(confidence) && confidence < FAST_MIN_CONFIDENCE) return 'full';
    if (OCR_NOISE_RE.test(s)) return 'quick';
    for (const word of words || []) {
      const wt = String(word && word.text || '').trim();
      const wc = Number(word && word.confidence);
      if (wt.length >= 3 && Number.isFinite(wc) && wc < FAST_MIN_WORD_CONFIDENCE) return 'quick';
    }
    return '';
  }

  function mergeTexts(texts) {
    const seen = new Set();
    const out = [];
    for (const raw of texts || []) {
      const text = String(raw || '').trim();
      if (!text) continue;
      const key = text.replace(/\s+/g, ' ').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
    return out.join('\n');
  }

  async function ensureTesseractWorker(lang) {
    if (workers.has(lang)) return workers.get(lang);
    if (!globalThis.Tesseract) throw new Error('Tesseract not loaded');
    const w = await Tesseract.createWorker({
      workerPath: WORKER_URL,
      corePath: LIB_DIR,
      langPath: LIB_DIR,
      gzip: true,
      workerBlobURL: false,
      logger: () => {},
    });
    try {
      await w.loadLanguage(lang);
      await w.initialize(lang);
      await w.setParameters({
        tessedit_pageseg_mode: OCR_PSM,
        user_defined_dpi: OCR_DPI,
        preserve_interword_spaces: '1',
        debug_file: '/dev/null',
      });
    } catch (e) {
      try { w.terminate(); } catch (e2) { /* ignore */ }
      throw e;
    }
    workers.set(lang, w);
    return w;
  }

  async function initTesseract(langs) {
    const t0 = performance.now();
    await loadScript(LIB_DIR + 'tesseract.min.js');
    for (const lang of (langs || ['eng'])) await ensureTesseractWorker(lang);
    return { ms: performance.now() - t0, langs: langs || ['eng'] };
  }

  async function ensureLang(lang) {
    const t0 = performance.now();
    await ensureTesseractWorker(lang);
    return { ms: performance.now() - t0, lang };
  }

  async function initPaddle(arm) {
    const t0 = performance.now();
    await loadScript(PADDLE_BUNDLE);
    const rec = arm === 'paddle-en'
      ? { name: 'en_PP-OCRv5_mobile_rec', url: MODEL_DIR + 'en_ppocrv5_mobile_rec.tar' }
      : { name: 'eslav_PP-OCRv5_mobile_rec', url: MODEL_DIR + 'eslav_ppocrv5_mobile_rec.tar' };
    paddle = await PaddleOCR.create({
      textDetectionModelName: 'PP-OCRv5_mobile_det',
      textDetectionModelAsset: { url: MODEL_DIR + 'ppocrv5_mobile_det.tar' },
      textRecognitionModelName: rec.name,
      textRecognitionModelAsset: { url: rec.url },
      textDetectionBatchSize: 1,
      textRecognitionBatchSize: 1,
      ortOptions: {
        backend: 'wasm',
        wasmPaths: '/experiments/paddleocr/bench/ort/',
        numThreads: 1,
        simd: true,
      },
    });
    paddleArm = arm;
    const init = await paddle.initialize();
    return { ms: performance.now() - t0, init };
  }

  async function runTesseract(id, lang, arm) {
    const primary = lang === 'ru' ? 'rus' : 'eng';
    const w = await ensureTesseractWorker(primary);
    const t0 = performance.now();
    const res = await fetch(FIXTURE_DIR + id + '.jpg', { cache: 'no-store' });
    if (!res.ok) throw new Error('fixture HTTP ' + res.status + ': ' + id);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const padded = await padBytesForOcr(bytes);
    const fast = padded ? await recognizeCanvas(w, padded) : await recognizePass(w, bytes);
    const texts = [fast.text];
    const plan = arm === 'tess-161' ? deepPlan(fast.text, fast.confidence, fast.words) : '';
    let deepResults = [];
    if (plan) {
      deepResults = await deepPass(w, bytes, plan === 'quick' ? QUICK_DEEP_MODES : FULL_DEEP_MODES);
      texts.push(...deepResults.map((r) => r.text));
    }
    const text = mergeTexts(texts);
    return {
      id,
      lang,
      arm,
      ms: performance.now() - t0,
      text,
      fastText: fast.text,
      confidence: fast.confidence,
      plan,
      deepModes: deepResults.map((r) => r.mode),
      deepTexts: deepResults,
    };
  }

  async function runPaddle(id, lang) {
    const t0 = performance.now();
    const res = await fetch(FIXTURE_DIR + id + '.jpg', { cache: 'no-store' });
    if (!res.ok) throw new Error('fixture HTTP ' + res.status + ': ' + id);
    const blob = await res.blob();
    const t1 = performance.now();
    const results = await paddle.predict(blob);
    const t2 = performance.now();
    const first = (results && results[0]) || { items: [] };
    const items = Array.isArray(first.items) ? first.items : [];
    const lines = items
      .map((item) => ({
        text: String((item && item.text) || '').trim(),
        score: Number(item && item.score),
        poly: item && item.poly,
      }))
      .filter((item) => item.text);
    return {
      id,
      lang,
      arm: paddleArm,
      ms: t2 - t0,
      predictMs: t2 - t1,
      text: lines.map((l) => l.text).join('\n'),
      lines,
      metrics: first.metrics,
      runtime: first.runtime,
    };
  }

  async function init(arm) {
    if (arm === 'tess-fast' || arm === 'tess-161') return initTesseract(['eng']);
    if (arm === 'paddle-en' || arm === 'paddle-eslav') return initPaddle(arm);
    throw new Error('unknown arm: ' + arm);
  }

  async function run(id, lang, arm) {
    if (arm === 'tess-fast' || arm === 'tess-161') return runTesseract(id, lang, arm);
    if (arm === 'paddle-en' || arm === 'paddle-eslav') return runPaddle(id, lang);
    throw new Error('unknown arm: ' + arm);
  }

  async function finish() {
    for (const w of workers.values()) {
      try { await w.terminate(); } catch (e) { /* ignore */ }
    }
    workers.clear();
    if (paddle) {
      try { await paddle.dispose(); } catch (e) { /* ignore */ }
    }
    paddle = null;
  }

  window.BENCH = { init, run, finish, ensureLang };
})();
