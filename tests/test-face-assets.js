/* test-face-assets.js — lokale MediaPipe-Dateien für den Face-Filter.
   Prüft, dass die gepinnten Assets vollständig im Paket liegen, das Manifest
   sie in beiden Builds lädt und weder Host noch Setup auf einen CDN-Download
   zur Laufzeit angewiesen sind. Kein Browser, kein Netz. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MP = path.join(ROOT, 'extension', 'lib', 'mediapipe');
const FILES = {
  'vision_bundle.js': 100000,
  'wasm/vision_wasm_internal.js': 200000,
  'wasm/vision_wasm_internal.wasm': 10000000,
  'wasm/vision_wasm_nosimd_internal.js': 200000,
  'wasm/vision_wasm_nosimd_internal.wasm': 10000000,
  'face_landmarker.task': 3000000,
  'LICENSE': 10000,
  'NOTICE.md': 200
};

for (const [rel, min] of Object.entries(FILES)) {
  const file = path.join(MP, rel);
  assert.ok(fs.existsSync(file), 'fehlt: lib/mediapipe/' + rel + ' (./setup.sh ausführen)');
  const st = fs.statSync(file);
  assert.ok(st.isFile() && st.size >= min,
    'zu klein: lib/mediapipe/' + rel + ' (' + st.size + ' < ' + min + ')');
}

/* Wasm-Magic und ein ZIP-basiertes Task-Bundle (MediaPipe .task). */
assert.strictEqual(fs.readFileSync(path.join(MP, 'wasm/vision_wasm_internal.wasm')).subarray(0, 4).toString('latin1'), '\0asm');
assert.strictEqual(fs.readFileSync(path.join(MP, 'wasm/vision_wasm_nosimd_internal.wasm')).subarray(0, 4).toString('latin1'), '\0asm');
assert.ok(fs.readFileSync(path.join(MP, 'face_landmarker.task')).includes(Buffer.from('PK')));

/* Das Bundle muss die verwendeten Klassen enthalten und ohne eval auskommen. */
const bundle = fs.readFileSync(path.join(MP, 'vision_bundle.js'), 'utf8');
for (const sym of ['FaceLandmarker', 'FilesetResolver', 'forVisionTasks']) {
  assert.ok(bundle.includes(sym), 'vision_bundle.js enthält ' + sym);
}
assert.ok(!/new\s+Function\s*\(/.test(bundle), 'kein new Function im Bundle');
assert.ok(!/(^|[^A-Za-z_$])eval\s*\(/.test(bundle), 'kein eval im Bundle');

/* Manifest/Offscreen laden die neuen Dateien in der richtigen Reihenfolge. */
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
const bg = manifest.background.scripts;
assert.ok(bg.includes('face-score.js'));
assert.ok(bg.includes('face-host.js'));
assert.ok(bg.indexOf('face-host.js') > bg.indexOf('face-score.js'));
assert.ok(bg.indexOf('host-routes.js') > bg.indexOf('face-host.js'));
assert.ok(manifest.content_scripts[0].js.includes('face.js'));
assert.ok(manifest.content_scripts[0].css.includes('face.css'));
const offscreen = fs.readFileSync(path.join(ROOT, 'extension', 'offscreen.html'), 'utf8');
assert.ok(offscreen.includes('face-score.js'));
assert.ok(offscreen.includes('face-host.js'));

/* Laufzeitpfade bleiben lokal; die Modell-URL steht nur im Setup-Skript. */
const host = fs.readFileSync(path.join(ROOT, 'extension', 'face-host.js'), 'utf8');
assert.ok(host.includes("getURL('lib/mediapipe/')"));
assert.ok(host.includes("'face_landmarker.task'"));
assert.ok(!/https?:\/\/(cdn|storage\.googleapis)/.test(host), 'Host lädt das Modell nicht aus dem Netz');
const setup = fs.readFileSync(path.join(ROOT, 'setup.sh'), 'utf8');
assert.ok(setup.includes('@mediapipe/tasks-vision@1.1.1'));
assert.ok(setup.includes('face_landmarker/float16/1/face_landmarker.task'));
const build = fs.readFileSync(path.join(ROOT, 'build-chrome.js'), 'utf8');
assert.ok(build.includes('assertFaceAssets()'));

console.log('face-assets tests: OK');
