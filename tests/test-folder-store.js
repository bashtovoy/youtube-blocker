/* test-folder-store.js — Chrome-Screenshotordner ohne Browser:
   IndexedDB- und File-System-Access-Attrappen prüfen Warteschlange,
   Ordnerfreigabe, Nachschreiben und Kollisionsnamen. Kein Netz, kein Download. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'extension', 'folder-store.js');
const DATA = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==';

/* Minimale IndexedDB-Attrappe: ein Datensatz je Store, asynchrone Events wie
   im Browser. Für die getesteten Operationen reichen get/put/add/getAll/delete. */
function makeIndexedDB() {
  const state = new Map();
  function dbFor(name) {
    if (!state.has(name)) state.set(name, { version: 0, stores: new Map() });
    return state.get(name);
  }
  function makeRequest() {
    return { result: undefined, error: null, onsuccess: null, onerror: null };
  }
  function makeTransaction(db, storeName, mode) {
    const tx = {
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      _pending: 0,
      _done: false
    };
    function complete() {
      if (tx._done) return;
      tx._done = true;
      if (tx.oncomplete) tx.oncomplete();
    }
    tx.objectStore = () => ({
      get(key) {
        const req = makeRequest();
        tx._pending++;
        setTimeout(() => {
          req.result = db.stores.get(storeName).get(key);
          if (req.onsuccess) req.onsuccess();
          tx._pending--;
          setTimeout(complete, 0);
        }, 0);
        return req;
      },
      put(value, key) {
        const req = makeRequest();
        tx._pending++;
        setTimeout(() => {
          const k = key === undefined ? value.id : key;
          db.stores.get(storeName).set(k, value);
          req.result = k;
          if (req.onsuccess) req.onsuccess();
          tx._pending--;
          setTimeout(complete, 0);
        }, 0);
        return req;
      },
      add(value) {
        const req = makeRequest();
        tx._pending++;
        setTimeout(() => {
          const map = db.stores.get(storeName);
          let id = 1;
          while (map.has(id)) id++;
          const item = Object.assign({}, value, { id });
          map.set(id, item);
          req.result = id;
          if (req.onsuccess) req.onsuccess();
          tx._pending--;
          setTimeout(complete, 0);
        }, 0);
        return req;
      },
      getAll() {
        const req = makeRequest();
        tx._pending++;
        setTimeout(() => {
          req.result = Array.from(db.stores.get(storeName).values());
          if (req.onsuccess) req.onsuccess();
          tx._pending--;
          setTimeout(complete, 0);
        }, 0);
        return req;
      },
      delete(key) {
        const req = makeRequest();
        tx._pending++;
        setTimeout(() => {
          db.stores.get(storeName).delete(key);
          req.result = undefined;
          if (req.onsuccess) req.onsuccess();
          tx._pending--;
          setTimeout(complete, 0);
        }, 0);
        return req;
      }
    });
    return tx;
  }
  return {
    open(name, version) {
      const req = makeRequest();
      setTimeout(() => {
        const db = dbFor(name);
        db.name = name;
        db.objectStoreNames = {
          contains: n => db.stores.has(n)
        };
        db.createObjectStore = n => {
          if (!db.stores.has(n)) db.stores.set(n, new Map());
          return db.stores.get(n);
        };
        db.transaction = (storeName, mode) => makeTransaction(db, storeName, mode);
        req.result = db;
        if (version > db.version) {
          db.version = version;
          if (req.onupgradeneeded) req.onupgradeneeded();
        }
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    }
  };
}

function makeFileSystem() {
  const files = new Map();
  const dirs = new Set(['']);
  let permission = 'granted';

  function dirHandle(dir) {
    return {
      name: dir.split('/').filter(Boolean).pop() || 'Chrome Shots',
      queryPermission: async () => permission,
      requestPermission: async () => permission,
      async getDirectoryHandle(name, options) {
        const next = dir ? dir + '/' + name : name;
        if (!dirs.has(next)) {
          if (!options || !options.create) {
            const err = new Error('not found'); err.name = 'NotFoundError'; throw err;
          }
          dirs.add(next);
        }
        return dirHandle(next);
      },
      async getFileHandle(name, options) {
        const full = dir ? dir + '/' + name : name;
        if (!files.has(full)) {
          if (!options || !options.create) {
            const err = new Error('not found'); err.name = 'NotFoundError'; throw err;
          }
          files.set(full, null);
        }
        return {
          async createWritable() {
            let blob = null;
            return {
              async write(value) { blob = value; },
              async close() { files.set(full, blob); },
              async abort() { /* nichts geschrieben */ }
            };
          }
        };
      }
    };
  }

  const rootHandle = dirHandle('');
  return {
    rootHandle,
    files,
    setPermission(value) { permission = value; }
  };
}

(async () => {
  const idb = makeIndexedDB();
  const system = makeFileSystem();
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    indexedDB: idb,
    fetch,
    Blob,
    URL,
    chrome: { runtime: { getManifest: () => ({ manifest_version: 3 }) } },
    showDirectoryPicker: async () => system.rootHandle
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox);

  const folder = sandbox.YB && sandbox.YB.folder;
  assert.ok(folder, 'folder-store.js muss YB.folder exportieren');
  assert.equal(folder.storeSupported(), true);
  assert.equal(folder.pickerSupported(), true);

  let status = await folder.getStatus();
  assert.equal(status.name, '', 'ohne Ordnerwahl kein Handle');
  assert.equal(status.permission, 'none');
  assert.equal(status.pending, 0);

  let queued = await folder.saveOrQueue(DATA, '2026-10-21/120000-abcd.jpg', { videoId: 'x' });
  assert.equal(queued.ok, false);
  assert.equal(queued.pending, true);
  assert.equal(queued.reason, 'no-folder');
  assert.ok(queued.id != null, 'Warteeintrag braucht eine Kennung');
  assert.equal(await folder.pendingCount(), 1, 'Bild muss lokal warten');

  const chosen = await folder.chooseFolder();
  assert.equal(chosen.name, 'Chrome Shots');
  status = await folder.getStatus();
  assert.equal(status.name, 'Chrome Shots');
  assert.equal(status.permission, 'granted');

  const flushed = await folder.flushPending();
  assert.equal(flushed.saved, 1, 'wartendes Bild muss geschrieben werden');
  assert.equal(flushed.failed, 0);
  assert.equal(flushed.pending, 0);
  assert.deepStrictEqual(Array.from(flushed.savedIds), [queued.id], 'geschriebene Kennung wird gemeldet');
  assert.equal(system.files.get('2026-10-21/120000-abcd.jpg') !== null, true);

  const direct = await folder.saveOrQueue(DATA, '2026-10-21/120000-abcd.jpg', {});
  assert.equal(direct.ok, true);
  assert.equal(direct.file, '2026-10-21/120000-abcd_1.jpg', 'gleicher Name wird uniquifiziert');
  assert.equal(system.files.has('2026-10-21/120000-abcd_1.jpg'), true);

  system.setPermission('prompt');
  const denied = await folder.saveOrQueue(DATA, '2026-10-21/120001-abcd.jpg', {});
  assert.equal(denied.pending, true);
  assert.equal(denied.reason, 'permission', 'fehlende Freigabe wird nicht als Download umgangen');
  assert.equal((await folder.flushPending()).reason, 'permission');
  assert.equal(await folder.pendingCount(), 1);

  system.setPermission('granted');
  assert.equal(await folder.requestStoredPermission(), true);
  const again = await folder.flushPending();
  assert.equal(again.saved, 1);

  console.log('folder-store tests: OK');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
