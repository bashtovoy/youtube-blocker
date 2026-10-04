/* speech.js — опциональное распознавание речи из видео через whisper.cpp (WASM) в воркере */
(function () {
  'use strict';

  const SPEECH_WORKER_SRC = `
    let whisper = null;
    let last = '';
    self.onmessage = async function (e) {
      const msg = e.data;
      try {
        if (msg.type === 'init') {
          importScripts(msg.libUrl);
          const resp = await fetch(msg.modelUrl);
          const buf = await resp.arrayBuffer();
          whisper = new Whisper(msg.libUrl.replace(/whisper\\.js$/, ''), {
            simulateRandomReadOrWriteFile: false,
            simulateFileDefinedReadOrWriteFile: false,
            writeFile: false,
            readFile: false
          });
          await whisper.fetchModel(new File([buf], 'model.ggml', { type: 'application/octet-stream' }));
          whisper.language = msg.language || 'ru';
          whisper.threadCount = msg.threadCount || 2;
          self.postMessage({ type: 'ready' });
        } else if (msg.type === 'transcribe') {
          /* msg.audio: Float32Array mono 16k (transferable) */
          await whisper.preprocess({ audio: msg.audio });
          let text = '';
          for (let seg = 0; ; seg++) {
            const done = await whisper.process(seg);
            if (done && done !== true && done.noMoreData) break;
            const s = whisper.getSegment(seg);
            if (!s) break;
            text += (s.text || '') + ' ';
          }
          last = text;
          self.postMessage({ type: 'result', id: msg.id, text });
        }
      } catch (err) {
        self.postMessage({ type: 'error', id: msg.id, error: String(err && err.message || err) });
      }
    };
  `;

  function YB() { return window.YB = window.YB || {}; }

  class SpeechManager {
    constructor() {
      this.worker = null;
      this.ready = false;
      this.jobs = new Map();
      this.seq = 0;
      this.failed = false;
    }

    _create(opts) {
      const blob = new Blob([SPEECH_WORKER_SRC], { type: 'text/javascript' });
      const w = new Worker(URL.createObjectURL(blob));
      w.onmessage = (e) => {
        const msg = e.data || {};
        if (msg.type === 'ready') this.ready = true;
        else if (msg.type === 'result' || msg.type === 'error') {
          const job = this.jobs.get(msg.id);
          if (job) {
            this.jobs.delete(msg.id);
            msg.type === 'result' ? job.resolve(msg.text) : job.reject(new Error(msg.error));
          }
        }
      };
      w.onerror = (e) => { this.failed = true; console.warn('[YB] speech worker error', e); };
      this.worker = w;
      w.postMessage({
        type: 'init',
        libUrl: browser.runtime.getURL('lib/whisper.js'),
        modelUrl: browser.runtime.getURL(opts.modelPath || 'models/ggml-base.bin'),
        language: opts.language || 'ru',
        threadCount: opts.threadCount || 2
      });
      return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const check = () => {
          if (this.ready) resolve();
          else if (this.failed || Date.now() - t0 > 120000) reject(new Error('speech init timeout'));
          else setTimeout(check, 300);
        };
        check();
      });
    }

    init(opts) {
      if (!this._p) this._p = this._create(opts).catch((e) => { this._p = null; throw e; });
      return this._p;
    }

    transcribe(audioF32) {
      if (!this.ready) return Promise.reject(new Error('speech not ready'));
      return new Promise((resolve, reject) => {
        const id = ++this.seq;
        this.jobs.set(id, { resolve, reject });
        this.worker.postMessage({ type: 'transcribe', id, audio: audioF32 }, [audioF32.buffer]);
      });
    }
  }

  const mgr = new SpeechManager();
  const queue = { tail: Promise.resolve(), push(fn) { const p = this.tail.then(fn, fn); this.tail = p.catch(() => {}); return p; } };

  /* Кэширование аудио по videoId, чтобы не качать одно и то же дважды */
  const audioCache = new Map();

  async function fetchAudio16k(videoId) {
    if (audioCache.has(videoId)) return audioCache.get(videoId);
    /* ищем audio-источник через внутренний player API YouTube */
    const page = await fetch('https://www.youtube.com/watch?v=' + videoId, { credentials: 'include' });
    const html = await page.text();
    const m = html.match(/"audioUrls":\s*\[(\{.*?\})\]/) || html.match(/(?:audioQuality|url)":\s*"([^"]+\.googlevideo\.com\/[^"]+?)"/);
    let audioUrl = null;
    if (m) {
      try {
        const obj = JSON.parse('[' + m[1] + ']');
        /* берём самый низкий битрейт (itag 140/141) — достаточно для речи */
        const pick = (obj.find(a => a.itag === 140) || obj[0]);
        audioUrl = pick && pick.url && pick.url.replace(/\\u0026/g, '&');
      } catch (e) {
        audioUrl = m[1] ? m[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&') : null;
      }
    }
    if (!audioUrl) {
      const direct = html.match(/"(https:\/\/[^"]+?googlevideo\.com\/[^"]+?)[^"]*itag=140[^"]*"/);
      if (direct) audioUrl = direct[1].replace(/\\u0026/g, '&');
    }
    if (!audioUrl) throw new Error('audio url not found');
    const resp = await fetch(audioUrl);
    const buf = await resp.arrayBuffer();
    const decoded = await new Promise((res, rej) => {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      ac.decodeAudioData(buf.slice(0)).then((b) => { ac.close(); res(b); }, (e) => { ac.close(); rej(e); });
    });
    /* ресемплим в моно 16 кГц */
    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    const f32 = rendered.getChannelData(0).slice(0);
    /* освобождаем память AudioContext'ов */
    audioCache.set(videoId, f32);
    if (audioCache.size > 4) {
      const first = audioCache.keys().next().value;
      audioCache.delete(first);
    }
    return f32;
  }

  YB().speech = {
    isAvailable() { return mgr.ready && !mgr.failed; },
    init(opts) { return queue.push(() => mgr.init(opts)); },
    /**
     * Распознать речь в видео (ограничиваем первые N секунд).
     * @returns {Promise<string>} текст
     */
    transcribeVideo(videoId, maxSeconds) {
      return queue.push(async () => {
        const audio = await fetchAudio16k(videoId);
        const limit = Math.min(audio.length, (maxSeconds || 120) * 16000);
        return mgr.transcribe(audio.slice(0, limit));
      });
    }
  };
})();
