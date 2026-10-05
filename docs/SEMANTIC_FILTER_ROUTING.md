# Semantic Filter Routing — implementation task

## Scope

Implement the semantic filtering layer for the real Youtube Blocker product scope.

The product is NOT a universal image classifier. The user provides a concrete blacklist of unwanted concepts. Each keyword must use the most appropriate detection channel:

- title/channel text
- thumbnail OCR
- thumbnail semantic image matching
- a controlled combination of the above

Topics that are not meaningfully detectable from an image must NOT be forced through the image model.

Reference user list used for validation:

- Дрон
- Робот
- Трамп
- Drone
- Robot
- Dron
- Putin
- Trump
- drontech
- cybercab
- elon musk
- leak
- news
- leaked
- Navy
- Brad Pit
- UAV

Current production baseline is commit `de571f6`.

## Research conclusions already validated

1. Official Hugging Face `google/siglip-base-patch16-224` and the local ONNX model agree closely on the same inputs.
2. Padding is not the root cause.
3. The SigLIP sigmoid score with the current `logit_bias` is not a useful absolute threshold for this YouTube-thumbnail domain.
4. Raw cosine is useful, and contrastive margin is substantially better in the existing 431-thumbnail experiment.
5. Hard category gating (e.g. ENGINEERED first, then concept) was counterproductive.
6. The current production `semantic.js` still uses `bestTextMatch(scores, 0.15)`; this must not remain the semantic decision rule.
7. The existing content pipeline is valuable and must be preserved:
   title -> semantic thumbnail/OCR -> optional speech -> dismiss/hide.
8. The semantic layer should be candidate-only and cached, following the general architecture seen in open-source projects such as xrai/rai:
   cheap deterministic checks first, expensive visual inference only for remaining cards, cache results, fail open.
9. Do NOT copy code from ytff. Its repository does not expose a license in the inspected tree. Use it only as an architectural reference for batching/caching/regression methodology.
10. xrai/rai is MIT licensed; its candidate-only image gate, golden-set evaluation and latency/fail-open approach are valid architectural references. Do not copy unrelated X-specific code.

## Required implementation

### 1. Add keyword routing metadata

Extend the local keyword representation so that each keyword may carry an optional detector route:

- `title`
- `ocr`
- `image`
- `hybrid`

Backward compatibility is mandatory: existing imported JSON containing only `{text, enabled}` must continue to work.

Do NOT hard-code the user's 17 keywords into production.

If no route is specified, preserve current backward-compatible behavior until the routing migration is complete.

### 2. Keep title matching first

Title/channel matching remains the cheapest and earliest check.

Do not run the SigLIP image model when the card has already matched through the configured title/channel route.

### 3. Implement semantic image scoring as a ranking/contrastive mechanism

Do NOT use:

`sigmoid(logit) >= 0.15`

as the semantic decision.

Expose enough raw information from the semantic worker to calculate:

- raw cosine / normalized text-image similarity
- target concept score
- competing/reference concept score
- contrastive margin

The contrastive decision should be concept-specific:

`margin = target_score - best_reference_score`

Do not assume one global universal threshold before calibration.

The implementation must preserve the existing local SigLIP model and WASM path.

### 4. User keyword set must remain the semantic target set

The model must score the concepts the user actually entered, not a fixed taxonomy.

For image-capable concepts, the worker may normalize prompts internally, but the UI/config must preserve the original user text.

### 5. Avoid universal visual classification

Do NOT introduce:

- ENGINEERED/PERSON/NATURE/OTHER as a mandatory production gate
- a fixed object ontology
- generic image classification unrelated to the user's blacklist

The semantic layer answers:

"How strongly does this card visually correspond to this user's unwanted concept relative to the configured competing concepts?"

### 6. Routing guidance

Initial routing hypotheses for research/validation:

IMAGE / HYBRID:
- Дрон / Drone / Dron
- Робот / Robot
- cybercab

