/* test-margin.js — kontrastive Margin-Entscheidung (docs/SEMANTIC_FILTER_ROUTING.md, Punkt 3).
   Reine Logik aus extension/semantic.js im VM-Sandbox (kein Modell, kein Browser). */
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const sandbox = { window: {}, browser: {} };
vm.runInNewContext(
  fs.readFileSync(require('path').join(__dirname, '../extension/semantic.js'), 'utf8'),
  sandbox
);
const sem = sandbox.window.YB.semantic;
assert.strictEqual(typeof sem.marginDecision, 'function', 'marginDecision muss exportiert sein');
assert.strictEqual(sem.bestTextMatch, undefined, 'Sigmoider Altpfad (bestTextMatch) darf nicht mehr existieren');

const S = (text, cos) => ({ text, cos });

/* Leere / unbrauchbare Eingaben */
assert.strictEqual(sem.marginDecision([], 0.1), null);
assert.strictEqual(sem.marginDecision(null, 0.1), null);
assert.strictEqual(sem.marginDecision([S('Drone', NaN), { text: '', cos: 0.5 }], 0.1), null);

/* Einzelkonzept: keine Konkurrenz → Margin = Kosinus */
let r = sem.marginDecision([S('Drone', 0.30)], 0.1);
assert.strictEqual(r.text, 'Drone');
assert.strictEqual(r.refText, null);
assert.strictEqual(r.margin, 0.30);
assert.strictEqual(sem.marginDecision([S('Drone', 0.05)], 0.1), null);

/* Margin = Ziel-Kosinus − bester konkurrierender Kosinus (Gewinner = Top-Kosinus) */
r = sem.marginDecision([S('Drone', 0.32), S('Navy', 0.31), S('news', 0.12)], 0.005);
assert.strictEqual(r.text, 'Drone');
assert.strictEqual(r.refText, 'Navy');
assert.ok(Math.abs(r.refCos - 0.31) < 1e-9);
assert.ok(Math.abs(r.margin - 0.01) < 1e-9);
/* Schwelle knapp über der Margin → kein Treffer */
assert.strictEqual(sem.marginDecision([S('Drone', 0.32), S('Navy', 0.31)], 0.011), null);
/* Grenzwert inklusiv */
assert.notStrictEqual(sem.marginDecision([S('Drone', 0.32), S('Navy', 0.31)], 0.01), null);

/* Synonym-Kannibalisierung ist dokumentiertes Verhalten: Drone/Dron drücken sich */
r = sem.marginDecision([S('Drone', 0.34), S('Dron', 0.33), S('Navy', 0.10)], 0.005);
assert.strictEqual(r.text, 'Drone');
assert.strictEqual(r.refText, 'Dron');
assert.ok(Math.abs(r.margin - 0.01) < 1e-9);

/* Ungültige Schwelle → konservativer Default 0.1 */
assert.strictEqual(sem.marginDecision([S('Drone', 0.30), S('Navy', 0.29)], NaN), null);   /* margin 0.01 < 0.1 */
assert.notStrictEqual(sem.marginDecision([S('Drone', 0.30), S('Navy', 0.10)], 'x'), null); /* margin 0.20 >= 0.1 */

console.log('margin tests: OK');
