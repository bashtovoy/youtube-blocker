/* test-promo.js — Werbekarten-Erkennung (extension/promo-rules.js + promo.js).
   Prüft: Textmarker (Badge/CTA/Preis) in vier Sprachen, interne/externe Ziele,
   Punktschwelle, Diagnose-Fingerabdruck und Klingelspeicher. Kein Browser, kein Netz. */
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');
const load = f => fs.readFileSync(path.join(__dirname, '..', 'extension', f), 'utf8');

const sandbox = { window: {}, console, URL };
sandbox.window = sandbox;   /* content scripts setzen window.YB; in der VM genügt Selbstbezug */
vm.createContext(sandbox);
vm.runInContext(load('promo-rules.js'), sandbox);
vm.runInContext(load('promo.js'), sandbox);
const p = sandbox.YB.promo;
const R = sandbox.YB.promoRules;
assert.ok(p && R, 'promo.js muss YB.promo exportieren');

/* ---- 1) Badge-Marker (starkes Signal) in vier Sprachen + Werbe-Labels ---- */
for (const t of [
  'YouTube рекомендует', 'YouTube empfiehlt', 'YouTube recommends', 'YouTube рекомендує',
  'Recommended by YouTube', 'Empfohlen von YouTube',
  'Sponsored', 'Gesponsert', 'Содержит платную рекламу', 'Enthält bezahlte Werbung',
  'Реклама', 'Anzeige', 'Ad', 'реклама'
]) {
  assert.strictEqual(p.classifyBadge(t), true, 'badge: ' + t);
}
for (const t of [
  'Только для спонсоров', 'Members only', 'Рекомендуем посмотреть', 'YouTube',
  'Подписчики', '10:30', '', null, 'Nur für Mitglieder'
]) {
  assert.strictEqual(p.classifyBadge(t), false, 'kein badge: ' + t);
}

/* ---- 2) Handlungsaufforderungen ---- */
for (const t of [
  'Попробовать за 0 грн', 'Попробовать', 'Установить', 'Подробнее', 'Зарегистрироваться',
  'Try for free', 'Learn more', 'Get started', 'Install',
  'Mehr erfahren', 'Kostenlos testen', 'Jetzt kaufen',
  'Спробувати', 'Дізнатися більше'
]) {
  assert.strictEqual(p.classifyCta(t), true, 'cta: ' + t);
}
for (const t of ['Смотреть', 'Поделиться', 'Подписаться', '10:30', '', null, 'Комментарии']) {
  assert.strictEqual(p.classifyCta(t), false, 'kein cta: ' + t);
}
/* Rückfall ohne Anker: Aufforderung mitten im Kartentext */
assert.strictEqual(p.classifyCtaAnywhere('канал 10 мес назад попробовать за 0 грн'), true);
assert.strictEqual(p.classifyCtaAnywhere('обычное видео про ремонт'), false);

/* ---- 3) Preis-/Gratis-Marker ---- */
for (const t of ['0 грн', '0,00 €', '0 ₽', '0.50 $', 'бесплатно', 'Free', 'Gratis', 'Kostenlos', 'Безкоштовно']) {
  assert.strictEqual(p.classifyPrice(t), true, 'price: ' + t);
}
for (const t of ['10 грн', '399 ₴', 'freedom', 'платный курс по математике', '', null]) {
  assert.strictEqual(p.classifyPrice(t), false, 'kein price: ' + t);
}

/* ---- 4) Interne vs. externe Ziele ---- */
for (const href of [
  '/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://youtu.be/dQw4w9WgXcQ', 'https://music.youtube.com/watch?v=x',
  'https://www.youtube.com/@Droidwin', 'https://i.ytimg.com/vi/x/hq720.jpg',
  '#', 'javascript:void(0)'
]) {
  assert.strictEqual(p.isInternalHref(href), true, 'intern: ' + href);
}
for (const href of [
  'https://droidwin.com/tool', 'https://example.org/landing',
  'https://www.youtube.com/redirect?q=https%3A%2F%2Fdroidwin.com%2Ftool&v=x',
  'https://googleads.g.doubleclick.net/pagead/x'
]) {
  assert.strictEqual(p.isInternalHref(href), false, 'extern: ' + href);
}

