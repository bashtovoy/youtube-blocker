/* e2e-chrome-ocr.js — echter Chrome-Test der OCR-Kette über das Offscreen-
   Dokument der Erweiterung. Geprüft wird:
     - das Offscreen-Dokument setzt YB_FORCE_WASM (keine WebGPU-Anfrage),
     - der OCR-Host erkennt Text auf einem erzeugten PNG (Diacritics, Text an
       Ober- und Unterkante) — der weiße Rand darf die Erkennung nicht stören,
     - die Konsole von Offscreen-Dokument und ocr-worker.js bleibt frei von
       „Detected N diacritics“, den Leptonica-Boxmeldungen und
       „Failed to create WebGPU Context Provider“.

   Aufruf: node tests/e2e-chrome-ocr.js
   Chrome-Pfad überschreibbar mit CHROME_BIN. Fehlt Chrome, wird der Test
   übersprungen. Kein Netzverkehr; das Testbild entsteht im Offscreen-Dokument. */
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
  console.log('e2e-chrome-ocr: übersprungen (Chrome nicht gefunden: ' + CHROME + ')');
  process.exit(0);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yb-chrome-ocr-'));
const TEST_EXT = path.join(TMP, 'dist-chrome');
const PROFILE = path.join(TMP, 'profile');

function prepareExtension() {
  if (!fs.existsSync(path.join(ROOT, 'dist-chrome', 'manifest.json'))) {
    execFileSync(process.execPath, ['build-chrome.js'], { cwd: ROOT, stdio: 'inherit' });
  }
  fs.cpSync(path.join(ROOT, 'dist-chrome'), TEST_EXT, { recursive: true });
  const mfPath = path.join(TEST_EXT, 'manifest.json');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  /* Nur für den Test: feste Host-Berechtigung statt interaktivem Dialog. */
  mf.host_permissions = Array.from(new Set([...(mf.host_permissions || []), '<all_urls>']));
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));
}

/* Aufbau wie in e2e-chrome-fsa.js: CDP über die Pipe, Ereignisse werden
   mitgeschnitten (Target.attachedToTarget inklusive Kind-Workern). */
