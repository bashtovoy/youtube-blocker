#!/usr/bin/env node
/* devtest.js — End-to-End-Test: holt echte Titel aus den YouTube-Ergebnissen,
   setzt ein Schlüsselwort, befiehlt der Erweiterung Navigation/Scan, wartet auf Logs */
'use strict';

const fs = require('fs');
const path = require('path');
const CMD_FILE = path.join(__dirname, 'devcommands.json');

const SETTINGS = {
  enabled: true,
  mode: 'dismiss',
  checkTitle: true,
  checkThumbOcr: false,
  checkThumbHash: false,
  checkSpeech: false,
  hashThreshold: 8,
  actionDelayMs: 1500,
  logMatch: true
};

function collectVideos(obj, out) {
  if (!obj || typeof obj !== 'object') return;
  if (obj.videoRenderer && obj.videoRenderer.videoId && obj.videoRenderer.title) {
    const vr = obj.videoRenderer;
    const title = (vr.title.runs || []).map(r => r.text).join('');
    if (title) out.push({ id: vr.videoId, title });
  }
  for (const k of Object.keys(obj)) collectVideos(obj[k], out);
}

async function getSearchTitles(query) {
  const r = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(query),
    { headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en-US,en;q=0.9', cookie: 'CONSENT=YES+cb; SOCS=CAI' } });
  const html = await r.text();
  const m = html.match(/ytInitialData\s*=\s*(\{.*?\});<\/script>/s) || html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) return [];
  const data = JSON.parse(m[1]);
  const out = [];
  collectVideos(data, out);
  const seen = new Set();
  return out.filter(v => !seen.has(v.id) && seen.add(v.id) && v.title.length > 15);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const query = process.argv[2] || 'daily vlog';
  const titles = await getSearchTitles(query);
  console.log('Videos in den Suchergebnissen:', titles.length);
  if (!titles.length) { console.error('Titel konnten nicht abgerufen werden'); process.exit(1); }
  /* die 2 obersten Videos nehmen — ihre vollständigen Titel werden zu Schlüsselwörtern
     (werden an die bestehende blocklist.json angehängt, nicht ersetzt) */
  const targets = titles.slice(0, 2);
  for (const t of targets) console.log('Ziel:', t.id, t.title.slice(0, 80));
  let base = [];
  try {
    base = JSON.parse(fs.readFileSync(path.join(__dirname, 'blocklist.json'), 'utf8')).keywords || [];
  } catch (e) {}
  const keywords = base.concat(targets.map(t => t.title));

  fs.writeFileSync(CMD_FILE, JSON.stringify([
    { action: 'log', text: '=== devtest start ===' },
    { action: 'config', settings: SETTINGS, keywords },
    { action: 'navigate', url: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query) },
    { action: 'noop' }, { action: 'noop' }, /* ~8 s zum Laden */
    { action: 'scroll', fraction: 0.35 },
    { action: 'noop' }, { action: 'noop' },
    { action: 'scroll', fraction: 0.6 },
    { action: 'rescan' },
    { action: 'noop' }, { action: 'noop' }, { action: 'noop' }, { action: 'noop' },
    { action: 'log', text: '=== devtest end ===' },
    { action: 'done' }
  ]));
  console.log('Befehle in die Warteschlange gestellt, warte…');
  await sleep(45000);
  console.log('Test abgeschlossen, siehe dev.log');
})();
