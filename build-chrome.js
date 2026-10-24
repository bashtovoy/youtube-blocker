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
   die lokale Dev-Brücke und gehört nie ins Paket. Tesseract-Reste aus alten
   setup.sh-Läufen werden ebenfalls nicht mitkopiert: Mit der Paddle-Integration
   sollen beide OCR-Asset-Sätze nicht im selben Release liegen. */
const EXCLUDE = new Set(['models', 'devreport.js', '.DS_Store']);
const EXCLUDE_FILES = new Set([
  'tesseract.min.js',
  'worker-tesseract.min.js',
  'tesseract-core-simd.wasm.js',
  'eng.traineddata.gz',
  'rus.traineddata.gz'
]);

/* Der Face-Filter lädt nichts aus dem Netz: ohne diese Dateien würde das
   Chrome-Paket erst beim ersten Vorschaubild scheitern. Firefox nutzt dieselben
   Dateien im Hintergrundkontext. */
const FACE_ASSETS = [
  'lib/mediapipe/vision_bundle.js',
  'lib/mediapipe/wasm/vision_wasm_internal.js',
  'lib/mediapipe/wasm/vision_wasm_internal.wasm',
  'lib/mediapipe/wasm/vision_wasm_nosimd_internal.js',
  'lib/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
  'lib/mediapipe/face_landmarker.task'
];

function assertFaceAssets() {
  const missing = FACE_ASSETS.filter(rel => {
    try { return !fs.statSync(path.join(SRC, rel)).size; } catch (e) { return true; }
  });
  if (missing.length) {
    throw new Error('MediaPipe-Assets fehlen:\n  ' + missing.join('\n  ') +
      '\nBitte zuerst ./setup.sh ausführen.');
  }
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    if (entry.isFile() && EXCLUDE_FILES.has(entry.name)) continue;
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

/* MV2→MV3: Host-Muster wandern nach host_permissions, browser_action wird action,
   der Hintergrund wird Service Worker (die Hosts laufen dort im Offscreen-Dokument),
   und der WASM-Bedarf (SigLIP/PaddleOCR/MediaPipe) braucht 'wasm-unsafe-eval' in der CSP. */
function buildChromeManifest(ff) {
  const permissions = [];
  const hostPermissions = [];
  for (const p of ff.permissions || []) {
    (String(p).includes('://') ? hostPermissions : permissions).push(p);
  }
  /* Optionale Berechtigungen getrennt führen: <all_urls> und Host-Muster dürfen
     in MV3 nicht in permissions stehen (Kontrollbilder werden erst beim
     Einschalten der Einstellung angefragt). */
  const optionalPermissions = [];
  const optionalHostPermissions = [];
  for (const p of ff.optional_permissions || []) {
    const s = String(p);
    (s === '<all_urls>' || s.includes('://') ? optionalHostPermissions : optionalPermissions).push(p);
  }
  permissions.push('offscreen');
  /* Automatische Neu-Injektion der Content-Scripts in offene Tabs nach Updates
     (chrome.scripting.executeScript; in Firefox macht das tabs.executeScript). */
  permissions.push('scripting');
  return {
    manifest_version: 3,
    name: ff.name,
    version: ff.version,
    description: ff.description,
    minimum_chrome_version: '116',   /* runtime.getContexts/offscreen-Prüfung */
    icons: ff.icons,
    permissions,
    host_permissions: hostPermissions,
    ...(optionalPermissions.length ? { optional_permissions: optionalPermissions } : {}),
    ...(optionalHostPermissions.length ? { optional_host_permissions: optionalHostPermissions } : {}),
    background: { service_worker: 'background.js' },
    action: ff.browser_action,
    content_scripts: ff.content_scripts,
    /* connect-src blockiert die MediaPipe-Telemetrie zu odml.pa.googleapis.com;
       erlaubt bleiben lokale Dateien, Blobs, der Thumbnail-Host und HuggingFace
       für den bestehenden SigLIP-Erstbezug. */
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' blob: data: https://i.ytimg.com https://huggingface.co https://*.huggingface.co https://hf.co https://*.hf.co"
    }
  };
}

function main() {
  const ff = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  if (ff.manifest_version !== 2) throw new Error('Erwartet MV2-Manifest als Quelle');
  assertFaceAssets();

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
