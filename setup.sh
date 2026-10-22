#!/usr/bin/env bash
# setup.sh — lädt die Bibliotheken für die Erweiterung Youtube Blocker
# (OCR: PaddleOCR.js; optional: whisper.cpp für die Spracherkennung)
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

LIB="extension/lib"
MODELS="extension/models"
SEMANTIC_MODEL="$MODELS/siglip-base-patch16-224"
mkdir -p "$LIB" "$MODELS" "$SEMANTIC_MODEL"

echo "==> Transformers.js + SigLIP: semantische Bilderkennung (optional, lokal)"
curl -fsSL -o "$LIB/transformers.min.js" \
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/dist/transformers.min.js"
curl -fsSL -o "$SEMANTIC_MODEL/config.json" \
  "https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/main/config.json"
curl -fsSL -o "$SEMANTIC_MODEL/preprocessor_config.json" \
  "https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/main/preprocessor_config.json"
curl -fsSL -o "$SEMANTIC_MODEL/tokenizer.json" \
  "https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/main/tokenizer.json"
curl -fsSL -o "$SEMANTIC_MODEL/tokenizer_config.json" \
  "https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/main/tokenizer_config.json"
curl -fsSL -o "$SEMANTIC_MODEL/special_tokens_map.json" \
  "https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/main/special_tokens_map.json"
curl -fsSL -o "$SEMANTIC_MODEL/spiece.model" \
  "https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/main/spiece.model"
mkdir -p "$SEMANTIC_MODEL/onnx"
# Nur die beiden Türme (q4f16 für WebGPU, q8 für WASM — seit 1.5.4; das
# frühere 218-MB-Gesamtmodell wird seit 1.4.0 nicht mehr gebraucht).
curl -fL --progress-bar -o "$SEMANTIC_MODEL/onnx/vision_model_q4f16.onnx" \
  "https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/main/onnx/vision_model_q4f16.onnx"
curl -fL --progress-bar -o "$SEMANTIC_MODEL/onnx/vision_model_quantized.onnx" \
  "https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/main/onnx/vision_model_quantized.onnx"
curl -fL --progress-bar -o "$SEMANTIC_MODEL/onnx/text_model_q4f16.onnx" \
  "https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/main/onnx/text_model_q4f16.onnx"
curl -fL --progress-bar -o "$SEMANTIC_MODEL/onnx/text_model_quantized.onnx" \
  "https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/main/onnx/text_model_quantized.onnx"
# Lokale ONNX-Runtime-WASM (Fallback für CPU/WASM) — dasselbe dist wie transformers.min.js.
# Der Worker setzt wasmPaths=./lib/, daher müssen diese Dateien in extension/lib/ liegen.
curl -fsSL -o "$LIB/ort-wasm-simd-threaded.jsep.mjs" \
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/dist/ort-wasm-simd-threaded.jsep.mjs"
curl -fL --progress-bar -o "$LIB/ort-wasm-simd-threaded.jsep.wasm" \
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/dist/ort-wasm-simd-threaded.jsep.wasm"
# Der Function-Konstruktor im Emscripten-Glue ist nur ein globalThis-Fallback,
# wird von Chrome aber als eval-Warnung im AMO-Bericht gemeldet.
node "$ROOT/tools/patch-ort-wasm.js" "$LIB/ort-wasm-simd-threaded.jsep.mjs"
echo "SigLIP bereit: Bild- und Text-Turm je q4f16 (WebGPU) + q8 (WASM) + lokale ONNX-WASM-Runtime; Inferenz — lokal im Browser."
echo
echo "==> PaddleOCR.js (OCR der Vorschaubilder) — 0.4.2"
# Das npm-Paket ist ESM und zieht OpenCV/ONNX nach; für die Erweiterung wird
# daraus ein einzelnes IIFE-Bundle gebaut. Es enthält KEINE Modelle und KEINE
# ORT-WASM-Dateien — beide kommen separat aus diesem Skript bzw. lib/.
if ! command -v npm >/dev/null 2>&1; then
  echo "!! npm fehlt — PaddleOCR.js kann nicht gebündelt werden." >&2
  exit 1
fi
PADDLE_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/yb-paddle.XXXXXX")"
cleanup_paddle_build() { rm -rf "$PADDLE_BUILD"; }
trap cleanup_paddle_build EXIT
cp "$ROOT/tools/paddle-entry.js" "$ROOT/tools/paddle-empty.js" "$ROOT/tools/opencv-shim.js" "$PADDLE_BUILD/"
(
  cd "$PADDLE_BUILD"
  npm init -y >/dev/null 2>&1
  npm install --silent --no-audit --no-fund --save-exact \
    "@paddleocr/paddleocr-js@0.4.2" \
    "fast-opencv-wasm@4.10.0-14" \
    "clipper-lib@6.4.2" \
    "js-yaml@4.3.2" \
    "onnxruntime-web@1.22.0" \
    "onnxruntime-common@1.22.0" \
    "esbuild@0.25.10"
  ./node_modules/.bin/esbuild paddle-entry.js \
    --bundle --format=iife --platform=browser --target=es2022 \
    --alias:fs=./paddle-empty.js --alias:path=./paddle-empty.js \
    --alias:crypto=./paddle-empty.js \
    --alias:@techstark/opencv-js=./opencv-shim.js \
    --outfile="$ROOT/$LIB/paddle.bundle.js"
  # OpenCV liegt bewusst als separate WASM-Datei vor: AMO parst JS-Dateien
  # über 5 MB nicht, der rund 10-MB-asm.js-Build würde die Validierung
  # blockieren. Der Glue-Code sucht `opencv_js.wasm` neben dem Bundle.
  cp node_modules/fast-opencv-wasm/opencv.wasm "$ROOT/$LIB/opencv_js.wasm"
)
# Chrome MV3 erlaubt kein 'unsafe-eval'; die dynamischen Embind-Aufrufer von
# OpenCV/ONNX Runtime werden deshalb direkt nach dem Bundling durch Closures
# ersetzt.
node "$ROOT/tools/patch-paddle-bundle.js" "$ROOT/$LIB/paddle.bundle.js"

