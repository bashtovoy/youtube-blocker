/* test-ocr-client.js — Content-Client der Vorschaubild-OCR (extension/ocr.js).
   Prüft ohne Browser: Nachrichtenformat zum Hintergrund-Host, Serialisierung
   der Aufrufe, Text-/Fehler-/Timeoutpfade und die Fatal-Markierung, an der
   content.js das dauerhafte Abschalten des Kanals erkennt. */
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const path = require('path');

/* Fake-Timer: der Timeout-Fall löst die 60-s-Wartemarke von Hand aus,
   statt den Test wirklich warten zu lassen. */
const timers = new Map();
let timerSeq = 1;
function fakeSetTimeout(fn, ms) { const id = timerSeq++; timers.set(id, { fn, ms }); return id; }
function fakeClearTimeout(id) { timers.delete(id); }
function fireLastTimer() {
  const ids = [...timers.keys()];
  assert.strictEqual(ids.length, 1, 'genau ein laufender Timer erwartet');
  const id = ids[0];
  const t = timers.get(id);
  timers.delete(id);
  t.fn();
  return t.ms;
}

const sent = [];
let reply = null;   /* (msg) => Promise<Antwort des Hosts> */
const sandbox = {
  window: {},
  browser: {
    runtime: {
      sendMessage: msg => { sent.push(msg); return reply ? reply(msg) : Promise.resolve(null); }
    }
  },
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout
};
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '../extension/ocr.js'), 'utf8'),
  sandbox
);
const ocr = sandbox.window.YB.ocr;
assert.strictEqual(typeof ocr.recognizeUrl, 'function', 'recognizeUrl muss exportiert sein');

const tick = () => new Promise(r => setImmediate(r));

(async () => {
  /* 1) Erfolg: Nachrichtenformat und Textdurchreichung */
  reply = () => Promise.resolve({ ok: true, text: 'DeepSeek V4' });
  const p1 = ocr.recognizeUrl('https://i.ytimg.com/vi/x/hq.jpg', 'eng+rus');
  await tick();
  assert.strictEqual(sent.length, 1, 'erste Nachricht geht raus');
  assert.strictEqual(sent[0].type, 'ybocr');
  assert.strictEqual(sent[0].op, 'recognize');
  assert.strictEqual(sent[0].url, 'https://i.ytimg.com/vi/x/hq.jpg');
  assert.strictEqual(sent[0].langs, 'eng+rus');
  assert.strictEqual(await p1, 'DeepSeek V4');
  assert.strictEqual(timers.size, 0, 'Erfolgspfad räumt den Timeout ab');

  /* 2) Leerer Text → leerer String (content.js trimmt selbst) */
  reply = () => Promise.resolve({ ok: true });
  assert.strictEqual(await ocr.recognizeUrl('u2', 'eng'), '');

  /* 3) Serialisierung: die zweite Anfrage wartet auf die erste */
  let release;
  reply = () => new Promise(r => { release = r; });
  const pa = ocr.recognizeUrl('ua', 'eng');
  const pb = ocr.recognizeUrl('ub', 'eng');
  await tick();
  assert.strictEqual(sent.length, 3, 'zweite Anfrage noch nicht gesendet');
  release({ ok: true, text: 'A' });
  assert.strictEqual(await pa, 'A');
  await tick();
  assert.strictEqual(sent.length, 4, 'nach Abschluss der ersten geht die zweite raus');
  assert.strictEqual(sent[3].url, 'ub');
  release({ ok: true, text: 'B' });
  assert.strictEqual(await pb, 'B');

  /* 4) Fataler Kanal-Fehler → err.fatal (content.js schaltet dauerhaft ab) */
  reply = () => Promise.resolve({ ok: false, error: 'PaddleOCR-Bibliothek konnte nicht geladen werden', fatal: true });
  await assert.rejects(ocr.recognizeUrl('u3', 'eng'), e => {
    assert.strictEqual(e.message, 'PaddleOCR-Bibliothek konnte nicht geladen werden');
    assert.strictEqual(e.fatal, true);
    return true;
  });

  /* 5) Einzelner Bildfehler → kein fatal-Flag (nur überspringen) */
  reply = () => Promise.resolve({ ok: false, error: 'Bild konnte nicht geladen werden' });
  await assert.rejects(ocr.recognizeUrl('u4', 'eng'),
    e => e.message === 'Bild konnte nicht geladen werden' && e.fatal === undefined);

  /* 6) Fehlende Antwort → Standardfehler */
  reply = () => Promise.resolve(undefined);
  await assert.rejects(ocr.recognizeUrl('u5', 'eng'), e => e.message === 'OCR-Host nicht erreichbar');

  /* 7) Timeout: 60-s-Wartemarke wird ausgelöst */
  reply = () => new Promise(() => {});
  const pt = ocr.recognizeUrl('u6', 'eng');
  await tick();
  assert.strictEqual(sent[sent.length - 1].url, 'u6', 'Anfrage ist raus');
  assert.strictEqual(fireLastTimer(), 60000, 'Timeout beträgt 60 s');
  await assert.rejects(pt, e => e.message === 'OCR-Host: Zeitüberschreitung');

  /* 8) Die Kette überlebt Fehler: der nächste Aufruf funktioniert */
  reply = () => Promise.resolve({ ok: true, text: 'OK' });
  assert.strictEqual(await ocr.recognizeUrl('u7', 'eng'), 'OK');

  /* 9) Titel/Kanal gehen als Hinweis mit — der Host wählt danach die Schrift. */
  reply = () => Promise.resolve({ ok: true, text: 'HINT' });
  assert.strictEqual(await ocr.recognizeUrl('u8', 'eng+rus', 'Cloud Codes'), 'HINT');
  assert.strictEqual(sent[sent.length - 1].hint, 'Cloud Codes');
  assert.strictEqual(sent[sent.length - 1].langs, 'eng+rus');

  console.log('ocr client tests: OK');
})().catch(e => { console.error(e); process.exit(1); });
