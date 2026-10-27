/* e2e-chrome-face.js — echter Chrome-Test des MediaPipe-Face-Hosts.
   Prüft:
     - das Offscreen-Dokument lädt face-score.js/face-host.js,
     - prepare startet den Face Landmarker (CPU/WASM) aus dem lokalen Paket,
     - das Modell und beide Wasm-Dateien kommen ohne CDN/Netz aus,
     - der Status ist danach „ready“ und reset schließt das Modell.
   Kein YouTube-/Netzverkehr; ein Erkennungsbild ist für den Modellstart nicht
   nötig. Aufruf: node tests/e2e-chrome-face.js */

'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME_BIN ||
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome');

if (!fs.existsSync(CHROME)) {
  console.log('e2e-chrome-face: übersprungen (Chrome nicht gefunden: ' + CHROME + ')');
  process.exit(0);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yb-chrome-face-'));
const TEST_EXT = path.join(TMP, 'dist-chrome');
const PROFILE = path.join(TMP, 'profile');

function prepareExtension() {
  execFileSync(process.execPath, ['build-chrome.js'], { cwd: ROOT, stdio: 'inherit' });
  fs.cpSync(path.join(ROOT, 'dist-chrome'), TEST_EXT, { recursive: true });
  const mfPath = path.join(TEST_EXT, 'manifest.json');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  mf.host_permissions = Array.from(new Set([...(mf.host_permissions || []), '<all_urls>']));
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));
}

