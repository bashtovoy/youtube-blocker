# PaddleOCR.js vs Tesseract 1.6.1 — result

## Decision

**GO for an integration spike, eslav-only.** PaddleOCR.js with PP-OCRv5 mobile
`eslav` is clearly better on the resolution the extension actually uses
(480×270): lower character error, much higher keyword recall, cleaner output,
fewer negative-image hallucinations, and faster warm inference. It replaces the
Tesseract asset set with a slightly smaller release package and runs fully
offline when all model and ORT paths are local.

This is not a recommendation to merge without a follow-up: the integration must
keep the existing queue/cache/message API, warm the model proactively, pass the
480 px regression tests, and resolve the model-license check. No files in
`extension/` or `CHANGELOG.md` were changed by this experiment.

## Why 480×270 is the primary result

`extension/content.js` rewrites proxied thumbnail URLs to `w480-h270` and falls
back to `hqdefault` (480×360). The 1280×720 `hq720` files are useful as a
high-resolution stress test, but they are not what the shipped OCR path sees.

The difference matters for the regression card. At 1280 both Tesseract and
Paddle read `THE DYING SR22 KILLER`. At 480:

- `tess-fast` reads `THE IlYI!{[E AI‘IZ KILL` — headline CER **0.524**, target
  keyword recall **0.00**.
- `tess-161` eventually contains `THE IIYIN(ES“HZZ KILLER` among noisy mask
  variants — headline CER **0.286**, keyword recall 1.00, but 173 characters of
  output and 2.0 s.
- `paddle-eslav` reads `THE DYING SR22 KILLER` exactly — headline CER **0.00**,
  keyword recall **1.00**, 28 characters, 0.77 s.

That is the regression the user reported. The 1280 run would have hidden it.

## Method

- **Fixtures:** 54 real thumbnails, 43 with salient text and 11 negative
  controls; 19 are in the held-out test split, 4 are Russian.
- **Resolutions:** 1280×720 originals (`hq720`) and 480×270 downscales that
  mimic the extension’s `w480-h270` path.
- **Arms:** `tess-fast` (one Tesseract pass), `tess-161` (the shipped adaptive
  fast + quick/full deep pipeline), `paddle-eslav` (Latin + Cyrillic), and
  `paddle-en` (English control).
- **Metrics:** best-window CER/WER, exact and near line rates, token-aware
  keyword recall, negative-control false words, wall-clock OCR time.
- **Environment:** macOS, 2-core/4-thread Intel i5-5257U, 8 GB RAM, Node 26,
  Chrome 155. Headless Chrome through CDP with a fresh profile, real time, no
  virtual time. One warm run per image.
- **Offline assertion:** every page and worker request is logged; any request
  outside `127.0.0.1:8765` fails the run.

Tesseract parity was checked against `extension/ocr-host.js` 1.6.1: PSM 11,
300 DPI, the same 16-character/55-confidence/60-word-confidence deep trigger,
`gray,bright` quick modes, `gray,red,bright,gray-inv,dark` full modes, 2× scale
capped at 2600 px, 10 px border, Otsu threshold and coverage filters. The
numbers below are warm OCR-path measurements, not full extension latency.

## Primary results: 480×270

43 text items, 11 negatives.

| Arm | CER | WER | Exact line | Near line | Keyword recall | Mean | p95 | Max | Target headline CER | Target keywords |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `tess-fast-480` | 0.406 | 0.690 | 26% | 34% | 38% | 513 ms | 1284 ms | 2010 ms | 0.524 | 0.00 |
| `tess-161-480` | 0.222 | 0.494 | 41% | 56% | 63% | 2733 ms | 6053 ms | 8515 ms | 0.286 | 1.00 |
| `paddle-eslav-480` | **0.070** | **0.181** | **73%** | **88%** | **91%** | **1408 ms** | **3353 ms** | **6953 ms** | **0.00** | **1.00** |
| `paddle-en-480` | 0.130 | 0.215 | 71% | 80% | 84% | 1508 ms | 3074 ms | 7141 ms | **0.00** | 1.00 |

Compared with the shipped `tess-161` pipeline at the same resolution:

- CER is **68% lower** (0.070 vs 0.222).
- Keyword recall is **+28 points** (91% vs 63%).
- Exact-line rate is **+32 points** (73% vs 41%).
- Mean warm OCR is **1.9× faster** (1.41 s vs 2.73 s); p95 is **1.8× faster**.
- The target headline is exact instead of mangled.

`paddle-en` is only an English control. It cannot read Cyrillic, so it is not a
usable single-model replacement.

### Language and split

| Arm | English CER / KW | Russian CER / KW | Dev CER / KW | Test CER / KW |
|---|---:|---:|---:|---:|
| `tess-fast-480` | 0.398 / 38% | 0.485 / 33% | 0.340 / 44% | 0.489 / 30% |
| `tess-161-480` | 0.209 / 63% | 0.343 / 56% | 0.208 / 62% | 0.240 / 64% |
| `paddle-eslav-480` | 0.075 / 91% | **0.021 / 94%** | 0.078 / 90% | 0.060 / 93% |
| `paddle-en-480` | 0.080 / 90% | 0.624 / 21% | 0.122 / 83% | 0.140 / 85% |

