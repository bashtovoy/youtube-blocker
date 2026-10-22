/* Einstieg für OpenCV im Paddle-Bundle.
   `@techstark/opencv-js` ist ein 10-MB-asm.js-Bundle; AMO parst keine
   JavaScript-Dateien über 5 MB. `fast-opencv-wasm` liefert dasselbe
   OpenCV-4.10-API als kleines JS-Glue plus separate `opencv_js.wasm`, die
   als Binärdatei nicht vom Validator geparst wird.

   Das Paket exportiert eine Fabrik, nicht das initialisierte Modul. Wir laden
   die WASM-Datei aus dem Erweiterungspaket und übergeben sie als `wasmBinary`;
   dadurch ist `cv.Mat` sofort nach dem Auflösen des Promise verfügbar.
   PaddleOCR wartet in `getOpenCv()` auf genau dieses Promise. */
import pkg from 'fast-opencv-wasm';

const factory = (pkg && pkg.cv) || pkg;

function wasmUrl() {
  if (globalThis.YB_OPENCV_WASM_URL) return globalThis.YB_OPENCV_WASM_URL;
  const script = typeof document !== 'undefined' && document.currentScript;
  if (script && script.src) return new URL('opencv_js.wasm', script.src).href;
  return 'opencv_js.wasm';
}

async function init() {
  const res = await fetch(wasmUrl(), { credentials: 'same-origin' });
  if (!res.ok) throw new Error('OpenCV-WASM konnte nicht geladen werden (HTTP ' + res.status + ')');
  return factory({ wasmBinary: await res.arrayBuffer() });
}

export default init();