/* ---- 5) Punktschwelle: ein starkes Signal reicht, schwache nicht ---- */
const w = R.weights;
assert.ok(w.badge >= R.threshold, 'Badge allein muss die Schwelle erreichen');
assert.ok(w.container >= R.threshold, 'Werbe-Container allein muss die Schwelle erreichen');
assert.ok(w.cta + w.price < R.threshold, 'CTA+Preis dürfen allein nicht ausblenden');
assert.ok(w.external + w.cta >= R.threshold, 'externes Ziel + CTA muss reichen');
const sig = (id) => [{ id, weight: w[id] }];
assert.strictEqual(p.computeScore(sig('badge')), w.badge);
assert.strictEqual(p.computeScore([]), 0);

/* ---- 6) analyze() per Ersatz-Karte (ohne DOM): Titel wird abgezogen ---- */
const promoCard = {
  tagName: 'YTD-RICH-ITEM-RENDERER',
  textContent: 'OPLUS EDL Tool: Unbrick OnePlus Droidwin 13:40 10 мес. назад YouTube рекомендует Попробовать за 0 грн'
};
const a1 = p.analyze(promoCard, { title: 'OPLUS EDL Tool: Unbrick OnePlus' });
assert.strictEqual(a1.isHit, true, 'Werbekarte muss erkannt werden');
assert.ok(a1.signals.some(s => s.id === 'badge'), 'Badge-Signal fehlt');
assert.ok(a1.signals.some(s => s.id === 'cta'), 'CTA-Signal fehlt');
assert.ok(a1.signals.some(s => s.id === 'price'), 'Preis-Signal fehlt');

const normalCard = {
  tagName: 'YTD-RICH-ITEM-RENDERER',
  textContent: 'Нормальное видео про ремонт Droidwin 13:40 10 мес. назад 1,2 млн просмотров'
};
assert.strictEqual(p.analyze(normalCard, { title: 'Нормальное видео про ремонт' }).isHit, false, 'normale Karte darf nicht ausblenden');

/* Titel, der nur zufällig wie Werbung aussieht, darf nicht zählen */
const titleTrap = {
  tagName: 'YTD-RICH-ITEM-RENDERER',
  textContent: 'Попробовать за 0 грн Как я снимал видео 8:20 2 недели назад 400 тыс просмотров'
};
const a2 = p.analyze(titleTrap, { title: 'Попробовать за 0 грн' });
assert.strictEqual(a2.isHit, false, 'Werbe-Wörter im Titel dürfen nicht zählen');

/* ---- 7) Diagnose: Verdachtswörter und Klingelspeicher ---- */
assert.ok(p.suspectWords('YouTube рекомендует').includes('рекоменд'));
assert.ok(p.suspectWords('Werbung und Anzeige').length >= 1);
assert.ok(p.suspectWords('акция 0 грн').some(x => x.includes('0')));
assert.deepStrictEqual(Array.from(p.suspectWords('обычное видео')), []);

/* Datumsangaben in DE/UK zählen als Metadaten (kein noMeta-Signal) */
const deDate = { tagName: 'YTD-RICH-ITEM-RENDERER', textContent: 'Ruhiges Video Kanal vor 2 Wochen' };
assert.ok(!p.analyze(deDate, { title: 'Ruhiges Video' }).signals.some(s => s.id === 'noMeta'), 'deutsches Datum fehlt als Metadatum');
const ukDate = { tagName: 'YTD-RICH-ITEM-RENDERER', textContent: 'Спокійне відео Канал 2 тижні тому' };
assert.ok(!p.analyze(ukDate, { title: 'Спокійне відео' }).signals.some(s => s.id === 'noMeta'), 'ukrainisches Datum fehlt als Metadatum');

const info = { score: 2, signals: [{ id: 'cta' }, { id: 'price' }], suspects: ['0 грн'], texts: ['Попробовать за 0 грн'], hosts: ['droidwin.com'], rulesVersion: R.version };
const fp1 = p.fingerprint(info, promoCard, { title: 'X' });
const fp2 = p.fingerprint(info, promoCard, { title: 'X' });
assert.strictEqual(fp1.hash, fp2.hash, 'Fingerabdruck muss stabil sein');
assert.strictEqual(fp1.rulesVersion, R.version);
assert.ok(fp1.at && fp1.at.includes('T'), 'Zeitstempel fehlt');
assert.notStrictEqual(fp1.hash, p.fingerprint({ ...info, texts: ['другое'] }, promoCard, { title: 'X' }).hash, 'anderer Inhalt → anderer Hash');

