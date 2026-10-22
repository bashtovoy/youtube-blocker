#!/usr/bin/env node
/* patch-ort-wasm.js — entfernt den Function-Konstruktor aus dem von
   transformers.js geladenen ONNX-Runtime-Glue. Das Muster ist nur ein
   Fallback für Umgebungen ohne globalThis; Chrome meldet es trotzdem als
   eval-Warnung im AMO-Bericht. `globalThis` ist in allen unterstützten
   Browsern vorhanden, daher genügt der direkte Zugriff. */
'use strict';
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('Verwendung: node tools/patch-ort-wasm.js <ort-wasm-*.mjs>');
  process.exit(2);
}

let source = fs.readFileSync(file, 'utf8');
const old = 'var $d=()=>"object"==typeof globalThis?globalThis:Function("return this")();';
const replacement = 'var $d=()=>globalThis;';
if (!source.includes(old)) {
  throw new Error('ORT-Function-Fallback nicht gefunden (Version geändert?)');
}
source = source.replace(old, replacement);
if (source.includes('Function("return this")')) {
  throw new Error('Im ORT-Glue ist weiterhin ein Function-Konstruktor vorhanden');
}
fs.writeFileSync(file, source);
console.log('OK  ORT-WASM ohne Function-Konstruktor gepatcht: ' + file);
