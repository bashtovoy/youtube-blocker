/* ocr.js — OCR миниатюр через Tesseract.js в отдельном воркере (blob-URL обходит CSP) */
(function () {
  'use strict';

  const OCR_WORKER_SRC = `
    importScripts(new URL(location.href).searchParams.get('lib'));
    let worker = null;
    self.onmessage = async function (e) {
      const msg = e.data;
      try {
        if (msg.type === 'init') {
          worker = await Tesseract.createWorker(msg.langs, 1, {
            langPath: msg.langPath,     /* локальные .traineddata.gz из папки lib, CDN — fallback */
            gzip: true,
            logger: m => self.postMessage({ type: 'log', m: { status: m.status } })
          });
          self.postMessage({ type: 'ready' });
        } else if (msg.type === 'recognize') {
          const { data } = await worker.recognize(msg.url);
          self.postMessage({ type: 'result', id: msg.id, text: data.text || '' });
        } else if (msg.type === 'terminate') {
          if (worker) { await worker.terminate(); worker = null; }
          self.postMessage({ type: 'terminated' });
          self.close();
        }
      } catch (err) {
        self.postMessage({ type: 'error', id: msg.id, error: String(err && err.message || err) });
      }
    };
  `;

  function YB() { return window.YB = window.YB || {}; }

  class OcrManager {
    constructor() {
      this.worker = null;
      this.ready = false;
      this.jobs = new Map();
      this.seq = 0;
      this.cache = new Map(); /* ocrUrl -> text */
      this.initPromise = null;
    }

    libUrl(name) {
      return browser.runtime.getURL('lib/' + name);
    }

    _create() {
      const blob = new Blob([OCR_WORKER_SRC], { type: 'text/javascript' });
      const url = this.libUrl('tesseract.min.js');
      const workerUrl = URL.createObjectURL(blob) + '?lib=' + encodeURIComponent(url);
      const w = new Worker(workerUrl);
      w.onmessage = (e) => {
        const msg = e.data || {};
        if (msg.type === 'ready') {
          this.ready = true;
          this._flush();
        } else if (msg.type === 'result' || msg.type === 'error') {
          const job = this.jobs.get(msg.id);
          if (job) {
            this.jobs.delete(msg.id);
            if (msg.type === 'result') {
              this.cache.set(job.key, msg.text);
              job.resolve(msg.text);
            } else {
              job.reject(new Error(msg.error));
            }
          }
        }
      };
      w.onerror = () => { this.ready = false; };
      this.worker = w;
      const libDir = this.libUrl('tesseract.min.js').replace(/[^/]*$/, '');
      w.postMessage({ type: 'init', langs: this.langs, langPath: libDir });
      return new Promise((resolve) => {
        const check = () => this.ready ? resolve() : setTimeout(check, 200);
        check();
      });
    }

    init(langs) {
      const want = langs || this.langs || 'eng+rus';
      /* уже инициализирован с теми же языками — ничего не делаем */
      if (this.initPromise && this.langs === want && this.worker) return this.initPromise;
      /* смена языков: пересоздаём воркер с новой конфигурацией */
      if (this.worker) {
        try { this.worker.terminate(); } catch (e) { /* noop */ }
        this.worker = null;
        this.ready = false;
      }
      this.langs = want;
      this.initPromise = this._create();
      return this.initPromise;
    }

    _flush() { /* очередь задач обрабатывается последовательно через pending */ }

    async recognize(url, key, langs) {
      if (this.cache.has(key)) return this.cache.get(key);
      await this.init(langs);
      return new Promise((resolve, reject) => {
        const id = ++this.seq;
        this.jobs.set(id, { key, resolve, reject });
        this.worker.postMessage({ type: 'recognize', id, url });
      });
    }
  }

  /* Последовательная очередь, чтобы не грузить CPU */
  class OcrQueue {
    constructor() { this.tail = Promise.resolve(); }
    push(fn) {
      const p = this.tail.then(fn, fn);
      this.tail = p.catch(() => {});
      return p;
    }
  }

  const mgr = new OcrManager();
  const queue = new OcrQueue();

  YB().ocr = {
    /**
     * Распознать текст с миниатюры.
     * @param {string} url доступный по CORS URL картинки
     * @param {string} key ключ кэша
     * @param {string} langs например 'eng+rus'
     */
    recognizeUrl(url, key, langs) {
      return queue.push(() => mgr.recognize(url, key, langs).catch(async (err) => {
        /* одна повторная попытка после реинита */
        if (String(err.message).includes('init')) throw err;
        return mgr.recognize(url, key, langs);
      }));
    },
    ensureInit(langs) { return mgr.init(langs); },
    cacheGet(key) { return mgr.cache.get(key); }
  };
})();