let list = [];
list = p.addSuspect(list, fp1, 2);
assert.strictEqual(list.length, 1);
assert.strictEqual(list[0].hash, fp1.hash);
list = p.addSuspect(list, fp1, 2);   /* Duplikat */
assert.strictEqual(list.length, 1, 'Duplikat darf nicht doppelt gespeichert werden');
const fpB = p.fingerprint({ ...info, texts: ['второе'] }, promoCard, { title: 'Y' });
list = p.addSuspect(list, fpB, 2);
assert.strictEqual(list.length, 2);
assert.strictEqual(list[0].hash, fpB.hash, 'neueste Einträge stehen vorn');
const fpC = p.fingerprint({ ...info, texts: ['третье'] }, promoCard, { title: 'Z' });
list = p.addSuspect(list, fpC, 2);
assert.strictEqual(list.length, 2, 'Obergrenze wird eingehalten');
assert.ok(!list.some(e => e.hash === fp1.hash), 'ältester Eintrag fällt heraus');

/* ---- 8) Regeln als Daten: Pflichtfelder vorhanden ---- */
assert.strictEqual(typeof R.version, 'number');
assert.ok(Array.isArray(R.containers) && R.containers.includes('ytd-ad-slot-renderer'));
assert.ok(R.threshold >= 1 && R.suspectsMax >= 10);

/* ---- 9) analyze() mit DOM-Stand: Container, externes Ziel, CTA-Button ----
   Ersatz-Karte liefert genau die Selektor-Abfragen, die promo.js stellt. */
const joinSel = list => list.join(', ');
function cardStub(opts) {
  return {
    tagName: 'YTD-RICH-ITEM-RENDERER',
    textContent: opts.text || '',
    matches: sel => !!(opts.self && sel === joinSel(R.containers) && opts.self === 'container'),
    querySelector: sel => {
      if (sel === joinSel(R.containers)) return opts.container ? { tagName: 'YTD-AD-SLOT-RENDERER' } : null;
      return null;
    },
    querySelectorAll: sel => {
      if (sel === 'a[href]') return (opts.links || []).map(href => ({ getAttribute: k => (k === 'href' ? href : null) }));
      if (sel === joinSel(R.ctaSelectors)) return (opts.buttons || []).map(text => ({ textContent: text }));
      if (sel === joinSel(R.badgeSelectors)) return (opts.badges || []).map(text => ({ textContent: text, getAttribute: () => null }));
      if (sel === joinSel(R.markerSelectors)) return (opts.markers || []).map(text => ({ textContent: text }));
      return [];
    }
  };
}
const domCard = cardStub({
  text: 'Обычное видео Канал 5:12 1 мес. назад 200 тыс просмотров',
  container: true,
  links: ['https://droidwin.com/tool'],
  buttons: ['Установить бесплатно'],
  markers: ['Установить бесплатно', 'Sponsored']
});
const d1 = p.analyze(domCard, { title: 'Обычное видео' });
assert.strictEqual(d1.isHit, true, 'Container/extern/CTA muss die Schwelle erreichen');
assert.deepStrictEqual(Array.from(d1.signals.map(s => s.id)), ['container', 'external', 'cta']);
assert.deepStrictEqual(Array.from(d1.hosts), ['droidwin.com']);
assert.deepStrictEqual(Array.from(p.markerTexts(domCard)), ['Установить бесплатно', 'Sponsored']);

const domBadge = cardStub({
  text: 'Видео Канал 7:00 2 мес. назад',
  badges: ['YouTube рекомендует'],
  markers: ['YouTube рекомендует']
});
assert.strictEqual(p.analyze(domBadge, { title: 'Видео' }).isHit, true, 'Badge-Knoten muss zählen');

const domClean = cardStub({
  text: 'Видео Канал 7:00 2 мес. назад 500 тыс просмотров',
  links: ['/watch?v=dQw4w9WgXcQ']
});
assert.strictEqual(p.analyze(domClean, { title: 'Видео' }).isHit, false, 'saubere Karte darf nicht auslösen');

console.log('promo tests: OK (' + R.badgePatterns.length + ' Badge-, ' + R.ctaPatterns.length + ' CTA-, ' + R.pricePatterns.length + ' Preismuster, Schwelle ' + R.threshold + ')');