IMAGE optional, but primarily TITLE/OCR:
- Trump / Трамп
- Putin
- Elon Musk
- Brad Pit
- Navy
- UAV

TITLE/OCR primary, no required image detector:
- news
- leak
- leaked
- drontech

These are hypotheses, not permanent hard-coded policy. The implementation must allow per-keyword route selection.

### 7. OCR is a separate detector

Keep OCR independent from semantic image scoring.

A keyword routed to title/OCR must not require SigLIP.

When `checkThumbOcr=false`, OCR must remain disabled globally exactly as today.

### 8. Candidate-only expensive inference

Follow the xrai-style discipline:

- deterministic title/channel match first
- only eligible cards proceed to expensive semantic image work
- deduplicate/in-flight guard
- cache scores by image URL + keyword-set version
- fail open on model/worker/runtime errors
- never block the feed because the semantic worker is unavailable

Do not add a remote AI service.

### 9. Batch text preparation

Prepare/calculate the user concept embeddings once per keyword-set revision, not once per card.

Do not repeatedly tokenize identical concepts for every thumbnail.

### 10. Diagnostics

Add optional debug output under the existing `logMatch` / `[YB]` mechanism.

For a semantic match, log enough to reproduce the decision:

- keyword
- target cosine
- reference/best competitor cosine
- margin
- threshold/profile identifier
- source = semantic-image

Do NOT log thumbnail binary data.

### 11. Evaluation harness

Create a new research/evaluation area under `gui-test-assets/padexp/`.

Do not commit downloaded model binaries or raw copyrighted thumbnails.

Add scripts that can consume an externally prepared CSV manifest and output:

- per-keyword precision
- recall
- F1
- false-positive rate
- target cosine distribution
- contrastive margin distribution
- calibration vs holdout
- latency p50/p95 for semantic-image stage

Use a deterministic 70/30 calibration/holdout split.

The current 431-thumbnail experiment may be used as a historical reference, but do not silently reuse its labels as new production truth.

### 12. Acceptance criteria before merge

Production implementation is acceptable only when:

1. Existing title filtering tests remain green.
2. Existing OCR tests remain green.
3. Existing semantic init/runtime tests remain green.
4. No production code uses sigmoid 0.15 as the semantic acceptance rule.
5. A per-keyword route can be configured without code changes.
6. A semantic image failure never prevents title/OCR filtering or normal feed operation.
7. Semantic work is cached and does not rerun for the same card unnecessarily.
8. A holdout evaluation demonstrates that contrastive scoring is more useful than the old absolute sigmoid decision on the intended user-filter dataset.
9. The exact production threshold/profile is recorded from calibration data rather than chosen from theory alone.
10. The user-facing default remains conservative: false positives are preferred to aggressive over-filtering.

## Do not do in this task

- Do not create a Chrome-only fork.
- Do not migrate Firefox MV2 to MV3.
- Do not replace SigLIP with a larger model.
- Do not add remote AI/cloud classification.
- Do not add speech analysis.
- Do not enable OCR by default.
- Do not add a universal image taxonomy.
- Do not change the user's keyword list automatically.
- Do not delete the old dHash/pHash code unless a separate cleanup task is created.
- Do not merge based on calibration-set metrics only.

## Deliverables

1. Implementation on branch `feature/semantic-filter-routing`.
2. Tests for routing, contrastive scoring and caching.
3. Evaluation script(s) and a text report.
4. Clear migration notes for existing settings/imported JSON.
5. No model binaries or raw copyrighted image corpus committed.

## Reference implementation ideas

Use these only as architecture references:

- `sidntrivedi/ytff`: batching, result caching, deterministic evaluation discipline. Do not copy code because licensing was not established in the inspected repository.
- `phuaky/xrai`: candidate-only local vision gate, golden-set regression, latency evaluation, fail-open behavior. Repository is MIT licensed.

The implementation must remain native to Youtube Blocker and preserve its current Firefox/local-first architecture.
