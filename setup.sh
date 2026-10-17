#!/usr/bin/env bash
# setup.sh — lädt die Bibliotheken für die Erweiterung Youtube Blocker
# (OCR: tesseract.js; optional: whisper.cpp für die Spracherkennung)
set -euo pipefail
cd "$(dirname "$0")"

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
# Nur die beiden Türme (q4f16 für WebGPU, q4 für WASM); das frühere 218-MB-
# Gesamtmodell wird seit 1.4.0 nicht mehr gebraucht.
curl -fL --progress-bar -o "$SEMANTIC_MODEL/onnx/vision_model_q4f16.onnx" \
  "https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/main/onnx/vision_model_q4f16.onnx"
curl -fL --progress-bar -o "$SEMANTIC_MODEL/onnx/vision_model_q4.onnx" \
  "https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/main/onnx/vision_model_q4.onnx"
curl -fL --progress-bar -o "$SEMANTIC_MODEL/onnx/text_model_q4f16.onnx" \
  "https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/main/onnx/text_model_q4f16.onnx"
curl -fL --progress-bar -o "$SEMANTIC_MODEL/onnx/text_model_q4.onnx" \
  "https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/main/onnx/text_model_q4.onnx"
# Lokale ONNX-Runtime-WASM (Fallback für CPU/WASM) — dasselbe dist wie transformers.min.js.
# Der Worker setzt wasmPaths=./lib/, daher müssen diese Dateien in extension/lib/ liegen.
curl -fsSL -o "$LIB/ort-wasm-simd-threaded.jsep.mjs" \
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/dist/ort-wasm-simd-threaded.jsep.mjs"
curl -fL --progress-bar -o "$LIB/ort-wasm-simd-threaded.jsep.wasm" \
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/dist/ort-wasm-simd-threaded.jsep.wasm"
echo "SigLIP bereit: Bild- und Text-Turm je q4f16 (WebGPU) + q4 (WASM) + lokale ONNX-WASM-Runtime; Inferenz — lokal im Browser."
echo
echo "==> Tesseract.js (OCR der Vorschaubilder) — v4.1.1"
curl -fsSL -o "$LIB/tesseract.min.js" \
  "https://cdn.jsdelivr.net/npm/tesseract.js@4.1.1/dist/tesseract.min.js"
# Worker-Skript: läuft im Background-Host (ocr-host.js), nicht mehr im Content-Script
curl -fsSL -o "$LIB/worker-tesseract.min.js" \
  "https://cdn.jsdelivr.net/npm/tesseract.js@4.1.1/dist/worker.min.js"
# WASM-Kern (SIMD, selbstenthalten inklusive wasm-Binärdatei) — passend zu
# tesseract.js 4.1.1; ocr-host.js setzt corePath/langPath auf lib/ (kein CDN)
curl -fsSL -o "$LIB/tesseract-core-simd.wasm.js" \
  "https://cdn.jsdelivr.net/npm/tesseract.js-core@4.0.4/tesseract-core-simd.wasm.js"
# Sprachdaten — müssen im Paket liegen; ocr-host.js lädt zur Laufzeit nichts vom CDN
for L in eng rus; do
  curl -fsSL -o "$LIB/${L}.traineddata.gz" \
    "https://tessdata.projectnaptha.com/4.0.0/${L}.traineddata.gz" || \
  echo "!! ${L}.traineddata.gz fehlt — OCR für diese Sprache ist dann nicht verfügbar"
done

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
  "$LIB/ort-wasm-simd-threaded.jsep.mjs" \
  "$LIB/ort-wasm-simd-threaded.jsep.wasm" \
  "$SEMANTIC_MODEL/onnx/vision_model_q4f16.onnx" \
  "$SEMANTIC_MODEL/onnx/vision_model_q4.onnx" \
  "$SEMANTIC_MODEL/onnx/text_model_q4f16.onnx" \
  "$SEMANTIC_MODEL/onnx/text_model_q4.onnx" \
  "$SEMANTIC_MODEL/tokenizer.json" \
  "$SEMANTIC_MODEL/tokenizer_config.json" \
  "$SEMANTIC_MODEL/special_tokens_map.json" \
  "$SEMANTIC_MODEL/spiece.model"; do
  if [[ -s "$F" ]]; then echo "OK  $F"; else echo "!!  fehlt/leer: $F — Modelle werden sonst beim ersten Lauf von HuggingFace nachgeladen"; fi
done

echo "Fertig. Inhalt von extension/lib:"
ls -lh "$LIB"
echo
echo "Installation in Firefox: about:debugging#/runtime/this-firefox → „Temporäres Add-on laden“ → extension/manifest.json"
