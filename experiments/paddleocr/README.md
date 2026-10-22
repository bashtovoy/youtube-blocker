# PaddleOCR.js experiment

Isolated benchmark of the shipped Tesseract 1.6.1 pipeline against
[`@paddleocr/paddleocr-js`](https://github.com/PaddlePaddle/PaddleOCR/tree/main/paddleocr-js)
on real YouTube thumbnails.  Nothing in `extension/` is modified by this
experiment.

## What is in this directory

| Path | Purpose |
| --- | --- |
| `manifest.json` | Ground truth for 54 thumbnails: 43 text images and 11 negative controls, with a dev/test split. |
| `sources.json` | Provenance of the 53 screenshot-derived video IDs. |
| `prepare-fixtures.py` | Crops/dedupes the screenshots used to discover the IDs. |
| `fixtures/` | Local 1280×720 JPEGs (git-ignored). |
| `fixtures-480/` | 480×270 versions that mimic the extension's thumbnail URL (git-ignored). |
| `models/` | Local PP-OCRv5 ONNX tar assets (git-ignored). |
| `bench/` | Browser harness, Chrome CDP runner, scorer, SDK bundle, local server. |
| `results/` | `summary.json`, `scored.json` and git-ignored raw runs. |

## Ground truth

`manifest.json` records the visually dominant text, not every timer, badge or
UI label.  Lines are split the way they are normally read; the scorer finds
the best matching token window, so a different line break does not count as a
recognition failure.  Items with no salient text are `negative: true`.

The two important fixtures are:

- `OhVjcySNqqc` — the regression card: `THE DYING SR22 KILLER`.
- `M4v1uXNmxDI`, `Jrhf0JPKkUo`, `NnIxjcl6Mnk`, `UEoClx70oiM` — Russian.

## Reproduce

Prerequisites: macOS, Node 26+, Chrome, and the repository's local Tesseract
assets in `extension/lib/`.  The experiment does not use the network at
runtime; all assets are served from `127.0.0.1:8765`.

```bash
cd experiments/paddleocr
npm ci
npm run build                 # writes bench/paddle.bundle.js
mkdir -p bench/ort
cp ../../extension/lib/ort-wasm-simd-threaded.jsep.* bench/ort/
node bench/server.js          # terminal 1, serves the repository root

# terminal 2
node bench/run-bench.js --arm tess-fast
node bench/run-bench.js --arm tess-161
node bench/run-bench.js --arm paddle-eslav
node bench/run-bench.js --arm paddle-en

# extension-like 480×270 inputs; create them from the 1280 fixtures first
node bench/run-bench.js --arm tess-161 --variant 480
node bench/run-bench.js --arm paddle-eslav --variant 480

node bench/evaluate.js tess-fast tess-161 paddle-eslav paddle-en \
  tess-fast-480 tess-161-480 paddle-eslav-480 paddle-en-480
```

`run-bench.js` launches a fresh Chrome with `--remote-debugging-pipe`, logs
every page/worker request, and fails the `offline` flag if anything outside
`127.0.0.1:8765` is requested.  Raw runs are written incrementally to
`results/raw/`; use `--resume` to continue a run.  `--ids` and `--limit` are
useful for smoke tests.

### Fixtures

The 1280×720 files were downloaded as `hq720` from `i.ytimg.com` by video ID.
The 480×270 files can be regenerated with `sips -Z 480` from the manifest IDs:

```bash
python3 - <<'PY'
import json, pathlib, subprocess
for item in json.load(open('manifest.json'))['items']:
    src = pathlib.Path('fixtures') / (item['id'] + '.jpg')
    dst = pathlib.Path('fixtures-480') / (item['id'] + '.jpg')
    subprocess.run(['sips', '-Z', '480', str(src), '--out', str(dst)], check=True)
PY
```

The extension's `bestThumbUrl()` targets `w480-h270` for proxied thumbnails;
`fixtures-480` is therefore the representative resolution.  The 1280 run is a
high-resolution stress test and is reported separately.

## Model assets

- SDK: `@paddleocr/paddleocr-js@0.4.2`, Apache-2.0.
- Runtime: `onnxruntime-web@1.22.0`, the same version already shipped in
  `extension/lib/`.  The SDK bundle does not add a second ORT WASM copy when
  `ortOptions.wasmPaths` points at the existing local assets.
- Detector: PP-OCRv5 mobile det.
- Recognizers: PP-OCRv5 mobile `eslav` (Latin + Cyrillic) and `en` (English
  control).  PP-OCRv6 was not used because it has no Cyrillic recognizer.

The model tarballs are the official PaddleOCR ONNX inference assets.  Check
the local files before relying on them:

```text
bc4bbc70887eaa1d08c19f5d2704a4b24f63dfe19e0f8f5282ee714e98992f63  ppocrv5_mobile_det.tar
73266251c28b575af35f7754f486f7a2da6cd4e9a2f311669f58accf27250d23  eslav_ppocrv5_mobile_rec.tar
60ade7018b96e80c940cadcdf3cc693f71329007f257846acc29a10d45c7cb3c  en_ppocrv5_mobile_rec.tar
```

## Tesseract parity

`bench/bench.js` mirrors `extension/ocr-host.js` 1.6.1: PSM 11, 300 DPI,
16-character/55-confidence/word-confidence deep trigger, quick modes
`gray,bright`, full modes `gray,red,bright,gray-inv,dark`, 2× scale capped at
2600 px, 10 px border, Otsu threshold and the same coverage filters.  The
benchmark measures the warm OCR path after worker/model initialization; it
does not include the extension's cache or message queue.

## Limitations

- One machine (2-core/4-thread Intel i5-5257U, 8 GB) and one run per image.
  Timing is indicative, not a controlled microbenchmark.
- The manifest is hand-transcribed from 54 real thumbnails.  Tiny UI chrome is
  intentionally excluded; see [`results/RESULTS.md`](results/RESULTS.md) for the
  items that are sensitive to that choice.
- The 480 fixtures are downscaled from the 1280 originals, not fetched at
  480 directly.  This approximates the extension's `w480-h270` path.
- No production integration is attempted here.  See
  [`results/RESULTS.md`](results/RESULTS.md) for the decision and the remaining
  integration work.
