#!/usr/bin/env bash
# setup.sh — скачивает библиотеки для расширения Youtube Blocker
# (OCR: tesseract.js; опционально: whisper.cpp для распознавания речи)
set -euo pipefail
cd "$(dirname "$0")"

LIB="extension/lib"
MODELS="extension/models"
SEMANTIC_MODEL="$MODELS/siglip-base-patch16-224"
mkdir -p "$LIB" "$MODELS" "$SEMANTIC_MODEL"

echo "==> Transformers.js + SigLIP semantic vision (опциональный, локальный)"
curl -fsSL -o "$LIB/transformers.min.js" \
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/dist/transformers.min.js"
curl -fsSL -o "$SEMANTIC_MODEL/config.json" \
  "https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/main/config.json"
curl -fsSL -o "$SEMANTIC_MODEL/preprocessor_config.json" \
  "https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/main/preprocessor_config.json"
mkdir -p "$SEMANTIC_MODEL/onnx"
curl -fL --progress-bar -o "$SEMANTIC_MODEL/onnx/vision_model_q4f16.onnx" \
  "https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/main/onnx/vision_model_q4f16.onnx"
echo "SigLIP готов: ~55 МБ; инференс выполняется локально в браузере."
echo
echo "==> Tesseract.js (OCR миниатюр) — v4.1.1"
curl -fsSL -o "$LIB/tesseract.min.js" \
  "https://cdn.jsdelivr.net/npm/tesseract.js@4.1.1/dist/tesseract.min.js"
# WASM-ядро (SIMD) — подхватится автоматически из lib/
curl -fsSL -o "$LIB/tesseract-core-simd.wasm.js" \
  "https://cdn.jsdelivr.net/npm/tesseract-core-simd-wasm@1.0.2/tesseract-core-simd.wasm.js" || \
curl -fsSL -o "$LIB/tesseract-core-simd.wasm.js" \
  "https://cdn.jsdelivr.net/gh/naptha/tesseract.js-core@v5.1.1/tesseract-core-simd.wasm.js"
curl -fsSL -o "$LIB/tesseract-core-simd.wasm" \
  "https://cdn.jsdelivr.net/gh/naptha/tesseract.js-core@v5.1.1/tesseract-core-simd.wasm" || true
# Языковые данные (чтобы не зависеть от CDN во время работы)
for L in eng rus; do
  curl -fsSL -o "$LIB/${L}.traineddata.gz" \
    "https://tessdata.projectnaptha.com/4.0.0/${L}.traineddata.gz" || \
  echo "!! не удалось скачать ${L}.traineddata.gz — OCR подтянет его с CDN при первом запуске"
done

echo
read -r -p "Скачать whisper.cpp + модель для распознавания речи? (~100 МБ, [y/N]) " ANSWER || ANSWER=""
if [[ "$ANSWER" == "y" || "$ANSWER" == "Y" || "$ANSWER" == "yes" ]]; then
  echo "==> whisper.cpp WebAssembly (dist v6)"
  curl -fsSL -o "$LIB/whisper.js" \
    "https://raw.githubusercontent.com/ggerganov/whisper.cpp/master/dist/whisper.js"
  curl -fsSL -o "$LIB/whisper.js.map" \
    "https://raw.githubusercontent.com/ggerganov/whisper.cpp/master/dist/whisper.js.map" || true
  echo "==> Модель ggml (base.en q8_0, ~80 МБ; для русского лучше small/school средней величины)"
  read -r -p "Название модели (base.en | small.en | small | base) [base]: " MNAME || MNAME=""
  MNAME=${MNAME:-base}
  case "$MNAME" in
    base)  FILE="ggml-base.en.bin";  URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" ;;
    base.en) FILE="ggml-base.en.bin"; URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" ;;
    small.en) FILE="ggml-small.en.bin"; URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin" ;;
    small) FILE="ggml-small.bin"; URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin" ;;
    *) echo "неизвестная модель"; exit 1 ;;
  esac
  curl -fL --progress-bar -o "$MODELS/$FILE" "$URL"
  echo "модель: models/$FILE (укажите этот путь в настройках расширения)"
fi

echo
echo "Готово. Содержимое extension/lib:"
ls -lh "$LIB"
echo
echo "Установка в Firefox: about:debugging#/runtime/this-firefox → «Загрузить временное дополнение» → extension/manifest.json"
