/* e2e-chrome-ocr.js — echter Chrome-Test der OCR-Kette über das Offscreen-
   Dokument der Erweiterung. Geprüft wird:
     - das Offscreen-Dokument setzt YB_FORCE_WASM (keine WebGPU-Anfrage),
     - der OCR-Host erkennt Text auf einem erzeugten PNG (Diacritics, Text an
       Ober- und Unterkante),
     - PaddleOCR, Modell-Tars und ONNX-Runtime werden ausschließlich aus dem
       Erweiterungspaket geladen (keine externen Anfragen),
     - die Konsole bleibt frei von der WebGPU-Warnung.

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
  /* Immer neu bauen: Sonst würde der Test eine alte dist-chrome/ mit altem
     OCR-Host oder ohne Paddle-Assets prüfen. */
  execFileSync(process.execPath, ['build-chrome.js'], { cwd: ROOT, stdio: 'inherit' });
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
    const args = (p.args || []).map(a =>
      a.value !== undefined ? String(a.value) : (a.description || ''));
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
  on('Network.requestWillBeSent', (p, sessionId) => {
    const url = String((p && p.request && p.request.url) || '');
    if (!url || /^(data|blob|filesystem):/i.test(url)) return;
    requests.push({ url, session: sessionId || '' });
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
    /* Kind-Ziele ebenfalls anbinden. */
    send('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true
    }, p.sessionId).catch(() => {});
  });

  return { send, attached, attachedInfo, consoleLines, requests };
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

    let prepTimer;
    const prepTimeout = new Promise((_, reject) => {
      prepTimer = setTimeout(() => {
        reject(new Error('OCR-Vorbereitung: Zeitüberschreitung\nKonsole:\n' +
          cdp.consoleLines.join('\n').slice(0, 3000)));
      }, 120000);
    });
    let prep;
    try {
      prep = await Promise.race([
        cdp.send('Runtime.evaluate', {
          expression: "callHost('ocr', { op: 'prepare', langs: 'eng+rus' })" +
            ".then(r => JSON.stringify(r)).catch(e => JSON.stringify({ ok: false, error: String(e) }))",
          awaitPromise: true, returnByValue: true
        }, swSession),
        prepTimeout
      ]);
    } finally {
      clearTimeout(prepTimer);
    }
    const prepResult = prep.result && JSON.parse(prep.result.value);
    if (!prepResult || prepResult.ok !== true) {
      throw new Error('OCR-Vorbereitung fehlgeschlagen: ' + JSON.stringify(prepResult) +
        '\nKonsole:\n' + cdp.consoleLines.join('\n').slice(0, 3000));
    }
    const prepLangs = (prepResult.status && prepResult.status.langs) || [];
    if (!prepLangs.includes('eng') || !prepLangs.includes('rus')) {
      throw new Error('prepare(eng+rus) meldet nicht beide Modelle: ' + JSON.stringify(prepLangs));
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

    /* Echte 480×270-Fixtures, falls der lokale Benchmark-Ordner vorhanden ist
       (gitignored). Beide Sprachpfade werden über denselben Host geprüft:
       lateinischer Hinweis → en, kyrillischer Hinweis → eslav. */
    const fixtureDir = path.join(ROOT, 'experiments', 'paddleocr', 'fixtures-480');
    const fixtures = [
      {
        id: 'OhVjcySNqqc',
        hint: 'THE DYING SR22 KILLER aviation',
        re: /THE DYING SR22 KILLER/i,
        label: 'en'
      },
      {
        id: 'Jrhf0JPKkUo',
        hint: 'МАГИЧЕСКАЯ СИЛА СЛОВА',
        re: /МАГИЧЕСКАЯ[\s\S]*СИЛА/i,
        label: 'ru'
      }
    ];
    let fixtureCount = 0;
    for (const f of fixtures) {
      const fixturePath = path.join(fixtureDir, f.id + '.jpg');
      if (!fs.existsSync(fixturePath)) continue;
      const b64 = fs.readFileSync(fixturePath).toString('base64');
      const fixtureExpr = `(async () => {
        const bin = atob(${JSON.stringify(b64)});
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        const blobUrl = URL.createObjectURL(blob);
        try {
          const res = await self.YB_ROUTES.ocr({
            op: 'recognize', url: blobUrl, langs: 'eng+rus',
            hint: ${JSON.stringify(f.hint)}
          });
          return JSON.stringify(res);
        } finally { URL.revokeObjectURL(blobUrl); }
      })()`;
      const fev = await cdp.send('Runtime.evaluate', {
        expression: fixtureExpr, awaitPromise: true, returnByValue: true
      }, offSession);
      const fres = fev.result && JSON.parse(fev.result.value);
      if (!fres || fres.ok !== true) {
        throw new Error('Fixture ' + f.id + ' fehlgeschlagen: ' + JSON.stringify(fres));
      }
      if (!f.re.test(fres.text || '')) {
        throw new Error('Fixture ' + f.id + ' (' + f.label + ') falscher Text: ' +
          JSON.stringify(fres.text));
      }
      fixtureCount++;
    }

    await sleep(1000);
    const urls = cdp.requests.map(r => r.url);
    for (const asset of [
      'paddle.bundle.js',
      'ppocrv5_mobile_det.tar',
      'en_ppocrv5_mobile_rec.tar',
      'eslav_ppocrv5_mobile_rec.tar',
      'ort-wasm-simd-threaded.jsep'
    ]) {
      if (!urls.some(u => u.includes(asset))) {
        throw new Error('lokales OCR-Asset wurde nicht geladen: ' + asset);
      }
    }
    const external = cdp.requests.filter(r => /^https?:/i.test(r.url));
    if (external.length) {
      throw new Error('externe OCR-Anfrage(n): ' +
        external.slice(0, 5).map(r => r.url).join(', '));
    }

    const joined = cdp.consoleLines.join('\n');
    const forbidden = [
      /Failed to create WebGPU Context Provider/
    ];
    const hits = forbidden.filter(re => re.test(joined));
    if (hits.length) {
      throw new Error('unerwartete Konsolenmeldungen: ' + hits.join(', ') +
        '\n' + joined.slice(0, 1000));
    }

    process.stdout.write('e2e-chrome-ocr: OK (' + result.ms + ' ms, ' +
      JSON.stringify(result.text.trim()).slice(0, 60) +
      (fixtureCount ? ', ' + fixtureCount + ' reale Fixtures' : '') + ')\n');
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
