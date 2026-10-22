#!/usr/bin/env node
/* Static preflight for the YouTube Blocker E2E run. Never mutates the repo. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const flag = name => argv.includes(name);
const browser = arg('--browser', 'all');
const requireModels = flag('--require-models');
const asJson = flag('--json');

const rows = [];
const add = (level, name, detail = '') => rows.push({ level, name, detail });
const ok = (name, detail) => add('PASS', name, detail);
const warn = (name, detail) => add('WARN', name, detail);
const fail = (name, detail) => add('FAIL', name, detail);

const abs = rel => path.join(ROOT, rel);
const exists = rel => fs.existsSync(abs(rel));
const readJson = rel => {
  try { return JSON.parse(fs.readFileSync(abs(rel), 'utf8')); } catch { return null; }
};

function walk(dir, filter = () => true, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (!filter(p, entry)) continue;
    if (entry.isDirectory()) walk(p, filter, out);
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

const IGNORED_SOURCE = /(^|\/)(models|lib|devreport\.js|\.DS_Store)(\/|$)/;
function newestSourceMtime() {
  const files = walk(abs('extension'), p => !IGNORED_SOURCE.test(path.relative(abs('extension'), p).split(path.sep).join('/')));
  return files.reduce((max, p) => Math.max(max, fs.statSync(p).mtimeMs), 0);
}

/* ---------------------------------------------------------------- Node */
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 20) ok('node', process.versions.node);
else fail('node', `${process.versions.node} (need >= 20 for ESM test scripts)`);

/* ------------------------------------------------------- Firefox source */
const ff = readJson('extension/manifest.json');
if (!ff) {
  fail('firefox manifest', 'extension/manifest.json missing or invalid JSON');
} else {
  if (ff.manifest_version === 2) ok('firefox manifest', `MV2 ${ff.version}`);
  else fail('firefox manifest', `manifest_version=${ff.manifest_version}, expected 2`);

  const required = new Set([
    'extension/popup/popup.html',
    'extension/popup/popup.js',
    'extension/offscreen.html',
    'extension/offscreen.js'
  ]);
  for (const s of ff.background?.scripts || []) required.add('extension/' + s);
  for (const cs of ff.content_scripts || []) {
    for (const s of cs.js || []) required.add('extension/' + s);
  }
  for (const icon of Object.values(ff.icons || {})) required.add('extension/' + icon);
  const missing = [...required].filter(rel => !exists(rel));
  if (missing.length === 0) ok('firefox files', `${required.size} manifest-referenced files present`);
  else fail('firefox files', `missing: ${missing.join(', ')}`);
}

/* --------------------------------------------------------- Chrome build */
const dist = readJson('dist-chrome/manifest.json');
if (!dist) {
  (browser === 'chrome' ? fail : warn)('chrome build', 'dist-chrome/manifest.json missing; run node build-chrome.js');
} else {
  if (dist.manifest_version === 3) ok('chrome manifest', `MV3 ${dist.version}`);
  else fail('chrome manifest', `manifest_version=${dist.manifest_version}, expected 3`);
  if (ff && dist.version !== ff.version) {
    fail('version sync', `extension=${ff.version}, dist-chrome=${dist.version}; rebuild Chrome`);
  } else if (ff) {
    ok('version sync', ff.version);
  }
  const required = new Set([
    'dist-chrome/popup/popup.html',
    'dist-chrome/popup/popup.js',
    'dist-chrome/offscreen.html',
    'dist-chrome/offscreen.js'
  ]);
  if (dist.background?.service_worker) required.add('dist-chrome/' + dist.background.service_worker);
  for (const cs of dist.content_scripts || []) {
    for (const s of cs.js || []) required.add('dist-chrome/' + s);
  }
  for (const icon of Object.values(dist.icons || {})) required.add('dist-chrome/' + icon);
  const missing = [...required].filter(rel => !exists(rel));
  if (missing.length === 0) ok('chrome files', `${required.size} manifest-referenced files present`);
  else fail('chrome files', `missing: ${missing.join(', ')}`);

  const srcTime = newestSourceMtime();
  const distTime = fs.statSync(abs('dist-chrome/manifest.json')).mtimeMs;
  if (srcTime > distTime) warn('chrome freshness', 'extension/ is newer than dist-chrome/; run node build-chrome.js');
  else ok('chrome freshness', 'dist-chrome/ is current');
}

