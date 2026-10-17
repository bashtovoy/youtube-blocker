const fs = require('fs'), vm = require('vm'), assert = require('assert');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(require('path').join(__dirname, '../extension/matcher.js'), 'utf8'), sandbox);
const m = sandbox.window.YB.matcher;
assert.strictEqual(m.matchKeywords('Политика Германии сегодня', ['политика'], {fuzzy: true}), 'политика');
assert.strictEqual(m.matchKeywords('This is a chair', ['AI'], {fuzzy: true}), null);
assert.strictEqual(m.matchKeywords('Электромобили и батареи', ['электромобил'], {fuzzy: true}), 'электромобил');
assert.strictEqual(m.matchKeywords('Новое видео про Claude AI', ['claude ai'], {fuzzy: true}), 'claude ai');
assert.strictEqual(m.matchKeywords('машины будущего', ['машин'], {fuzzy: true}), 'машин');
/* Badge-Texte wie auf youtube.com/@LinusTechTips/videos (17.10.2026). */
for (const text of [
  'Nur für Kanalmitglieder', 'Nur für Mitglieder', 'Mitglieder',
  'Только для спонсоров', 'Лише для спонсорів', 'Участникам',
  'Members only', 'Member only',
  'Réservé aux membres', 'Solo para miembros', 'Só para membros',
  'Solo per membri', 'Tylko dla członków', 'Yalnızca üyeler'
]) {
  assert.strictEqual(m.isMembersOnlyText(text), true, 'members badge: ' + text);
}
for (const text of ['Sponsored', '10:30', 'Membership', 'Спонсировано', '', null]) {
  assert.strictEqual(m.isMembersOnlyText(text), false, 'not a members badge: ' + text);
}
console.log('matcher tests: OK');
