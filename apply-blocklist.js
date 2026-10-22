#!/usr/bin/env node
/* apply-blocklist.js — blocklist.json über die Dev-Brücke auf die Erweiterung anwenden */
'use strict';

const fs = require('fs');
const path = require('path');
const CMD_FILE = path.join(__dirname, 'devcommands.json');
const BL = JSON.parse(fs.readFileSync(path.join(__dirname, 'blocklist.json'), 'utf8'));

const SETTINGS = {
  enabled: true,
  mode: 'dismiss',
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
console.log('Befehle in der Warteschlange: config (' + BL.keywords.length + ' Wörter) + rescan');

(async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    await new Promise(r => setTimeout(r, 2000));
    if (!fs.existsSync(CMD_FILE) || fs.readFileSync(CMD_FILE, 'utf8').trim() === '[]') {
      console.log('angewendet (Warteschlange leer)');
      process.exit(0);
    }
  }
  console.log('Achtung: Warteschlange nach 60 s nicht leer — der Firefox-Tab ist möglicherweise nicht aktiv (eine geöffnete Seite youtube.com ist erforderlich)');
})();
