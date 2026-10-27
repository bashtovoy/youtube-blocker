/* test-chrome-manifest.js — Chrome-MV3-Manifest wird aus dem Firefox-Manifest
   erzeugt (build-chrome.js): Host-Muster, Service Worker, CSP, offscreen. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildChromeManifest } = require('../build-chrome.js');

const ff = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
const m = buildChromeManifest(ff);

assert.strictEqual(m.manifest_version, 3);
assert.strictEqual(m.background.service_worker, 'background.js');
assert.strictEqual(m.version, ff.version);
assert.ok(m.action && m.action.default_popup === 'popup/popup.html');

/* Kanalzähler muss in beiden Builds vor content.js/background.js geladen werden. */
assert.ok(ff.background.scripts.includes('ai-channel.js'));
assert.ok(ff.content_scripts[0].js.includes('ai-channel.js'));
assert.ok(ff.content_scripts[0].css.includes('ai-channel.css'));
assert.ok(m.content_scripts[0].js.includes('ai-channel.js'));
assert.ok(m.content_scripts[0].css.includes('ai-channel.css'));

/* Videoqualität (ab 1.9.0): Die Regeln stehen im Isolated-Skript vor content.js;
   der MAIN-World-Controller ist ein eigener Eintrag mit quality.js nach den Regeln. */
assert.strictEqual(ff.version, '1.9.1');
assert.ok(ff.content_scripts[0].js.includes('quality-rules.js'), 'quality-rules.js im Isolated-Skript');
assert.ok(ff.content_scripts[0].js.indexOf('quality-rules.js') < ff.content_scripts[0].js.indexOf('content.js'),
  'quality-rules.js vor content.js');
assert.strictEqual(ff.content_scripts.length, 2, 'ein Isolated- und ein MAIN-Eintrag');
const qualityMain = ff.content_scripts.find(cs => cs.world === 'MAIN');
assert.ok(qualityMain, 'MAIN-World-Eintrag vorhanden');
assert.deepStrictEqual(qualityMain.matches, ['*://www.youtube.com/*'], 'MAIN nur auf www.youtube.com');
assert.deepStrictEqual(qualityMain.js, ['quality-rules.js', 'quality.js'], 'Regeln vor dem Controller');
assert.strictEqual(qualityMain.run_at, 'document_start');
assert.strictEqual(qualityMain.all_frames, false);
assert.deepStrictEqual(m.content_scripts, ff.content_scripts, 'MAIN-Eintrag übersteht den Chrome-Build');

/* Face-Filter: Bewertung, Host und Client müssen in beiden Builds vorhanden
   sein; der Host steht nach den Hosts und vor der Routentabelle. */
const scripts = ff.background.scripts;
assert.ok(scripts.indexOf('face-score.js') > 0, 'face-score.js im Hintergrund');
assert.ok(scripts.indexOf('face-host.js') > scripts.indexOf('face-score.js'), 'face-host.js nach face-score.js');
assert.ok(scripts.indexOf('host-routes.js') > scripts.indexOf('face-host.js'), 'host-routes.js nach face-host.js');
assert.ok(ff.content_scripts[0].js.includes('face.js'), 'face.js im Content-Skript');
assert.ok(ff.content_scripts[0].css.includes('face.css'), 'face.css im Content-Skript');
const offscreen = fs.readFileSync(path.join(__dirname, '..', 'extension', 'offscreen.html'), 'utf8');
assert.ok(offscreen.indexOf('face-score.js') > 0 && offscreen.indexOf('face-host.js') > offscreen.indexOf('face-score.js'));
assert.ok(offscreen.indexOf('host-routes.js') > offscreen.indexOf('face-host.js'));

/* Host-Muster gehören in MV3 nach host_permissions, nicht in permissions */
assert.deepStrictEqual(m.host_permissions,
  ['*://*.youtube.com/*', '*://music.youtube.com/*', '*://*.ytimg.com/*', '*://*.googlevideo.com/*']);
assert.ok(!m.permissions.some(p => String(p).includes('://')), 'permissions ohne Host-Muster');
for (const p of ['storage', 'unlimitedStorage', 'tabs', 'offscreen', 'scripting']) {
  assert.ok(m.permissions.includes(p), 'permissions enthält ' + p);
}

/* Optionale Berechtigungen der Kontrollbilder: <all_urls> gehört in MV3 zu den
   optionalen Host-Berechtigungen, „downloads“ bleibt eine normale. */
assert.deepStrictEqual(m.optional_permissions, ['downloads']);
assert.deepStrictEqual(m.optional_host_permissions, ['<all_urls>']);
assert.ok(!m.host_permissions.includes('<all_urls>'), 'optional bleibt optional');

/* WASM (SigLIP/PaddleOCR/MediaPipe) braucht die CSP-Ausnahme; keine gecko-Einstellungen. */
assert.ok(/script-src 'self'/.test(m.content_security_policy.extension_pages));
assert.ok(/wasm-unsafe-eval/.test(m.content_security_policy.extension_pages));
assert.ok(/connect-src 'self' blob: data: https:\/\/i\.ytimg\.com/.test(m.content_security_policy.extension_pages),
  'CSP erlaubt den lokalen Thumbnail-Host');
assert.ok(/https:\/\/huggingface\.co/.test(m.content_security_policy.extension_pages) &&
  /https:\/\/\*\.hf\.co/.test(m.content_security_policy.extension_pages),
  'CSP erlaubt den bestehenden SigLIP-Erstbezug');
assert.ok(!/googleapis|odml|pa\.googleapis/.test(m.content_security_policy.extension_pages),
  'CSP blockiert MediaPipe-Telemetrie');
assert.ok(!('browser_specific_settings' in m));

/* Firefox-MV2-CSP: gleiche Ausnahme für Wasm, gleiche Connect-Allowlist. */
assert.ok(/script-src 'self'/.test(ff.content_security_policy));
assert.ok(/wasm-unsafe-eval/.test(ff.content_security_policy));
assert.ok(/connect-src 'self' blob: data: https:\/\/i\.ytimg\.com/.test(ff.content_security_policy));
assert.ok(/https:\/\/huggingface\.co/.test(ff.content_security_policy));
assert.ok(!/googleapis|odml/.test(ff.content_security_policy));

/* Inhaltliche Parität zur Firefox-Seite bewusst erhalten. */
assert.deepStrictEqual(m.icons, ff.icons);
assert.deepStrictEqual(m.content_scripts, ff.content_scripts);
assert.ok(String(m.minimum_chrome_version).length > 0);

console.log('test-chrome-manifest: OK');
