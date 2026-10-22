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

/* WASM (SigLIP/PaddleOCR) braucht die CSP-Ausnahme; keine gecko-Einstellungen. */
assert.ok(/script-src 'self'/.test(m.content_security_policy.extension_pages));
assert.ok(/wasm-unsafe-eval/.test(m.content_security_policy.extension_pages));
assert.ok(!('browser_specific_settings' in m));

/* Inhaltliche Parität zur Firefox-Seite bewusst erhalten. */
assert.deepStrictEqual(m.icons, ff.icons);
assert.deepStrictEqual(m.content_scripts, ff.content_scripts);
assert.ok(String(m.minimum_chrome_version).length > 0);

console.log('test-chrome-manifest: OK');
