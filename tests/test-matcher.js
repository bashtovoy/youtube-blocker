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
/* KI-Hinweis-Badge wie auf watch?v=wFAvZSefhnE (18.10.2026, vier Sprachen). */
for (const text of [
  'AI', 'ai', 'KI', 'ИИ', 'ШІ', ' ии ',
  'AI: Content was made with AI',
  'KI-Hinweis: Inhalt wurde mit KI erstellt',
  'ИИ: контент создан с помощью ИИ',
  'ШІ: контент створено за допомогою штучного інтелекту'
]) {
  assert.strictEqual(m.isAiBadgeText(text), true, 'ai badge: ' + text);
}
/* Gegenproben: KI-Wörter im Titel oder andere Badges dürfen nie zählen. */
for (const text of [
  'AI news', 'Sora AI', 'AI music mix', 'KI-News', 'MAI', 'АИ',
  'Auto-dubbed', 'Members only', 'Новое видео про Claude AI', '', null
]) {
  assert.strictEqual(m.isAiBadgeText(text), false, 'not an ai badge: ' + text);
}
console.log('matcher tests: OK');
