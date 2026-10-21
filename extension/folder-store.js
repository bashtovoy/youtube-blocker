/* folder-store.js — Chrome: Kontrollbilder direkt in einen einmal gewählten
   Ordner schreiben (File System Access API). Firefox nutzt weiterhin den
   downloads-Weg. Der Verzeichnis-Handle und die auf Freigabe wartenden Bilder
   liegen lokal in IndexedDB; es wird nichts hochgeladen.

   Chrome zeigt bei aktivierter Einstellung „Fragen, wo jede Datei gespeichert
   werden soll“ auch bei downloads.download({saveAs:false}) einen nativen
   Dialog. Dieser Pfad umgeht das bewusst und schreibt nach der einmaligen
   Ordnerfreigabe ohne Systemdialog. */
(function () {
  'use strict';

  const root = (typeof self !== 'undefined') ? self : window;
  const DB_NAME = 'youtube-blocker-shots';
  const DB_VERSION = 1;
  const STORE_KV = 'kv';
  const STORE_PENDING = 'pending';
  const DIR_KEY = 'shotsDir';
  const MAX_PENDING = 100;

  let dbPromise = null;

  function chromeMode() {
    try {
      return !!(root.chrome && root.chrome.runtime && root.chrome.runtime.getManifest &&
        root.chrome.runtime.getManifest().manifest_version === 3);
    } catch (e) {
      return false;
    }
  }

  function storeSupported() {
    return chromeMode() && typeof indexedDB !== 'undefined';
  }

  function pickerSupported() {
    return chromeMode() && typeof root.showDirectoryPicker === 'function';
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
        if (!db.objectStoreNames.contains(STORE_PENDING)) {
          db.createObjectStore(STORE_PENDING, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB nicht verfügbar'));
      req.onblocked = () => reject(new Error('IndexedDB blockiert'));
    });
    return dbPromise;
  }

  function reqValue(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB-Anfrage fehlgeschlagen'));
    });
  }

  async function withStore(name, mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode);
      let value;
      try { value = fn(tx.objectStore(name)); } catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB-Transaktion fehlgeschlagen'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB-Transaktion abgebrochen'));
    });
  }

  async function getDirHandle() {
    if (!storeSupported()) return null;
    try {
      return await withStore(STORE_KV, 'readonly', store => reqValue(store.get(DIR_KEY)));
    } catch (e) {
      return null;
    }
  }

  async function putDirHandle(handle) {
    await withStore(STORE_KV, 'readwrite', store => reqValue(store.put(handle, DIR_KEY)));
  }

  async function pendingAll() {
    if (!storeSupported()) return [];
    try {
      const list = await withStore(STORE_PENDING, 'readonly', store => reqValue(store.getAll()));
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  async function pendingCount() {
    return (await pendingAll()).length;
  }

  async function deletePending(id) {
    await withStore(STORE_PENDING, 'readwrite', store => reqValue(store.delete(id)));
  }

  async function enqueue(dataUrl, file, meta) {
    const blob = await (await root.fetch(dataUrl)).blob();
    const list = await pendingAll();
    if (list.length >= MAX_PENDING) {
      const remove = list.sort((a, b) => (a.at || 0) - (b.at || 0))
        .slice(0, list.length - MAX_PENDING + 1);
      for (const old of remove) {
        try { await deletePending(old.id); } catch (e) { /* Queue bleibt nutzbar */ }
      }
    }
    const entry = Object.assign({
      file,
      blob,
      at: Date.now()
    }, meta || {});
    return withStore(STORE_PENDING, 'readwrite', store => reqValue(store.add(entry)));
  }

  async function queryPermission(handle) {
    if (!handle) return 'none';
    /* OPFS-Handles (nur für Tests) kennen keine Permission-Abfrage, sind aber
       im eigenen Origin immer les- und schreibbar. Echte Picker-Handles haben
       queryPermission und werden normal geprüft. */
    if (typeof handle.queryPermission !== 'function') return 'granted';
    try { return await handle.queryPermission({ mode: 'readwrite' }); } catch (e) { return 'denied'; }
  }

  async function requestPermission(handle) {
    if (!handle) return 'none';
    if (typeof handle.requestPermission !== 'function') return 'granted';
    try { return await handle.requestPermission({ mode: 'readwrite' }); } catch (e) { return 'denied'; }
  }

  function pathParts(file) {
    const parts = String(file || '').split('/').filter(p => p && p !== '.');
    if (!parts.length || parts.some(p => p === '..' || p.indexOf('\\') >= 0 || p.indexOf('\0') >= 0)) {
      throw new Error('ungültiger Speicherpfad');
    }
    return parts;
  }

  async function fileExists(dir, name) {
    try {
      await dir.getFileHandle(name);
      return true;
    } catch (e) {
      if (e && e.name === 'NotFoundError') return false;
      throw e;
    }
  }

  async function uniqueFileHandle(dir, name) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let i = 1; i < 1000; i++) {
      if (!(await fileExists(dir, candidate))) {
        return { handle: await dir.getFileHandle(candidate, { create: true }), name: candidate };
      }
      candidate = base + '_' + i + ext;
    }
    throw new Error('kein freier Dateiname');
  }

  async function writeBlob(handle, file, blob) {
    const parts = pathParts(file);
    let dir = handle;
    for (const part of parts.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(part, { create: true });
    }
    const picked = await uniqueFileHandle(dir, parts[parts.length - 1]);
    const writable = await picked.handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (e) {
      try { await writable.abort(); } catch (ignore) { /* bereits geschlossen */ }
      throw e;
    }
    return parts.slice(0, -1).concat(picked.name).join('/');
  }

  async function writeDataUrl(handle, file, dataUrl) {
    const blob = await (await root.fetch(dataUrl)).blob();
    return writeBlob(handle, file, blob);
  }

  /* Speichert direkt oder legt das Bild ohne Systemdialog in die lokale
     Warteschlange. Der Rückgabewert ist absichtlich serialisierbar. */
  async function saveOrQueue(dataUrl, file, meta) {
    const handle = await getDirHandle();
    let reason = 'no-folder';
    if (handle) {
      const state = await queryPermission(handle);
      if (state === 'granted') {
        try {
          return { ok: true, file: await writeDataUrl(handle, file, dataUrl) };
        } catch (e) {
          reason = 'write';
        }
      } else {
        reason = 'permission';
      }
    }
    try {
      const id = await enqueue(dataUrl, file, meta);
      return { ok: false, pending: true, reason, id };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /* Einmalige Ordnerwahl im Popup. showDirectoryPicker braucht eine
     Nutzergeste; im Service Worker ist die Funktion deshalb nicht verfügbar. */
  async function chooseFolder() {
    if (!pickerSupported()) throw new Error('Ordnerwahl nicht verfügbar');
    const handle = await root.showDirectoryPicker({ id: 'yb-shots', mode: 'readwrite' });
    let state = await queryPermission(handle);
    if (state !== 'granted') state = await requestPermission(handle);
    if (state !== 'granted') {
      const err = new Error('Ordnerzugriff nicht erlaubt');
      err.name = 'NotAllowedError';
      throw err;
    }
    await putDirHandle(handle);
    return handle;
  }

  async function requestStoredPermission() {
    const handle = await getDirHandle();
    if (!handle) return false;
    let state = await queryPermission(handle);
    if (state !== 'granted') state = await requestPermission(handle);
    return state === 'granted';
  }

  async function getStatus() {
    if (!storeSupported()) {
      return { supported: false, picker: false, name: '', permission: 'none', pending: 0 };
    }
    const handle = await getDirHandle();
    return {
      supported: true,
      picker: pickerSupported(),
      name: handle ? handle.name : '',
      permission: handle ? await queryPermission(handle) : 'none',
      pending: await pendingCount()
    };
  }

  async function flushPending() {
    if (!storeSupported()) return { ok: false, reason: 'unsupported', saved: 0, failed: 0, pending: 0 };
    const handle = await getDirHandle();
    if (!handle) {
      return { ok: false, reason: 'no-folder', saved: 0, failed: 0, pending: await pendingCount() };
    }
    if ((await queryPermission(handle)) !== 'granted') {
      return { ok: false, reason: 'permission', saved: 0, failed: 0, pending: await pendingCount() };
    }
    const list = (await pendingAll()).sort((a, b) => (a.at || 0) - (b.at || 0));
    let saved = 0;
    let failed = 0;
    let lastSaved = '';
    const savedIds = [];
    for (const entry of list) {
      try {
        lastSaved = await writeBlob(handle, entry.file, entry.blob);
        await deletePending(entry.id);
        savedIds.push(entry.id);
        saved++;
      } catch (e) {
        failed++;
      }
    }
    return {
      ok: failed === 0,
      reason: failed ? 'write' : '',
      saved,
      failed,
      lastSaved,
      savedIds,
      pending: await pendingCount()
    };
  }

  root.YB = root.YB || {};
  root.YB.folder = {
    chromeMode,
    storeSupported,
    pickerSupported,
    getStatus,
    chooseFolder,
    requestStoredPermission,
    saveOrQueue,
    flushPending,
    pendingCount
  };
})();