The test split is not worse than dev for Paddle, so the result is not a
manifest-fitting artifact. The Russian fixtures are the clearest qualitative
difference:

- `M4v1uXNmxDI`: Paddle reads the two main Russian lines exactly; Tesseract
  produces mask noise and fragmented words.
- `NnIxjcl6Mnk`: Paddle reads the whole card, including `ВОПРОС-ОТВЕТ`, exactly;
  Tesseract CER is 0.82.
- `Jrhf0JPKkUo`: Paddle reads `МАГИЧЕСКАЯ / СИЛАСЛОВА`; Tesseract mangles the
  second line.
- `UEoClx70oiM`: Paddle reads the aircraft and `ЛЕТНЫЕ ИСПЫТАНИЯ`; Tesseract
  misses most of it.

### Negative controls and output cleanliness

| Arm | Negatives with text | Mean false words | Mean output chars per negative | Positive output / ground-truth chars |
|---|---:|---:|---:|---:|
| `tess-fast-480` | 3 / 11 | 0.36 | 23 | 1.26× |
| `tess-161-480` | 9 / 11 | 3.64 | 212 | 6.87× |
| `paddle-eslav-480` | **3 / 11** | **0.82** | **10** | **1.22×** |
| `paddle-en-480` | 2 / 11 | 0.91 | 11 | 1.26× |

Tesseract’s deep pass is effective at recovering text, but it does so by
stitching five mask variants together. On clean images it invents words: a car
photo, a plane photo and a tennis photo all produce multi-word garbage at 480.
Paddle’s only “false positives” are actual small UI labels on phone tutorials
(`Banking App`, `GPlay`, `Netflix`, `Shizuku`) and a license plate; it does not
hallucinate paragraphs on clean images.

This is the main product benefit beyond raw CER: less OCR noise means fewer
false blocks and a cheaper downstream matching step.

### Per-item behavior

At 480, Paddle has a lower CER than `tess-161` on 30 of 43 text items, a higher
CER on 5, and ties on 8. Keyword recall is equal or better on **all 43**. The
five items where Tesseract’s CER is lower are narrow:

- `UeJ-9OB4_rE`: Tesseract keeps `$489`/`$699`; Paddle drops both prices.
- `_golUNME5hI`: Tesseract’s line order is slightly better; Paddle still finds
  all four words.
- `fqmKQoob67U`: Tesseract is exact; Paddle has one small error.
- `ojPnIZZo1b8`: Tesseract’s chyron is slightly cleaner.
- `weuhF2bxh8g`: Tesseract has fewer errors in the small `$52B AI MEGAPROJECT`
  line.

Even on those items, Paddle’s keyword recall is not worse.

## High-resolution stress: 1280×720

| Arm | CER | WER | Exact line | Near line | Keyword recall | Mean | p95 | Target headline CER |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `tess-fast` | 0.410 | 0.662 | 28% | 35% | 43% | 538 ms | 1754 ms | 0.00 |
| `tess-161` | 0.214 | 0.433 | 47% | 59% | 68% | 7580 ms | 20715 ms | 0.00 |
| `paddle-eslav` | **0.090** | **0.212** | **70%** | **81%** | **88%** | **2212 ms** | **4441 ms** | **0.00** |
| `paddle-en` | 0.142 | 0.224 | 70% | 78% | 82% | 1375 ms | 3306 ms | 0.00 |

At 1280, Tesseract deep is 3.4× slower than Paddle and has 2.4× the CER, but
both read the target headline. This is why the 480 matrix is the decision
point. Paddle’s speed advantage grows with resolution because the deep mask
stack is expensive at 2560×1440.

The 1280 `tess-161` run produced 7.22× the ground-truth character count; Paddle
produced 1.21×. On the target card, Tesseract deep emitted 2,012 characters
(including four noisy copies of the headline), while Paddle emitted 41.

## Cold start and timing

Warm times above exclude initialization. Observed cold-start behavior:

| Path | Init | First usable result (init + warm-up + first image) |
|---|---:|---:|
| Tesseract fast, 480 | 5.5 s | ~7 s |
| Tesseract 1.6.1 deep, 480 | 5.2 s | ~15 s |
| Paddle eslav, 480 | 10.2 s | ~14.5 s |
| Tesseract 1.6.1 deep, 1280 | 9.7–16.7 s | ~25–35 s |
| Paddle eslav, 1280 | 14.1–15.6 s | ~21 s |

Paddle’s cold start is slower than a one-pass Tesseract run but comparable to
the shipped deep pipeline it would replace. A proactive warm-up in the
offscreen document (the existing `prepare()` pattern) removes this from the
user-visible first scan. Memory is higher than Tesseract (observed JS heap
60–67 MB vs 30–35 MB after runs), but acceptable on the 8 GB target machine.

