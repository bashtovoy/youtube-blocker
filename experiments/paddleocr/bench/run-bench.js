#!/usr/bin/env node
/* CDP runner for the isolated OCR benchmark.
 *
 * One process = one arm.  Chrome is launched with a fresh profile, the page is
 * loaded from the local static server, and every image is processed through
 * the real browser code path.  Requests are recorded on the page and on
 * attached workers; any non-local request fails the offline assertion.
 *
 * Usage:
 *   node bench/run-bench.js --arm tess-161
 *   node bench/run-bench.js --arm paddle-eslav --limit 5
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'results', 'raw');
const manifestPath = path.resolve(here, '..', 'manifest.json');
const benchBase = 'http://127.0.0.1:8765/experiments/paddleocr/bench/index.html';

const CHROME = process.env.CHROME_BIN ||
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome');
const ARMS = new Set(['tess-fast', 'tess-161', 'paddle-en', 'paddle-eslav']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) out[key] = next, i++;
    else out[key] = true;
  }
  return out;
}

function connect(chrome) {
  let seq = 0;
  let buf = Buffer.alloc(0);
  const pending = new Map();
  const listeners = new Map();
  const attachedInfo = new Map();

  function on(method, fn) {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
    return () => {
      const arr = listeners.get(method) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  chrome.stdio[4].on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let i;
    while ((i = buf.indexOf(0)) >= 0) {
      const raw = buf.subarray(0, i).toString();
      buf = buf.subarray(i + 1);
      if (!raw) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of listeners.get(msg.method) || []) fn(msg.params, msg.sessionId);
      }
    }
  });

  chrome.stderr.on('data', (d) => {
    const s = String(d);
    if (/ERROR|FATAL/i.test(s)) process.stderr.write('[chrome] ' + s);
  });

  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error('CDP timeout: ' + method));
      }, 10 * 60 * 1000);
      pending.set(id, { resolve, reject, timer });
      const m = { id, method, params };
      if (sessionId) m.sessionId = sessionId;
      chrome.stdio[3].write(JSON.stringify(m) + '\0');
    });
  }

  return { send, on, attachedInfo };
}

async function main() {
  const args = parseArgs();
  const arm = String(args.arm || '');
  if (!ARMS.has(arm)) {
    throw new Error('--arm must be one of: ' + Array.from(ARMS).join(', '));
  }
  if (!fs.existsSync(CHROME)) throw new Error('Chrome not found: ' + CHROME);

  const variant = String(args.variant || '1280');
  if (!['1280', '480'].includes(variant)) {
    throw new Error('--variant must be 1280 or 480');
  }
  const benchUrl = benchBase + (variant === '480' ? '?fixtures=480' : '');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let items = manifest.items;
  if (args.ids) {
    const wanted = new Set(String(args.ids).split(',').map((s) => s.trim()).filter(Boolean));
    items = items.filter((item) => wanted.has(item.id));
  }
  if (args.limit) items = items.slice(0, Number(args.limit));
  if (!items.length) throw new Error('no manifest items selected');

  fs.mkdirSync(outDir, { recursive: true });
  const tag = args.tag ? '-' + String(args.tag).replace(/[^a-z0-9_-]/gi, '') : '';
  const outPath = path.join(outDir, arm + (variant === '480' ? '-480' : '') + tag + '.json');
  let state = {
    arm,
    variant,
    tag: tag || null,
    startedAt: new Date().toISOString(),
    chrome: CHROME,
    node: process.version,
    platform: process.platform + ' ' + process.arch,
    cpu: os.cpus()[0] ? os.cpus()[0].model : '',
    init: null,
    langInit: {},
    warmup: null,
    environment: null,
    images: [],
    requests: [],
    console: [],
    errors: [],
    offline: null,
  };
  let done = new Set();
  if (args.resume && fs.existsSync(outPath)) {
    const old = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    if (old.arm === arm) {
      state = { ...state, ...old, startedAt: state.startedAt };
      done = new Set((old.images || []).map((r) => r.id));
      console.log('resume: ' + done.size + ' images already done');
    }
  }
  const save = () => fs.writeFileSync(outPath, JSON.stringify(state, null, 2) + '\n');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yb-paddle-bench-'));
  const chrome = spawn(CHROME, [
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-default-apps',
    '--disable-gpu',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--remote-debugging-pipe',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });

  let closing = false;
  chrome.on('exit', (code) => {
    if (!closing && code) process.stderr.write('Chrome exited: ' + code + '\n');
  });

  const cdp = connect(chrome);
  const requests = [];
  const consoleLines = [];
  const errors = [];
  const requestKeys = new Set();
  let pageSession = null;

  cdp.on('Target.attachedToTarget', (p) => {
    cdp.attachedInfo.set(p.targetInfo.targetId, p.targetInfo);
    const child = p.sessionId;
    cdp.send('Runtime.enable', {}, child).catch(() => {});
    cdp.send('Network.enable', {}, child).catch(() => {});
    cdp.send('Log.enable', {}, child).catch(() => {});
    cdp.send('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
    }, child).catch(() => {});
  });
  cdp.on('Network.requestWillBeSent', (p, sessionId) => {
    const req = p.request || {};
    const url = String(req.url || '');
    /* The Tesseract core is injected as an embedded data: URL.  It can be
       several megabytes and is not a network request; do not store it. */
    if (/^(data|blob|filesystem):/i.test(url)) return;
    const key = (sessionId || '') + '\u0001' + url + '\u0001' + (p.requestId || '');
    if (requestKeys.has(key)) return;
    requestKeys.add(key);
    requests.push({
      url,
      method: req.method || '',
      type: p.type || '',
      session: sessionId || '',
      initiator: p.initiator ? p.initiator.type : '',
    });
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || '')).join(' ');
    consoleLines.push('[console.' + p.type + '] ' + text);
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    errors.push('[exception] ' + ((p.exceptionDetails && p.exceptionDetails.text) || '?'));
  });
  cdp.on('Log.entryAdded', (p) => {
    if (p && p.entry) consoleLines.push('[log] ' + p.entry.text);
  });

  function evaluate(expression) {
    return cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, pageSession).then((res) => {
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        throw new Error('page exception: ' + (d.text || '') + ' ' +
          ((d.exception && d.exception.description) || ''));
      }
      return res.result ? res.result.value : undefined;
    });
  }

  try {
      await sleep(600);
    const version = await cdp.send('Browser.getVersion');
    state.environment = {
      browser: version.product,
      protocol: version.protocolVersion,
      userAgent: version.userAgent,
    };
    const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', {
      targetId: target.targetId, flatten: true,
    });
    pageSession = attached.sessionId;
    await cdp.send('Runtime.enable', {}, pageSession);
    await cdp.send('Page.enable', {}, pageSession);
    await cdp.send('Network.enable', {}, pageSession);
    await cdp.send('Log.enable', {}, pageSession);
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, pageSession);
    await cdp.send('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
    }, pageSession);

    const loaded = new Promise((resolve) => {
      const off = cdp.on('Page.loadEventFired', (p, sessionId) => {
        if (sessionId !== pageSession) return;
        off();
        resolve();
      });
    });
    await cdp.send('Page.navigate', { url: benchUrl }, pageSession);
    await loaded;
    for (let i = 0; i < 100; i++) {
      const t = await evaluate('typeof BENCH');
      if (t === 'object') break;
      if (i === 99) throw new Error('BENCH did not load');
      await sleep(100);
    }
    const env = await evaluate(`({
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory || null,
      crossOriginIsolated: self.crossOriginIsolated,
      heap: performance.memory ? {
        used: performance.memory.usedJSHeapSize,
        total: performance.memory.totalJSHeapSize,
        limit: performance.memory.jsHeapSizeLimit
      } : null
    })`);
    state.environment = { ...state.environment, ...env };
    save();

    console.log(`[${arm}] init`);
    state.init = await evaluate(`BENCH.init(${JSON.stringify(arm)})`);
    save();
    console.log(`[${arm}] init ${Math.round(state.init.ms)} ms`);

    console.log(`[${arm}] warm-up`);
    state.warmup = await evaluate(`BENCH.run(${JSON.stringify('2m5VsdwVd28')}, "en", ${JSON.stringify(arm)})`);
    save();

    state.environment.heapAfterInit = await evaluate(`performance.memory ? {
      used: performance.memory.usedJSHeapSize,
      total: performance.memory.totalJSHeapSize
    } : null`);
    save();

    let rusReady = false;
    const t0 = Date.now();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (done.has(item.id)) continue;
      if (arm.startsWith('tess') && item.lang === 'ru' && !rusReady) {
        console.log(`[${arm}] load rus model`);
        const r = await evaluate(`BENCH.ensureLang("rus")`);
        state.langInit.rus = r;
        rusReady = true;
        save();
      }
      const started = Date.now();
      let result;
      try {
        result = await evaluate(`BENCH.run(${JSON.stringify(item.id)}, ${JSON.stringify(item.lang)}, ${JSON.stringify(arm)})`);
      } catch (e) {
        errors.push('[run ' + item.id + '] ' + (e && e.message || e));
        state.errors = errors;
        save();
        console.error(`[${arm}] ${item.id} FAILED: ${e && e.message || e}`);
        continue;
      }
      result.manifest = {
        lang: item.lang,
        split: item.split,
        tags: item.tags,
        negative: !!item.negative,
        lines: item.lines,
        keywords: item.keywords,
      };
      result.wallMs = Date.now() - started;
      result.heap = await evaluate(`performance.memory ? {
        used: performance.memory.usedJSHeapSize,
        total: performance.memory.totalJSHeapSize
      } : null`);
      state.images.push(result);
      state.requests = requests;
      state.console = consoleLines.slice(-300);
      state.errors = errors;
      save();
      const chars = (result.text || '').replace(/\s+/g, ' ').trim().length;
      console.log(`[${arm}] ${i + 1}/${items.length} ${item.id} ${Math.round(result.ms)} ms ${chars} chars` +
        (result.plan ? ` (${result.plan})` : ''));
    }

    state.environment.heapAfterRuns = await evaluate(`performance.memory ? {
      used: performance.memory.usedJSHeapSize,
      total: performance.memory.totalJSHeapSize
    } : null`);
    state.requests = requests;
    state.console = consoleLines.slice(-300);
    state.errors = errors;
    state.offline = {
      ok: requests.every((r) => !/^https?:/i.test(r.url) || /^http:\/\/(127\.0\.0\.1|localhost):8765\//i.test(r.url)),
      external: requests.filter((r) => /^https?:/i.test(r.url) && !/^http:\/\/(127\.0\.0\.1|localhost):8765\//i.test(r.url)).map((r) => r.url),
      count: requests.length,
    };
    state.finishedAt = new Date().toISOString();
    state.elapsedSec = (Date.now() - t0) / 1000;
    save();
    console.log(`[${arm}] done: ${state.images.length} images, ${state.offline.count} requests, offline=${state.offline.ok}`);
    try { await evaluate('BENCH.finish()'); } catch (e) { /* ignore */ }
    try { await cdp.send('Browser.close'); } catch (e) { /* ignore */ }
    closing = true;
  } finally {
    closing = true;
    try { chrome.kill('SIGTERM'); } catch (e) { /* ignore */ }
    if (chrome.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => chrome.once('exit', resolve)),
        sleep(2500),
      ]);
    }
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    } catch (e) {
      /* Chrome may still hold a file for a moment; the profile is in TMPDIR. */
    }
  }
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exitCode = 1;
});