function connect(chrome) {
  let seq = 0;
  let buf = Buffer.alloc(0);
  const pending = new Map();
  const listeners = new Map();
  const attached = new Map();
  const attachedInfo = new Map();
  const consoleLines = [];
  const requests = [];

  function on(method, fn) {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  }
  function emit(method, params, sessionId) {
    for (const fn of listeners.get(method) || []) fn(params, sessionId);
  }

  chrome.stdio[4].on('data', d => {
    buf = Buffer.concat([buf, d]);
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
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      } else if (msg.method) {
        emit(msg.method, msg.params, msg.sessionId);
      }
    }
  });

  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      const m = { id, method, params };
      if (sessionId) m.sessionId = sessionId;
      chrome.stdio[3].write(JSON.stringify(m) + '\0');
    });
  }

  on('Runtime.consoleAPICalled', p => {
    const args = (p.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || ''));
    consoleLines.push('[console.' + p.type + '] ' + args.join(' '));
  });
  on('Runtime.exceptionThrown', p => {
    const d = p && p.exceptionDetails;
    const detail = (d && d.exception && (d.exception.description || d.exception.value)) ||
      (d && d.text) || '?';
    consoleLines.push('[exception] ' + detail);
  });
  on('Log.entryAdded', p => {
    if (p && p.entry) consoleLines.push('[log] ' + p.entry.text);
  });
  on('Network.requestWillBeSent', p => {
    const url = String((p && p.request && p.request.url) || '');
    if (!url || /^(data|blob|filesystem):/i.test(url)) return;
    requests.push(url);
  });
  on('Target.attachedToTarget', p => {
    attached.set(p.targetInfo.targetId, p.sessionId);
    attachedInfo.set(p.targetInfo.targetId, {
      type: p.targetInfo.type,
      url: p.targetInfo.url
    });
    send('Runtime.enable', {}, p.sessionId).catch(() => {});
    send('Log.enable', {}, p.sessionId).catch(() => {});
    send('Network.enable', {}, p.sessionId).catch(() => {});
    send('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true
    }, p.sessionId).catch(() => {});
  });

  return { send, attached, attachedInfo, consoleLines, requests };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function evaluate(cdp, session, expression, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Zeitüberschreitung: ' +
      expression.slice(0, 80) + '\nKonsole:\n' + cdp.consoleLines.join('\n').slice(0, 3000))), timeoutMs);
  });
  try {
    return await Promise.race([
      cdp.send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true
      }, session),
      timeout
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  prepareExtension();
  fs.mkdirSync(PROFILE, { recursive: true });
  const chrome = spawn(CHROME, [
    '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check', '--disable-default-apps',
    '--disable-gpu',
    '--enable-unsafe-extension-debugging', '--remote-debugging-pipe',
    '--window-size=1280,900', 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  let closing = false;
  chrome.on('exit', code => {
    if (!closing && code) process.stderr.write('CHROME beendet: ' + code + '\n');
  });
  const cdp = connect(chrome);
  try {
    await sleep(1500);
    await cdp.send('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true
    });
    const loaded = await cdp.send('Extensions.loadUnpacked', { path: TEST_EXT });
    if (!loaded || !loaded.id) throw new Error('Erweiterung wurde nicht geladen');

    let swSession = null;
    for (let i = 0; i < 100 && !swSession; i++) {
      await sleep(100);
      for (const [targetId, sessionId] of cdp.attached) {
        const info = cdp.attachedInfo.get(targetId);
        if (info && info.type === 'service_worker' &&
            String(info.url || '').includes('/background.js')) swSession = sessionId;
      }
    }
    if (!swSession) throw new Error('Service-Worker-Session nicht gefunden');

    let hostReady = false;
    for (let i = 0; i < 100 && !hostReady; i++) {
      const probe = await cdp.send('Runtime.evaluate', {
        expression: 'typeof callHost', returnByValue: true
      }, swSession).catch(() => null);
      hostReady = probe && probe.result && probe.result.value === 'function';
      if (!hostReady) await sleep(100);
    }
    if (!hostReady) throw new Error('callHost im Service Worker nicht gefunden');

    /* prepare startet das Offscreen-Dokument, lädt Bundle/Wasm/Modell und
       initialisiert FaceLandmarker. Das ist der teuerste Schritt. */
    const prep = await evaluate(cdp, swSession,
      "callHost('face', { op: 'prepare' }).then(r => JSON.stringify(r))" +
      ".catch(e => JSON.stringify({ ok: false, error: String(e) }))", 120000);
    const prepResult = prep.result && JSON.parse(prep.result.value);
    if (!prepResult || prepResult.ok !== true) {
      throw new Error('Face-Vorbereitung fehlgeschlagen: ' + JSON.stringify(prepResult) +
        '\nKonsole:\n' + cdp.consoleLines.join('\n').slice(0, 4000));
    }
    if (!prepResult.status || prepResult.status.state !== 'ready') {
      throw new Error('Face-Status nach prepare nicht ready: ' + JSON.stringify(prepResult.status));
    }
    if (prepResult.status.delegate !== 'CPU') {
      throw new Error('Face-Host nutzt nicht den CPU-Delegate: ' + prepResult.status.delegate);
    }

    /* Offscreen-Dokument einsammeln und die geladene Route prüfen. */
    let offSession = null;
    for (let i = 0; i < 100 && !offSession; i++) {
      await sleep(100);
      for (const [targetId, sessionId] of cdp.attached) {
        const info = cdp.attachedInfo.get(targetId);
        if (info && String(info.url || '').includes('/offscreen.html')) offSession = sessionId;
      }
    }
    if (!offSession) {
      /* Bei frisch erzeugten Offscreen-Dokumenten meldet CDP den Typ „other“
         oft ohne URL; wie im OCR-Test genügt dann das erste solche Ziel. */
      for (const [targetId, sessionId] of cdp.attached) {
        const info = cdp.attachedInfo.get(targetId);
        if (info && info.type === 'other') offSession = sessionId;
      }
    }
    if (!offSession) {
      const seen = Array.from(cdp.attachedInfo.values())
        .map(i => (i.type || '?') + ' ' + (i.url || '?'))
        .join('\n');
      throw new Error('Offscreen-Session nicht gefunden. Ziele:\n' + seen);
    }

    const status = await evaluate(cdp, offSession,
      "(async () => JSON.stringify(await self.YB_ROUTES.face({ op: 'status' })))()", 10000);
    const statusRes = status.result && JSON.parse(status.result.value);
    if (!statusRes || statusRes.ok !== true || statusRes.status.state !== 'ready') {
      throw new Error('Face-Statusroute fehlerhaft: ' + JSON.stringify(statusRes));
    }

    const reset = await evaluate(cdp, offSession,
      "(async () => JSON.stringify(await self.YB_ROUTES.face({ op: 'reset' })))()", 10000);
    const resetRes = reset.result && JSON.parse(reset.result.value);
    if (!resetRes || resetRes.ok !== true) throw new Error('Face-Reset fehlgeschlagen');
    const after = await evaluate(cdp, offSession,
      "(async () => JSON.stringify(await self.YB_ROUTES.face({ op: 'status' })))()", 10000);
    const afterRes = after.result && JSON.parse(after.result.value);
    if (!afterRes || afterRes.status.state !== 'off') {
      throw new Error('Face-Status nach reset nicht off: ' + JSON.stringify(afterRes));
    }

    await sleep(500);
    for (const asset of ['vision_bundle.js', 'face_landmarker.task', 'vision_wasm_internal']) {
      if (!cdp.requests.some(u => u.includes(asset))) {
        throw new Error('lokales Face-Asset wurde nicht geladen: ' + asset +
          '\nAnfragen: ' + cdp.requests.filter(u => u.includes('mediapipe')).join(', '));
      }
    }
    const external = cdp.requests.filter(u => /^https?:/i.test(u));
    if (external.length) {
      throw new Error('externe Face-Anfrage(n): ' +
        external.slice(0, 5).join(', '));
    }
    const forbidden = [
      /Refused to (load|execute)/i,
      /wasm-unsafe-eval/i,
      /Failed to fetch dynamically imported module/i,
      /Face-Host nicht geladen/i,
      /odml\.pa\.googleapis\.com/i,
      /violates the following Content Security Policy/i
    ];
    const joined = cdp.consoleLines.join('\n');
    const hits = forbidden.filter(re => re.test(joined));
    if (hits.length) {
      throw new Error('unerwartete Konsolenmeldungen: ' + hits.join(', ') +
        '\n' + joined.slice(0, 2000));
    }

    process.stdout.write('e2e-chrome-face: OK (init ' + prepResult.status.initMs + ' ms, CPU)\n');
  } finally {
    closing = true;
    try { chrome.kill('SIGKILL'); } catch { /* schon weg */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* egal */ }
  }
}

main().then(() => process.exit(0)).catch(e => {
  console.error('e2e-chrome-face:', (e && e.message) || e);
  process.exit(1);
});