function connect(chrome) {
  let seq = 0;
  let buf = Buffer.alloc(0);
  const pending = new Map();
  const listeners = new Map();
  const attached = new Map();
  const attachedInfo = new Map();
  const consoleLines = [];

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
    const args = (p.args || []).map(a =>
      a.value !== undefined ? String(a.value) : (a.description || ''));
    consoleLines.push('[console.' + p.type + '] ' + args.join(' '));
  });
  on('Runtime.exceptionThrown', p => {
    consoleLines.push('[exception] ' + ((p.exceptionDetails && p.exceptionDetails.text) || '?'));
  });
  on('Log.entryAdded', p => {
    if (p && p.entry) consoleLines.push('[log] ' + p.entry.text);
  });
  on('Target.attachedToTarget', p => {
    attached.set(p.targetInfo.targetId, p.sessionId);
    attachedInfo.set(p.targetInfo.targetId, {
      type: p.targetInfo.type,
      url: p.targetInfo.url
    });
    send('Runtime.enable', {}, p.sessionId).catch(() => {});
    send('Log.enable', {}, p.sessionId).catch(() => {});
    /* Kind-Ziele (dedizierter OCR-Worker) ebenfalls anbinden. */
    send('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true
    }, p.sessionId).catch(() => {});
  });

  return { send, attached, attachedInfo, consoleLines };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

    /* Service-Worker abwarten und den OCR-Host über einen echten Aufruf starten. */
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

    const prep = await cdp.send('Runtime.evaluate', {
      expression: "callHost('ocr', { op: 'prepare', langs: 'eng' })" +
        ".then(r => JSON.stringify(r)).catch(e => JSON.stringify({ ok: false, error: String(e) }))",
      awaitPromise: true, returnByValue: true
    }, swSession);
    const prepResult = prep.result && JSON.parse(prep.result.value);
    if (!prepResult || prepResult.ok !== true) {
      throw new Error('OCR-Vorbereitung fehlgeschlagen: ' + JSON.stringify(prepResult));
    }

    /* Offscreen-Dokument einsammeln (CDP meldet es als Typ „other“). */
    let offSession = null;
    for (let i = 0; i < 100 && !offSession; i++) {
      await sleep(100);
      for (const [targetId, sessionId] of cdp.attached) {
        const info = cdp.attachedInfo.get(targetId);
        if (info && String(info.url || '').includes('/offscreen.html')) offSession = sessionId;
      }
    }
    if (!offSession) {
      for (const [targetId, sessionId] of cdp.attached) {
        const info = cdp.attachedInfo.get(targetId);
        if (info && info.type === 'other') offSession = sessionId;
      }
    }
    if (!offSession) throw new Error('Offscreen-Session nicht gefunden');

    /* Keine WebGPU-Anfrage in Chrome: das Merkmal muss gesetzt sein. */
    const force = await cdp.send('Runtime.evaluate', {
      expression: 'self.YB_FORCE_WASM === true', returnByValue: true
    }, offSession);
    if (!force.result || force.result.value !== true) {
      throw new Error('YB_FORCE_WASM ist im Offscreen-Dokument nicht gesetzt');
    }

    /* Echtes Erkennungsbild im Offscreen-Dokument erzeugen: Diacritics sowie
       Text direkt an Ober- und Unterkante — die frühere Fehlerquelle. */
    const expr = `(async () => {
      const c = document.createElement('canvas');
      c.width = 640; c.height = 360;
      const x = c.getContext('2d');
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height);
      x.fillStyle = '#000000'; x.font = '28px Arial, sans-serif';
      x.fillText('Ünïcödé Diacritics Тест 123', 2, 34);
      x.fillText('EDGE BOTTOM 456', 2, 352);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const blobUrl = URL.createObjectURL(blob);
      try {
        const res = await self.YB_ROUTES.ocr({ op: 'recognize', url: blobUrl, langs: 'eng' });
        return JSON.stringify(res);
      } finally { URL.revokeObjectURL(blobUrl); }
    })()`;
    const ev = await cdp.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true
    }, offSession);
    const result = ev.result && JSON.parse(ev.result.value);
    if (!result || result.ok !== true) {
      throw new Error('OCR fehlgeschlagen: ' + JSON.stringify(result));
    }
    if (!String(result.text || '').trim()) throw new Error('OCR-Text ist leer');
    if (!/Diacritics/i.test(result.text) || !/BOTTOM/i.test(result.text)) {
      throw new Error('OCR-Text unvollständig: ' + JSON.stringify(result.text));
    }

    await sleep(1000);
    const workerAttached = [...cdp.attachedInfo.values()]
      .some(i => i.type === 'worker' && String(i.url || '').includes('ocr-worker.js'));
    if (!workerAttached) throw new Error('OCR-Worker wurde nicht angebunden');

    const joined = cdp.consoleLines.join('\n');
    const forbidden = [
      /Detected \d+ diacritics/,
      /boxClipToRectangle/,
      /pixScanForForeground/,
      /Image too small to scale/,
      /Line cannot be recognized/,
      /Failed to create WebGPU Context Provider/
    ];
    const hits = forbidden.filter(re => re.test(joined));
    if (hits.length) {
      throw new Error('unerwartete Konsolenmeldungen: ' + hits.join(', ') +
        '\n' + joined.slice(0, 1000));
    }

    process.stdout.write('e2e-chrome-ocr: OK (' + result.ms + ' ms, ' +
      JSON.stringify(result.text.trim()).slice(0, 60) + ')\n');
  } finally {
    closing = true;
    try { chrome.kill('SIGKILL'); } catch { /* schon weg */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* egal */ }
  }
}

main().catch(e => {
  console.error('e2e-chrome-ocr:', (e && e.message) || e);
  process.exit(1);
});
