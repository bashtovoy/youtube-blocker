#!/usr/bin/env node
/* build-chrome.js — erzeugt die Chrome-MV3-Sammlung aus demselben Quellbaum:
   - kopiert extension/ nach dist-chrome/ (ohne Modelle, ohne Dev-/Systemdateien),
   - transformiert manifest.json von MV2 (Firefox) nach MV3 (Chrome),
   - packt web-ext-artifacts/youtube_blocker-<version>-chrome.zip für
     „Load unpacked" bzw. den Chrome Web Store.
   Die Firefox-Sammlung bleibt bei `npx web-ext build` (siehe README). */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'dist-chrome');
const ART = path.join(ROOT, 'web-ext-artifacts');

/* Modelle lädt die Erweiterung zur Laufzeit (HF-Erstbezug); devreport.js ist
   die lokale Dev-Brücke und gehört nie ins Paket. */
const EXCLUDE = new Set(['models', 'devreport.js', '.DS_Store']);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

/* MV2→MV3: Host-Muster wandern nach host_permissions, browser_action wird action,
   der Hintergrund wird Service Worker (die Hosts laufen dort im Offscreen-Dokument),
   und der WASM-Bedarf (SigLIP/Tesseract) braucht 'wasm-unsafe-eval' in der CSP. */
function buildChromeManifest(ff) {
  const permissions = [];
  const hostPermissions = [];
  for (const p of ff.permissions || []) {
    (String(p).includes('://') ? hostPermissions : permissions).push(p);
  }
  permissions.push('offscreen');
  return {
    manifest_version: 3,
    name: ff.name,
    version: ff.version,
    description: ff.description,
    minimum_chrome_version: '116',   /* runtime.getContexts/offscreen-Prüfung */
    icons: ff.icons,
    permissions,
    host_permissions: hostPermissions,
    background: { service_worker: 'background.js' },
    action: ff.browser_action,
    content_scripts: ff.content_scripts,
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
    }
  };
}

function main() {
  const ff = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  if (ff.manifest_version !== 2) throw new Error('Erwartet MV2-Manifest als Quelle');

  fs.rmSync(OUT, { recursive: true, force: true });
  copyDir(SRC, OUT);
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(buildChromeManifest(ff), null, 2) + '\n');

  fs.mkdirSync(ART, { recursive: true });
  const zip = path.join(ART, `youtube_blocker-${ff.version}-chrome.zip`);
  fs.rmSync(zip, { force: true });
  execFileSync('zip', ['-r', '-X', '-q', zip, '.'], { cwd: OUT });
  console.log('OK  dist-chrome/ und ' + path.relative(ROOT, zip));
}

if (require.main === module) main();
module.exports = { buildChromeManifest };
