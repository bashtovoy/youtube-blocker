#!/usr/bin/env bash
# setup.sh — lädt die Bibliotheken für die Erweiterung Youtube Blocker
# (OCR: tesseract.js; optional: whisper.cpp für die Spracherkennung)
set -euo pipefail
cd "$(dirname "$0")"

LIB="extension/lib"
MODELS="extension/models"
mkdir -p "$LIB" "$MODELS"

echo "==> Tesseract.js (OCR der Vorschaubilder) — v4.1.1"
curl -fsSL -o "$LIB/tesseract.min.js" \
  "https://cdn.jsdelivr.net/npm/tesseract.js@4.1.1/dist/tesseract.min.js"
# WASM-Kern (SIMD) — wird automatisch aus lib/ übernommen
curl -fsSL -o "$LIB/tesseract-core-simd.wasm.js" \
  "https://cdn.jsdelivr.net/npm/tesseract-core-simd-wasm@1.0.2/tesseract-core-simd.wasm.js" || \
curl -fsSL -o "$LIB/tesseract-core-simd.wasm.js" \
  "https://cdn.jsdelivr.net/gh/naptha/tesseract.js-core@v5.1.1/tesseract-core-simd.wasm.js"
curl -fsSL -o "$LIB/tesseract-core-simd.wasm" \
  "https://cdn.jsdelivr.net/gh/naptha/tesseract.js-core@v5.1.1/tesseract-core-simd.wasm" || true
# Sprachdaten (um während der Nutzung nicht vom CDN abhängig zu sein)
for L in eng rus; do
  curl -fsSL -o "$LIB/${L}.traineddata.gz" \
    "https://tessdata.projectnaptha.com/4.0.0/${L}.traineddata.gz" || \
  echo "!! ${L}.traineddata.gz konnte nicht geladen werden — OCR lädt es beim ersten Start vom CDN"
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
echo "Fertig. Inhalt von extension/lib:"
ls -lh "$LIB"
echo
echo "Installation in Firefox: about:debugging#/runtime/this-firefox → „Temporäres Add-on laden“ → extension/manifest.json"
