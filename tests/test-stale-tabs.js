/* test-stale-tabs.js — Erkennung veralteter/verwaister Content-Script-Instanzen
   in offenen YouTube-Tabs (extension/popup/stale-tabs.js). Reine Logik, ohne Browser. */
'use strict';
const assert = require('assert');
const path = require('path');
const { staleTabIds, pingTabs } = require(path.join(__dirname, '..', 'extension', 'popup', 'stale-tabs.js'));

/* Antwortet der Tab mit der aktuellen Version, ist er gesund. */
assert.deepStrictEqual(staleTabIds([{ id: 1, ok: true, version: '1.5.6' }], '1.5.6'), []);
/* Kein Lebenszeichen (verwaiste Instanz) → veraltet. */
assert.deepStrictEqual(staleTabIds([{ id: 2, ok: false, version: '' }], '1.5.6'), [2]);
/* Alte Version meldet sich noch (z. B. 1.5.5) → veraltet. */
assert.deepStrictEqual(staleTabIds([{ id: 3, ok: true, version: '1.5.5' }], '1.5.6'), [3]);
/* Leere Version gilt nicht als aktuell. */
assert.deepStrictEqual(staleTabIds([{ id: 4, ok: true, version: '' }], '1.5.6'), [4]);
/* Mischfall: nur die veralteten Tabs kommen zurück, Reihenfolge bleibt erhalten. */
assert.deepStrictEqual(
  staleTabIds([
    { id: 5, ok: true, version: '1.5.6' },
    { id: 6, ok: false, version: '' },
    { id: 7, ok: true, version: '1.5.4' }
  ], '1.5.6'),
  [6, 7]);
/* Robust gegen leere/fehlende Eingaben. */
assert.deepStrictEqual(staleTabIds(null, '1.5.6'), []);
assert.deepStrictEqual(staleTabIds([null, undefined], '1.5.6'), []);

(async () => {
  /* pingTabs: schlafende (discarded) und noch ladende Tabs überspringen,
     fehlgeschlagene Nachrichten wie „verwaist“ werten. */
  const { stale } = await pingTabs(
    [{ id: 10 }, { id: 11, discarded: true }, { id: 12, status: 'loading' }, { id: 13 }],
    async id => {
      if (id === 13) throw new Error('kein Empfänger');
      return { ok: true, version: '1.5.6' };
    },
    '1.5.6');
  assert.deepStrictEqual(stale, [13]);

  /* pingTabs übernimmt die Version aus der Antwort (Alt-Version → veraltet). */
  const alt = await pingTabs([{ id: 20 }], async () => ({ ok: true, version: '1.5.5' }), '1.5.6');
  assert.deepStrictEqual(alt.stale, [20]);

  console.log('test-stale-tabs: OK');
})().catch(e => { console.error(e); process.exit(1); });
