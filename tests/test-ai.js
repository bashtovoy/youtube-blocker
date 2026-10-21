/* test-ai.js — Helfer für die offizielle KI-Kennzeichnung (extension/ai.js).
   Prüft Watch-Links, Badge-Suche und die lokalisierten Sperrtexte ohne DOM. */
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');

const sandbox = { window: {}, self: {}, console, URL };
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'ai.js'), 'utf8'), sandbox);
const a = sandbox.YB && sandbox.YB.ai;
assert.ok(a, 'ai.js muss YB.ai exportieren');

/* ---- 1) Watch-Links: nur echte /watch?v=<11 Zeichen> ---- */
assert.strictEqual(a.watchId('https://www.youtube.com/watch?v=wFAvZSefhnE'), 'wFAvZSefhnE');
assert.strictEqual(a.watchId('https://youtube.com/watch?v=wFAvZSefhnE'), 'wFAvZSefhnE');
assert.strictEqual(a.watchId('https://m.youtube.com/watch?list=PL1&v=wFAvZSefhnE&t=30s'), 'wFAvZSefhnE');
assert.strictEqual(a.watchId('https://www.youtube.com/watch?app=desktop&v=wFAvZSefhnE#comments'), 'wFAvZSefhnE');
assert.strictEqual(a.watchId('https://www.youtube.com/live/wFAvZSefhnE?feature=share'), 'wFAvZSefhnE', 'Live-Videoseite');
assert.strictEqual(a.watchId('https://www.youtube.com/watch'), '', 'ohne v');
assert.strictEqual(a.watchId('https://www.youtube.com/watch?v=kurz'), '', 'keine 11 Zeichen');
assert.strictEqual(a.watchId('https://www.youtube.com/shorts/wFAvZSefhnE'), '', 'Shorts hat keine Watch-Metadaten');
assert.strictEqual(a.watchId('https://www.youtube.com.evil.example/watch?v=wFAvZSefhnE'), '', 'fremder Host');
assert.strictEqual(a.watchId('https://example.com/watch?v=wFAvZSefhnE'), '', 'fremder Host');
assert.strictEqual(a.watchId(''), '');
assert.strictEqual(a.watchId(null), '');

/* ---- 2) Badge-Suche: Text, aria-label, title, auch am Kindknoten ---- */
const selector = a.WATCH_BADGE_SELECTOR;
function fakeBadge(fields, children) {
  return {
    textContent: fields.text || '',
    getAttribute(name) { return fields[name] || null; },
    querySelectorAll(sel) { return sel === '[aria-label], [title]' ? (children || []) : []; }
  };
}
const phraseBadge = fakeBadge({ 'aria-label': 'AI: Content was made with AI' });
const tokenBadge = fakeBadge({}, [fakeBadge({ title: 'KI-Hinweis' })]);
const membersBadge = fakeBadge({ 'aria-label': 'Members only' });

function fakeRoot(badges) {
  return { querySelectorAll(sel) { return sel === selector ? badges : []; } };
}
const isAi = text => /made with AI|^KI-Hinweis$/i.test(String(text || ''));
assert.strictEqual(a.findBadge(fakeRoot([membersBadge, phraseBadge]), isAi), phraseBadge, 'aria-label');
assert.strictEqual(a.findBadge(fakeRoot([tokenBadge]), isAi), tokenBadge, 'Kindknoten-Titel');
assert.strictEqual(a.findBadge(fakeRoot([membersBadge]), isAi), null, 'Members ist kein KI-Badge');
assert.strictEqual(a.findBadge(null, isAi), null);
assert.strictEqual(a.findBadge(fakeRoot([phraseBadge]), null), null);

/* ---- 3) Sperrtexte in allen Oberflächensprachen ---- */
for (const lang of ['de', 'en', 'ru', 'uk']) {
  const text = a.overlayText(lang);
  assert.ok(text && text.title && text.body && text.back, 'Sperrtext fehlt: ' + lang);
  assert.ok(!/undefined/.test(text.title + text.body), 'kein undefined: ' + lang);
}
assert.strictEqual(a.overlayText('ru-RU').back, 'Назад');
assert.strictEqual(a.overlayText('unbekannt'), a.overlayText('en'), 'Fallback Englisch');

console.log('test-ai: OK');