Timing is indicative: one old 2-core laptop, one run per image, and visible
system-load variance (the same Tesseract init ranged from 4.2 s to 16.7 s
across runs). The quality gap and the warm-speed ranking are consistent across
both resolutions.

## Package size

Compressed sizes as they would land in the extension ZIP:

| Asset set | Compressed |
|---|---:|
| Current Tesseract: eng + rus + core + JS | 21.3 MB |
| Paddle eslav: bundle + det + eslav | **15.4 MB** |
| Paddle en + eslav: add the en recognizer | 22.7 MB |

The Paddle bundle is 3.59 MB gzip, det 4.53 MB, eslav 7.31 MB. The SDK reuses
the existing ORT 1.22.0 JSEP WASM already shipped for embeddings, so there is
no second 21 MB ORT copy. Replacing Tesseract with eslav-only should shrink the
ZIP by roughly 6 MB. Shipping both recognizers is roughly size-neutral (+1.3 MB
vs Tesseract), but adds routing complexity.

Do **not** ship both Tesseract and Paddle in the release: that would grow the
ZIP by roughly 15 MB. A temporary feature-flagged development build is fine.

## Offline safety

All eight runs passed the request assertion: zero external requests, 65–69
local requests per run, all from `127.0.0.1:8765`. The Paddle bundle loaded the
local `ort-wasm-simd-threaded.jsep.wasm` from `bench/ort/` (a copy of the
extension’s existing ORT 1.22.0 file), and both model tarballs were local.

Two integration requirements are non-negotiable:

1. Set `ortOptions.wasmPaths` to the local extension `lib/` directory. The SDK
   can otherwise fall back to a CDN ORT build in worker mode.
2. Pass `textDetectionModelAsset` and `textRecognitionModelAsset` with local
   URLs. The SDK’s default model URLs point at `paddle-model-ecology.bj.bcebos.com`.

With those set, the runtime is fully local. The SDK is Apache-2.0; the PP-OCRv5
ONNX model weights are published by PaddlePaddle — confirm the exact model-card
license before release.

## Known Paddle failures

These are real and should go into the integration test set:

- `WK_j69hLR08`: `JORDAN` is missed entirely (stylized, low-contrast black
  text). Tesseract deep also gets only fragments, but it does better here.
- `VvJai6HGfyE`: the NVIDIA logo is read as `DVIDIA`/`DIVIDIA`.
- `UeJ-9OB4_rE`: `$489` and `$699` are dropped at 480.
- `Et6kkYkN5ns`: `TU-160M2` becomes `TU-16OM2` (letter O vs zero).
- `weuhF2bxh8g`: `MEGAPROJECT` becomes `MEGAPROJEG7`.
- `jLZTTJWp1hs`: `3-DOOR` becomes `3-D00R` (zeros).
- `jDu9Cjfj9iw`: `VW CAN-FD` is read as one token `VWCAN-FD`; semantically
  present, but the strict token matcher misses `vw`/`can-fd`.
- Eslav occasionally renders stylized Latin with Cyrillic homoglyphs
  (`роrsсhё` for `PORSCHE`). The `en` model gets it right; an optional
  en+eslav routing configuration would fix this at +7.2 MB.
- Small text is lost at 480: `PIPISTREL`, `EXPERIMENTAL`, the price cards.
  The critical headline is unaffected.

For the blocker’s purpose these are acceptable trade-offs: the failures are
mostly small text, logos or stylized brand words, while the content words that
drive topic blocking survive far more often than with Tesseract.

## Recommendation and next steps

Proceed with an integration spike on the experiment branch, not a direct swap:

1. Add the SDK bundle, det tar and eslav tar to `extension/lib/`; reuse the
   existing ORT 1.22.0 JSEP assets. Do not add the en model initially.
2. Replace the Tesseract worker path in `ocr-host.js` with a PaddleOCR instance
   in the offscreen document. Keep the existing queue, cache, `prepare()` and
   message API; return recognition lines joined by `\n`.
3. Set local `wasmPaths` and local model asset URLs explicitly. Add a test that
   fails if any non-extension URL is requested.
4. Warm the model on install/startup/popup, not on the first visible thumbnail.
5. Port the regression fixtures to the extension test suite at 480×270:
   `OhVjcySNqqc` headline, the four Russian cards, and several negative
   controls. Assert headline text, Russian keywords, and empty/near-empty
   output on clean images.
6. Measure real extension latency and memory with the YouTube DOM, then remove
   the Tesseract assets from the release ZIP. Keep a feature flag only for the
   rollout window.
7. Add the en recognizer later only if stylized English brand text proves
   important; it is +7.2 MB and adds a routing decision.

The experiment files and reproduction steps are in
[`README.md`](../README.md). Raw runs, fixtures and models are git-ignored;
`results/summary.json` and `results/scored.json` contain the scored data.
