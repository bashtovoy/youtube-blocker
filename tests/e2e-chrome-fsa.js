/* e2e-chrome-fsa.js — echter Chrome-Test des Screenshot-Ordners ohne nativen
   Ordnerdialog: Eine OPFS-Verzeichnis-Handle wird wie die Auswahl aus
   showDirectoryPicker in IndexedDB gelegt. Geprüft werden Warteschlange,
   Schreiben aus dem MV3-Service-Worker, Kollisionsnamen und eine echte
   captureVisibleTab-Aufnahme. Kein downloads.download, kein Netz außer
   einem lokalen Testserver.

   Aufruf: node tests/e2e-chrome-fsa.js
   Chrome-Pfad überschreibbar mit CHROME_BIN. Fehlt Chrome, wird der Test
   übersprungen. macOS und Linux werden unterstützt. */
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME_BIN ||
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome');

if (!fs.existsSync(CHROME)) {
  console.log('e2e-chrome-fsa: übersprungen (Chrome nicht gefunden: ' + CHROME + ')');
  process.exit(0);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yb-chrome-fsa-'));
const TEST_EXT = path.join(TMP, 'dist-chrome');
const PROFILE = path.join(TMP, 'profile');
const DATA = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==';

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

function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>YB FSA test</title><body style="background:#eef;font:32px sans-serif">Chrome screenshot E2E</body>');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function connect(chrome) {
  let seq = 0;
  let buf = Buffer.alloc(0);
  const pending = new Map();
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
      } else if (msg.method === 'Runtime.exceptionThrown') {
        console.error('PAGE EXCEPTION', msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        console.error('PAGE CONSOLE', msg.params.type, msg.params.args?.map(a => a.value || a.description).join(' '));
      }
    }
  });
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      chrome.stdio[3].write(JSON.stringify(msg) + '\0');
    });
  }
  return { send };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  prepareExtension();
  const { server, port } = await startServer();
  fs.mkdirSync(PROFILE, { recursive: true });
  const chrome = spawn(CHROME, [
    '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check', '--disable-default-apps',
    '--disable-gpu',
    '--enable-unsafe-extension-debugging', '--remote-debugging-pipe',
    '--window-size=1280,900', 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  let closing = false;
  let exitError = null;
  chrome.on('exit', code => {
    if (!closing && code) exitError = new Error('Chrome beendet: ' + code);
  });
  chrome.stderr.on('data', d => {
    const s = d.toString();
    if (/extension.*error|failed to load/i.test(s)) process.stderr.write('CHROME: ' + s);
  });
  const { send } = connect(chrome);
  try {
    await sleep(1200);
    const loaded = await send('Extensions.loadUnpacked', { path: TEST_EXT });
    const page = await send('Target.createTarget', { url: 'http://127.0.0.1:' + port + '/' });
    const popup = await send('Target.createTarget', {
      url: 'chrome-extension://' + loaded.id + '/popup/popup.html'
    });
    const attach = await send('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
    const sid = attach.sessionId;
    const pageAttach = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const pageSid = pageAttach.sessionId;
    const evaluate = async (expression, session = sid) => {
      const r = await send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true
      }, session);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const waitFor = async (expression, session = sid, timeout = 10000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        try { if (await evaluate(expression, session)) return; } catch { /* noch nicht bereit */ }
        await sleep(200);
      }
      throw new Error('Zeitüberschreitung: ' + expression);
    };
    await waitFor('document.readyState === "complete" && !!self.YB?.folder && !!self.YB?.i18n', sid, 25000);
    await waitFor('document.readyState === "complete" && document.body && document.body.textContent.includes("Chrome screenshot E2E")', pageSid);

    const basic = await evaluate(`(async () => ({
      picker: typeof showDirectoryPicker,
      folder: !!self.YB?.folder,
      scripts: Array.from(document.scripts).map(s => s.src),
      ybKeys: Object.keys(self.YB || {}),
      store: !!self.YB?.folder?.storeSupported?.(),
      manifest: chrome?.runtime?.getManifest?.().manifest_version,
      pickerSupported: !!self.YB?.folder?.pickerSupported?.(),
      allUrls: await chrome.permissions.contains({ origins: ['<all_urls>'] }),
      downloads: await chrome.permissions.contains({ permissions: ['downloads'] }).catch(() => true)
    }))()`);
    if (basic.picker !== 'function' || !basic.store || !basic.allUrls) {
      throw new Error('Ordner-API oder Testberechtigung fehlt: ' + JSON.stringify(basic));
    }
    if (basic.downloads) throw new Error('Test darf downloads nicht besitzen');

    const queued = await evaluate(`(async () => {
      const r = await self.YB.folder.saveOrQueue(${JSON.stringify(DATA)}, '2026-10-21/120000_e2e.jpg', { source: 'e2e' });
      return { r, pending: await self.YB.folder.pendingCount() };
    })()`);
    if (!queued.r.pending || queued.r.reason !== 'no-folder' || queued.pending !== 1) {
      throw new Error('Warteschlange ohne Ordner fehlgeschlagen: ' + JSON.stringify(queued));
    }

    const stored = await evaluate(`(async () => {
      const root = await navigator.storage.getDirectory();
      const sub = await root.getDirectoryHandle('E2E Shots', { create: true });
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('youtube-blocker-shots', 1);
        r.onupgradeneeded = () => {
          if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv');
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      await new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(sub, 'shotsDir');
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      return await self.YB.folder.getStatus();
    })()`);
    if (stored.name !== 'E2E Shots' || stored.permission !== 'granted' || stored.pending !== 1) {
      throw new Error('Handle-Status falsch: ' + JSON.stringify(stored));
    }

    await evaluate(`renderFolderStatus()`);
    const ui = await evaluate(`({
      hidden: document.getElementById('shotsFolder').hidden,
      text: document.getElementById('shotsFolderStatus').textContent
    })`);
    if (ui.hidden || !ui.text.includes('E2E Shots')) {
      throw new Error('Ordnerstatus im Popup fehlt: ' + JSON.stringify(ui));
    }

    const flush = await evaluate(`chrome.runtime.sendMessage({ type: 'ybshot-folder-flush' })`);
    if (!flush || !flush.ok || flush.saved !== 1) {
      throw new Error('Service-Worker-Nachschreiben fehlgeschlagen: ' + JSON.stringify(flush));
    }

    const file = await evaluate(`(async () => {
      const root = await navigator.storage.getDirectory();
      const base = await root.getDirectoryHandle('E2E Shots');
      const dir = await base.getDirectoryHandle('2026-10-21');
      const fh = await dir.getFileHandle('120000_e2e.jpg');
      const f = await fh.getFile();
      return { size: f.size, type: f.type };
    })()`);
    if (!file.size || file.type !== 'image/jpeg') throw new Error('Datei fehlt oder ist leer');

    /* Echte Aufnahme: Testseite nach vorn, Popup bleibt Hintergrund-Tab. */
    await send('Target.activateTarget', { targetId: page.targetId });
    await sleep(300);
    const tabId = await evaluate(`(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id)()`);
    if (tabId == null) throw new Error('aktiver Testtab fehlt');
    const shot = await evaluate(`chrome.runtime.sendMessage({ type: 'ybshot-test', tabId: ${Number(tabId)} })`);
    if (!shot || !shot.ok || shot.target !== 'folder' || shot.pending || shot.downloadId !== null) {
      throw new Error('Testaufnahme in den Ordner fehlgeschlagen: ' + JSON.stringify(shot));
    }
    const last = await evaluate(`(async () => (await chrome.storage.local.get('lastShot')).lastShot)()`);
    if (!last || last.status !== 'saved' || last.target !== 'folder') {
      throw new Error('lastShot nicht als Ordneraufnahme markiert: ' + JSON.stringify(last));
    }
    const saved = await evaluate(`(async () => {
      const root = await navigator.storage.getDirectory();
      const base = await root.getDirectoryHandle('E2E Shots');
      const files = [];
      const walk = async (dir, prefix) => {
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind === 'directory') await walk(handle, prefix + name + '/');
          else files.push({ path: prefix + name, size: (await handle.getFile()).size });
        }
      };
      await walk(base, '');
      return files;
    })()`);
    if (!Array.isArray(saved) || saved.length < 2 ||
        !saved.some(f => /_test_test\.jpg$/.test(f.path)) ||
        !saved.some(f => /_e2e\.jpg$/.test(f.path))) {
      throw new Error('Screenshotdateien im Ordner fehlen: ' + JSON.stringify(saved));
    }

    /* Ohne Ordner muss auch der echte Service Worker die Aufnahme lokal
       vormerken; der Content blendet danach trotzdem aus. */
    await evaluate(`(async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('youtube-blocker-shots', 1);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      await new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete('shotsDir');
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      return true;
    })()`);
    const pendingShot = await evaluate(`chrome.runtime.sendMessage({ type: 'ybshot-test', tabId: ${Number(tabId)} })`);
    if (!pendingShot || !pendingShot.ok || !pendingShot.pending || pendingShot.target !== 'folder' ||
        pendingShot.error !== 'no-folder' || pendingShot.downloadId !== null || !pendingShot.pendingId) {
      throw new Error('Aufnahme ohne Ordner nicht vorgemerkt: ' + JSON.stringify(pendingShot));
    }
    const pendingLast = await evaluate(`(async () => (await chrome.storage.local.get('lastShot')).lastShot)()`);
    if (!pendingLast || pendingLast.status !== 'pending' || !pendingLast.pending || pendingLast.pendingId == null) {
      throw new Error('lastShot ohne Ordner nicht pending: ' + JSON.stringify(pendingLast));
    }

    /* Popup schreibt selbst (neuer Weg): Ordner erneut setzen und die
       Warteschlange im Fensterkontext des Popups flushen — genau dort gilt die
       Ordnerfreigabe. Der Hintergrund pflegt danach nur den lastShot-Status
       (ybshot-folder-note). */
    await evaluate(`(async () => {
      const root = await navigator.storage.getDirectory();
      const sub = await root.getDirectoryHandle('E2E Shots', { create: true });
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('youtube-blocker-shots', 1);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      await new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(sub, 'shotsDir');
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      return true;
    })()`);
    const localFlush = await evaluate(`flushShotFolder()`);
    if (!localFlush || !localFlush.saved || localFlush.failed || localFlush.pending !== 0) {
      throw new Error('Popup-Nachschreiben fehlgeschlagen: ' + JSON.stringify(localFlush));
    }
    await waitFor(`(async () => ((await chrome.storage.local.get('lastShot')).lastShot || {}).status === 'saved')()`);
    const localLast = await evaluate(`(async () => (await chrome.storage.local.get('lastShot')).lastShot)()`);
    if (!localLast || localLast.status !== 'saved' || localLast.pending) {
      throw new Error('lastShot nach Popup-Nachschreiben nicht gespeichert: ' + JSON.stringify(localLast));
    }
    const localFile = await evaluate(`(async () => {
      const root = await navigator.storage.getDirectory();
      const base = await root.getDirectoryHandle('E2E Shots');
      const wanted = ${JSON.stringify(pendingShot.file)};
      const dot = wanted.lastIndexOf('.');
      const candidates = dot > 0 ? [wanted, wanted.slice(0, dot) + '_1' + wanted.slice(dot)] : [wanted];
      const files = [];
      const walk = async (dir, prefix) => {
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind === 'directory') await walk(handle, prefix + name + '/');
          else files.push({ path: prefix + name, size: (await handle.getFile()).size });
        }
      };
      await walk(base, '');
      return files.find(f => candidates.indexOf(f.path) >= 0 && f.size > 0) || null;
    })()`);
    if (!localFile) {
      throw new Error('Vom Popup geschriebene Datei fehlt: ' + JSON.stringify({ wanted: pendingShot.file, localFile }));
    }

    /* Einrichtung: Der Popup-Knopf öffnet die neue Seite, statt den im Popup
       unsichtbaren Chrome-Dialog anzustoßen. */
    const openedPage = await evaluate(`(() => {
      window.__ybOpened = null;
      chrome.tabs.create = opts => { window.__ybOpened = opts; return Promise.resolve({ id: 1 }); };
      document.getElementById('shotsFolderChoose').click();
      return window.__ybOpened;
    })()`);
    if (!openedPage || !/\/folder-access\.html$/.test(openedPage.url)) {
      throw new Error('Popup öffnet die Einrichtungsseite nicht: ' + JSON.stringify(openedPage));
    }

    /* Einrichtungsseite mit OPFS-Handle: „granted“ gilt als dauerhaft, und
       wartende Bilder werden dort nachgeschrieben. Für den Warteeintrag wird
       der Handle kurz entfernt und danach wieder eingesetzt. */
    const pageQueued = await evaluate(`(async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('youtube-blocker-shots', 1);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      await new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete('shotsDir');
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      const r = await self.YB.folder.saveOrQueue(${JSON.stringify(DATA)}, '2026-10-21/121500_page.jpg', { source: 'e2e-page' });
      const pending = await self.YB.folder.pendingCount();
      const root = await navigator.storage.getDirectory();
      const sub = await root.getDirectoryHandle('E2E Shots', { create: true });
      await new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(sub, 'shotsDir');
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      return { r, pending };
    })()`);
    if (!pageQueued.r.pending || pageQueued.pending !== 1) {
      throw new Error('Warteschlange für die Einrichtungsseite fehlgeschlagen: ' + JSON.stringify(pageQueued));
    }
    const access = await send('Target.createTarget', {
      url: 'chrome-extension://' + loaded.id + '/folder-access.html'
    });
    const accessAttach = await send('Target.attachToTarget', { targetId: access.targetId, flatten: true });
    const accessSid = accessAttach.sessionId;
    await waitFor('document.readyState === "complete" && document.body.dataset.state === "ready"', accessSid, 15000);
    await waitFor('document.getElementById("faMsg").textContent.length > 0', accessSid, 10000);
    const accessUi = await evaluate(`({
      status: document.getElementById('faStatus').textContent,
      msg: document.getElementById('faMsg').textContent,
      ok: document.getElementById('faMsg').classList.contains('ok'),
      grantHidden: document.getElementById('faGrant').hidden,
      closeHidden: document.getElementById('faClose').hidden
    })`, accessSid);
    if (!accessUi.status.includes('E2E Shots') || accessUi.grantHidden !== true ||
        accessUi.closeHidden !== false || accessUi.ok !== true) {
      throw new Error('Einrichtungsseite zeigt keinen dauerhaften Zugriff: ' + JSON.stringify(accessUi));
    }
    const pageFile = await evaluate(`(async () => {
      const root = await navigator.storage.getDirectory();
      const base = await root.getDirectoryHandle('E2E Shots');
      const dir = await base.getDirectoryHandle('2026-10-21');
      const fh = await dir.getFileHandle('121500_page.jpg');
      return { size: (await fh.getFile()).size };
    })()`, accessSid);
    if (!pageFile.size) throw new Error('Einrichtungsseite hat die Warteschlange nicht geschrieben');

    console.log('e2e-chrome-fsa: OK');
  } finally {
    closing = true;
    server.close();
    chrome.kill('SIGTERM');
    await sleep(300);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Profil noch gesperrt */ }
    if (exitError) throw exitError;
  }
}

main().then(() => process.exit(0)).catch(e => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
