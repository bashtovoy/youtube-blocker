/* test-i18n.js — Oberflächensprachen des Popups (extension/popup/i18n.js).
   Prüft: vier Wörterbücher (de/en/ru/uk) mit identischem Schlüsselsatz und
   gleichen {Platzhaltern}, Abdeckung aller data-i18n-Markierungen im HTML und
   aller t('…')-Aufrufe im JS. Kein Browser, kein Netz. */
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const POPUP = path.join(__dirname, '..', 'extension', 'popup');

/* i18n.js lädt im Browser (globalThis.YB); im VM-Sandbox genügt ein Dokument-Stub. */
const sandbox = {
  console,
  document: { documentElement: {}, querySelectorAll: () => [] }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(POPUP, 'i18n.js'), 'utf8'), sandbox);
const i18n = sandbox.YB && sandbox.YB.i18n;
assert.ok(i18n, 'i18n.js muss YB.i18n exportieren');
/* Array.from: Werte aus dem VM-Kontext in den Host-Realm holen (deepStrictEqual vergleicht Prototypen) */
assert.deepStrictEqual(Array.from(i18n.LANGS), ['de', 'en', 'ru', 'uk'], 'unterstützte Sprachen: de/en/ru/uk');

const langs = Array.from(i18n.LANGS);
const dicts = i18n.DICTS;
const deKeys = Object.keys(dicts.de).sort();
assert.ok(deKeys.length > 30, 'Wörterbuch de wirkt zu klein: ' + deKeys.length);

const placeholders = s => Array.from(String(s).match(/\{[a-zA-Z0-9_]+\}/g) || []).sort();

/* 1) Schlüsselparität, nicht-leere Werte, gleiche Platzhalter je Schlüssel */
for (const lang of langs) {
  const keys = Object.keys(dicts[lang]).sort();
  assert.deepStrictEqual(keys, deKeys, lang + ': Schlüsselsatz weicht von de ab');
  for (const k of keys) {
    assert.strictEqual(typeof dicts[lang][k], 'string', lang + '.' + k + ': Wert muss String sein');
    assert.ok(dicts[lang][k].length > 0, lang + '.' + k + ': Wert darf nicht leer sein');
    assert.deepStrictEqual(placeholders(dicts[lang][k]), placeholders(dicts.de[k]),
      lang + '.' + k + ': Platzhalter weichen von de ab');
  }
}

/* 2) Alle data-i18n-Markierungen im HTML sind abgedeckt */
const used = new Set();
let found = 0;
for (const f of ['popup.html', 'import.html', path.join('..', 'folder-access.html')]) {
  const html = fs.readFileSync(path.join(POPUP, f), 'utf8');
  const re = /data-i18n(?:-title|-placeholder)?="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    found++;
    const key = m[1];
    for (const lang of langs) assert.ok(key in dicts[lang], f + ': „' + key + '“ fehlt in ' + lang);
    used.add(key);
  }
}
assert.ok(found > 20, 'HTML-Markierungen gefunden: ' + found);

/* 3) Alle t('…')-Aufrufe im JS existieren im Wörterbuch;
   dynamisch verwendete Schlüssel (z. B. ROUTE_OPTIONS) als String-Literale mitzählen */
let calls = 0;
for (const f of ['popup.js', 'import.js', path.join('..', 'folder-access.js')]) {
  const src = fs.readFileSync(path.join(POPUP, f), 'utf8');
  const reCall = /\bt\(\s*['"]([a-z0-9_]+)['"]/g;
  let m;
  while ((m = reCall.exec(src)) !== null) {
    calls++;
    const key = m[1];
    assert.ok(key in dicts.de, f + ": t('" + key + "') ohne Wörterbuch-Eintrag");
    used.add(key);
  }
  const reLit = /['"]([a-z0-9_]+)['"]/g;
  while ((m = reLit.exec(src)) !== null) {
    if (m[1] in dicts.de) used.add(m[1]);
  }
}
assert.ok(calls > 10, 't()-Aufrufe gefunden: ' + calls);

/* 4) Sprachauflösung: 'ru-RU' → 'ru', Unbekanntes → '', Browsersprache mit Fallback de */
assert.strictEqual(i18n.normalize('ru-RU'), 'ru');
assert.strictEqual(i18n.normalize('uk'), 'uk');
assert.strictEqual(i18n.normalize('en_US'), 'en');   /* Unterstrich-Variante ebenfalls toleriert */
assert.strictEqual(i18n.normalize('nope'), '');
assert.strictEqual(i18n.detect({}), 'de');
assert.strictEqual(i18n.detect({ i18n: { getUILanguage: () => 'uk-UA' } }), 'uk');
assert.strictEqual(i18n.detect({ i18n: { getUILanguage: () => 'fr' } }), 'de');
i18n.set('ru');
assert.strictEqual(i18n.current, 'ru');
assert.strictEqual(i18n.t('enabled'), dicts.ru.enabled, 't() muss die gesetzte Sprache verwenden');
assert.strictEqual(i18n.t('kw_count', { n: 5, on: 3 }), dicts.ru.kw_count.replace('{n}', '5').replace('{on}', '3'));
i18n.set('de');

/* 5) Ungenutzte Schlüssel nur als Hinweis (kein Fehler) */
const unused = deKeys.filter(k => !used.has(k));
if (unused.length) console.log('i18n: ungenutzt (Hinweis):', unused.join(', '));

console.log('i18n tests: OK (' + deKeys.length + ' Schlüssel × ' + langs.length + ' Sprachen)');
