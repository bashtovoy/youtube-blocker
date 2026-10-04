#!/usr/bin/env node
/* apply-blocklist.js — применить blocklist.json к расширению через dev-мост */
'use strict';

const fs = require('fs');
const path = require('path');
const CMD_FILE = path.join(__dirname, 'devcommands.json');
const BL = JSON.parse(fs.readFileSync(path.join(__dirname, 'blocklist.json'), 'utf8'));

const SETTINGS = {
  enabled: true,
  mode: 'dismiss',
  fuzzy: true,
  checkTitle: true,
  checkThumbOcr: false,
  checkThumbHash: false,
  checkSpeech: false,
  hashThreshold: 8,
  actionDelayMs: 2500,
  logMatch: true
};

fs.writeFileSync(CMD_FILE, JSON.stringify([
  { action: 'config', settings: SETTINGS, keywords: BL.keywords },
  { action: 'rescan' },
  { action: 'done' }
]));
console.log('команды в очереди: config (' + BL.keywords.length + ' слов) + rescan');

(async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    await new Promise(r => setTimeout(r, 2000));
    if (!fs.existsSync(CMD_FILE) || fs.readFileSync(CMD_FILE, 'utf8').trim() === '[]') {
      console.log('применено (очередь пуста)');
      process.exit(0);
    }
  }
  console.log('внимание: очередь не опустела за 60с — вкладка Firefox, возможно, не активна (нужна открытая страница youtube.com)');
})();