/* ------------------------------------------------------------- assets */
const siglipDir = 'extension/models/siglip-base-patch16-224';
const siglipFiles = walk(abs(siglipDir)).map(p => path.relative(abs(siglipDir), p));
const hasModel = siglipFiles.some(f => /^onnx\/.*\.onnx$/.test(f));
const hasTokenizer = ['tokenizer.json', 'config.json', 'preprocessor_config.json'].every(f => siglipFiles.includes(f));
if (hasModel && hasTokenizer) {
  ok('SigLIP assets', `${siglipFiles.filter(f => f.endsWith('.onnx')).length} ONNX file(s) + tokenizer`);
} else {
  const detail = `missing ${hasModel ? '' : 'onnx/*.onnx '}${hasTokenizer ? '' : 'tokenizer/config'}`.trim();
  (requireModels ? fail : warn)('SigLIP assets', detail || 'incomplete');
}

const ocrFiles = [
  'extension/lib/paddle.bundle.js',
  'extension/lib/ppocrv5_mobile_det.tar',
  'extension/lib/en_ppocrv5_mobile_rec.tar',
  'extension/lib/eslav_ppocrv5_mobile_rec.tar',
  'extension/lib/ort-wasm-simd-threaded.jsep.wasm'
];
const ocrMissing = ocrFiles.filter(rel => !exists(rel));
if (ocrMissing.length === 0) ok('OCR assets', `${ocrFiles.length} files`);
else (requireModels ? fail : warn)('OCR assets', `missing: ${ocrMissing.join(', ')}`);

const whisperStub = exists('extension/lib/whisper.js') &&
  fs.statSync(abs('extension/lib/whisper.js')).size < 500;
if (!exists('extension/models/ggml-base.bin')) {
  warn('speech assets', `whisper model missing${whisperStub ? ' (lib/whisper.js is only a placeholder)' : ''}; P2 speech unavailable`);
} else {
  ok('speech assets', 'models/ggml-base.bin');
}

/* -------------------------------------------------------------- tests */
const unitTests = walk(abs('tests'), p => /test-.*\.js$/.test(p));
if (unitTests.length) add('INFO', 'unit tests', `${unitTests.length} file(s); run node tests/test-*.js before E2E if code changed`);
else warn('unit tests', 'no tests/test-*.js found');

/* ------------------------------------------------------------- report */
const summary = {
  pass: rows.filter(r => r.level === 'PASS').length,
  warn: rows.filter(r => r.level === 'WARN').length,
  fail: rows.filter(r => r.level === 'FAIL').length
};

if (asJson) {
  console.log(JSON.stringify({ root: ROOT, browser, node: process.versions.node, results: rows, summary }, null, 2));
} else {
  console.log(`YouTube Blocker E2E preflight`);
  console.log(`root: ${ROOT}`);
  console.log(`node: ${process.versions.node}`);
  for (const r of rows) {
    const line = `${r.level.padEnd(4)} ${r.name}${r.detail ? ' — ' + r.detail : ''}`;
    console.log(r.level === 'FAIL' ? `\x1b[31m${line}\x1b[0m` : r.level === 'WARN' ? `\x1b[33m${line}\x1b[0m` : line);
  }
  console.log(`\nSummary: pass=${summary.pass} warn=${summary.warn} fail=${summary.fail}`);
}

process.exit(summary.fail > 0 ? 1 : 0);
