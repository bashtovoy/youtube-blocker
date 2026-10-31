const fs = require('fs'), vm = require('vm'), assert = require('assert');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(require('path').join(__dirname, '../extension/matcher.js'), 'utf8'), sandbox);
const m = sandbox.window.YB.matcher;
assert.strictEqual(m.normalizeAllowAll, undefined, 'globale Freigabeliste ist entfernt');
assert.strictEqual(m.levenshtein, undefined, 'Fuzzy-Hilfsfunktion ist entfernt');
/* Exakter Abgleich nach Normalisierung: Fälle, ё/е, Bindestriche und
   Satzzeichen werden vereinheitlicht; Wortformen bleiben getrennt. */
assert.strictEqual(m.matchKeywords('Политика Германии сегодня', ['политика']), 'политика');
assert.strictEqual(m.matchKeywords('Ёжик в тумане', ['ежик']), 'ежик');
assert.strictEqual(m.matchKeywords('Робот-пылесос', ['робот пылесос']), 'робот пылесос');
assert.strictEqual(m.matchKeywords('This is a chair', ['AI']), null);
assert.strictEqual(m.matchKeywords('Электромобили и батареи', ['электромобили']), 'электромобили');
assert.strictEqual(m.matchKeywords('Новое видео про Claude AI', ['claude ai']), 'claude ai');
assert.strictEqual(m.matchKeywords('машины будущего', ['машины']), 'машины');
/* Keine Tippfehler-, Stamm- oder Mehrzahl-Toleranz: Varianten müssen
   ausdrücklich in der Liste stehen. */
assert.strictEqual(m.matchKeywords('Temporary Root', ['robot']), null, 'root ≠ robot');
assert.strictEqual(m.matchKeywords('Here is how I hide it (No Root)', ['robot']), null, 'root ≠ robot (No Root)');
assert.strictEqual(m.matchKeywords('I drove the car', ['drone']), null, 'drove ≠ drone');
assert.strictEqual(m.matchKeywords('2027 Off-Roader', ['roadster']), null, 'roader ≠ roadster');
assert.strictEqual(m.matchKeywords('robotic arm', ['robot']), null, 'robot ≠ robotic');
assert.strictEqual(m.matchKeywords('Drohne über Kassel', ['drone']), null, 'Drohne ≠ drone');
assert.strictEqual(m.matchKeywords('Drohne über Kassel', ['drohne']), 'drohne');
assert.strictEqual(m.matchKeywords('Teslas und Roboter', ['Tesla']), null, 'Teslas ≠ Tesla');
assert.strictEqual(m.matchKeywords('Teslas und Roboter', ['Teslas']), 'Teslas');
assert.strictEqual(m.matchKeywords('many robots', ['robot']), null, 'robots ≠ robot');
assert.strictEqual(m.matchKeywords('many robots', ['robots']), 'robots');
assert.strictEqual(m.matchKeywords('машины', ['машина']), null, 'машины ≠ машина');
assert.strictEqual(m.matchKeywords('машины', ['машины']), 'машины');
assert.strictEqual(m.matchKeywords('automatic', ['auto']), null, 'kein Prefix-Matching');
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
/* LIVE-Badge wie auf youtube.com/results?search_query=live (31.10.2026):
   Klassennamen sind sprachunabhängig, der sichtbare Text ist es nicht. */
for (const text of [
  'LIVE', 'live', 'Live now', 'Now live', 'Jetzt live',
  'В ЭФИРЕ', 'в эфире', 'Прямой эфир', 'Прямая трансляция', 'Трансляция',
  'НАЖИВО', 'Прямий ефір', 'Пряма трансляція', 'Трансляція',
  'En direct', 'En vivo', 'Ao vivo', 'In diretta', 'Na żywo', 'Canlı',
  'ライブ', '直播'
]) {
  assert.strictEqual(m.isLiveBadgeText(text), true, 'live badge: ' + text);
}
/* Gegenproben: Titelwörter und andere Badges dürfen nicht zählen. */
for (const text of [
  'Live news', 'LIVE: SpongeBob', 'New', '4K', 'Members only',
  'AI', 'KI', 'Verified', '', null
]) {
  assert.strictEqual(m.isLiveBadgeText(text), false, 'not a live badge: ' + text);
}
console.log('matcher tests: OK');
