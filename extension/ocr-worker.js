/* ocr-worker.js — Einstieg des Tesseract-Workers (workerPath in ocr-host.js).
   Die Reihenfolge ist entscheidend: erst der Log-Filter (quiet-warn.js), dann das
   Tesseract-Skript. Der Kern (lib/tesseract-core-simd.wasm.js) meldet „Image too
   small to scale!! …“ und „Line cannot be recognized!!“ über console.warn und
   bindet die Funktion beim eigenen Laden — ohne den Filter sammelt
   chrome://extensions sie als Warnungen der Erweiterung ein. Alles andere bleibt
   sichtbar. */
importScripts('quiet-warn.js');
importScripts('lib/worker-tesseract.min.js');