# Offizielle PP-OCRv5-ONNX-Assets. Der Detektor wird von beiden Erkennern
# gemeinsam genutzt; en liest Latein, eslav deckt Latein und Kyrillisch ab.
# Der bcebos-Server bricht gelegentlich mitten im Transfer ab; curl setzt
# vorhandene Teildateien fort (-C -), und tar -tf prüft das Ergebnis.
download_tar() {
  local out="$1" url="$2" attempt
  if [[ -s "$out" ]] && tar -tf "$out" >/dev/null 2>&1; then
    echo "OK  vorhanden: $(basename "$out")"
    return 0
  fi
  for attempt in 1 2 3 4 5; do
    curl -fL --retry 5 --retry-delay 3 --connect-timeout 30 \
      -C - --progress-bar -o "$out" "$url" || true
    if tar -tf "$out" >/dev/null 2>&1; then return 0; fi
    echo "!! Download unvollständig (Versuch $attempt): $(basename "$out")" >&2
    sleep 3
  done
  echo "!! Modell konnte nicht vollständig geladen werden: $url" >&2
  return 1
}
download_tar "$LIB/ppocrv5_mobile_det.tar" \
  "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_onnx_infer.tar"
download_tar "$LIB/en_ppocrv5_mobile_rec.tar" \
  "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/en_PP-OCRv5_mobile_rec_onnx_infer.tar"
download_tar "$LIB/eslav_ppocrv5_mobile_rec.tar" \
  "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/eslav_PP-OCRv5_mobile_rec_onnx_infer.tar"

# Alte Tesseract-Reste aus früheren Installationen entfernen: Sie werden nicht
# mehr geladen und sollen nicht versehentlich im Release-ZIP landen.
rm -f "$LIB/tesseract.min.js" \
      "$LIB/worker-tesseract.min.js" \
      "$LIB/tesseract-core-simd.wasm.js" \
      "$LIB/eng.traineddata.gz" \
      "$LIB/rus.traineddata.gz"

echo
read -r -p "whisper.cpp + Modell für die Spracherkennung herunterladen? (~100 MB, [y/N]) " ANSWER || ANSWER=""
if [[ "$ANSWER" == "y" || "$ANSWER" == "Y" || "$ANSWER" == "yes" ]]; then
  echo "==> whisper.cpp WebAssembly (dist v6)"
  curl -fsSL -o "$LIB/whisper.js" \
    "https://raw.githubusercontent.com/ggerganov/whisper.cpp/master/dist/whisper.js"
  curl -fsSL -o "$LIB/whisper.js.map" \
    "https://raw.githubusercontent.com/ggerganov/whisper.cpp/master/dist/whisper.js.map" || true
  echo "==> ggml-Modell (base.en q8_0, ~80 MB; für Russisch besser small/medium mittlerer Größe)"
  read -r -p "Modellname (base.en | small.en | small | base) [base]: " MNAME || MNAME=""
  MNAME=${MNAME:-base}
  case "$MNAME" in
    base)  FILE="ggml-base.en.bin";  URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" ;;
    base.en) FILE="ggml-base.en.bin"; URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" ;;
    small.en) FILE="ggml-small.en.bin"; URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin" ;;
    small) FILE="ggml-small.bin"; URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin" ;;
    *) echo "unbekanntes Modell"; exit 1 ;;
  esac
  curl -fL --progress-bar -o "$MODELS/$FILE" "$URL"
  echo "Modell: models/$FILE (diesen Pfad in den Erweiterungseinstellungen angeben)"
fi

echo
# Weiche Prüfung (bricht das Skript trotz set -e nicht ab): Warnung, wenn etwas nicht geladen wurde.
for F in \
  "$LIB/paddle.bundle.js" \
  "$LIB/opencv_js.wasm" \
  "$LIB/ppocrv5_mobile_det.tar" \
  "$LIB/en_ppocrv5_mobile_rec.tar" \
  "$LIB/eslav_ppocrv5_mobile_rec.tar" \
  "$LIB/ort-wasm-simd-threaded.jsep.mjs" \
  "$LIB/ort-wasm-simd-threaded.jsep.wasm" \
  "$SEMANTIC_MODEL/onnx/vision_model_q4f16.onnx" \
  "$SEMANTIC_MODEL/onnx/vision_model_quantized.onnx" \
  "$SEMANTIC_MODEL/onnx/text_model_q4f16.onnx" \
  "$SEMANTIC_MODEL/onnx/text_model_quantized.onnx" \
  "$SEMANTIC_MODEL/tokenizer.json" \
  "$SEMANTIC_MODEL/tokenizer_config.json" \
  "$SEMANTIC_MODEL/special_tokens_map.json" \
  "$SEMANTIC_MODEL/spiece.model"; do
  if [[ -s "$F" ]]; then echo "OK  $F"; else echo "!!  fehlt/leer: $F — die zugehörige Funktion ist sonst nicht verfügbar"; fi
done

echo "Fertig. Inhalt von extension/lib:"
ls -lh "$LIB"
echo
echo "Installation in Firefox: about:debugging#/runtime/this-firefox → „Temporäres Add-on laden“ → extension/manifest.json"
