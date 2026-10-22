---
name: e2e-youtube-blocker
description: End-to-end testing for the YouTube Blocker extension in Firefox (MV2) and Chrome (MV3) through firefox-devtools/chrome-devtools MCP. Use when verifying filtering, title/keyword hiding, settings persistence, counters/badge, enable/disable behavior, SPA regressions, or after changing content scripts, popup, or background logic; covers preflight, a disposable test harness with a bridge page, install, DOM assertions, console/network checks, and evidence capture.
---

# E2E YouTube Blocker

## Scope and hard rules

- Test the real extension code in a real browser. Unit tests are a gate, not a substitute.
- Firefox and Chrome paths are validated. Chrome requires a Chrome DevTools MCP server started with extension tools (`--categoryExtensions`) and restarted Qoder so the tools appear in the session; if `install_extension` is absent, stop and report **BLOCKED**, never a silent pass.
- Never edit `extension/manifest.json`, popup files, or production code for testing. The harness copies the tree to a temp directory, adds a test-only bridge page, and uses a separate extension id.
- Use one browser profile per run. A second copy of the extension in the same profile causes duplicate content scripts and false results.
- A scenario passes only with an observed DOM/storage result and a fresh screenshot. Missing tools, empty YouTube results, or a missing badge fixture are **NOT TESTED**, not pass.

## Test matrix

| Priority | Scenario | Gate |
|---|---|---|
| P0 | Extension installs; content script reaches YouTube; a title keyword hides matching cards | must pass |
| P0 | Settings/keywords persist in `storage.local`; disable stops new hides after reload | must pass |
| P0 | No uncaught `[YB]`/extension errors during the run | must pass |
| P1 | `hiddenCount` increments; re-enable after disable works; SPA navigation keeps filtering | should pass |
| P1 | Chrome popup shows version/counter (if extension tools allow opening it) | should pass |
| P2 | Members-only/AI badge filtering on a page containing such badges | best effort, record "not exercised" if no fixture |
| P2 | SigLIP semantic matching and thumbnail OCR smoke test | optional, requires model assets |

## 0. Preflight

From the project root:

```bash
node .qoder/skills/e2e-youtube-blocker/scripts/e2e-preflight.mjs --browser all
```

- Resolve every `FAIL` before continuing.
- `WARN` for missing model/OCR assets is acceptable only when P2 is skipped.
- For P2 add `--require-models` and stop on missing assets.
- `--json` returns machine-readable results.

Create one evidence directory for the run:

```bash
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/yb-e2e-XXXXXX")"
```

Keep screenshots, config JSON, and `harness.json` under `$RUN_DIR`.

## 1. Firefox (MV2, validated path)

### 1.1 Build the disposable harness

```bash
node .qoder/skills/e2e-youtube-blocker/scripts/e2e-harness.mjs prepare \
  --browser firefox --run-dir "$RUN_DIR"
```

The JSON output contains `extDir`, `extensionId` (`youtube-blocker-e2e@local.dev`), and `runDir`.
The temp copy adds only `web_accessible_resources` and the bridge page; all extension logic is byte-identical.
`--lean` skips `models/` and most of `lib/` for P0/P1 and installs much faster.

### 1.2 Install and resolve the UUID

Use `mcp__firefox_devtools__install_extension`:

```json
{ "type": "path", "path": "<extDir>", "permanent": false }
```

Then read the profile from `mcp__firefox_devtools__get_firefox_info` (field `Profile`) and run:

```bash
node .qoder/skills/e2e-youtube-blocker/scripts/e2e-harness.mjs url \
  --browser firefox --profile "<profile>" --id youtube-blocker-e2e@local.dev
```

Output includes `baseUrl` (`moz-extension://<uuid>/`). Re-run this after every reinstall: Firefox assigns a new UUID.
Never navigate the MCP directly to `about:` or `moz-extension:` URLs; WebDriver BiDi rejects them.

### 1.3 Open YouTube and wait for cards

```
mcp__firefox_devtools__navigate_page
{ "url": "https://www.youtube.com/results?search_query=lofi", "wait": "interactive" }
```

A timeout can happen on YouTube SPA navigation. Verify with `evaluate_script` before retrying:

```js
() => ({ url: location.href, ready: document.readyState,
  items: document.querySelectorAll('ytd-video-renderer,ytd-grid-video-renderer,ytd-rich-item-renderer,ytd-compact-video-renderer').length })
```

Poll up to 20 × 1 s until `items > 0`; YouTube hydration can take ~10 s even when `document.readyState` is `complete`. If the page shows consent/login, handle it or stop as **BLOCKED**.

Choose a keyword that actually occurs in the visible titles (case-insensitive token, length >= 4).
Example probe:

```js
() => {
  const items = [...document.querySelectorAll('ytd-video-renderer,ytd-grid-video-renderer,ytd-rich-item-renderer,ytd-compact-video-renderer')];
  const counts = {};
  for (const el of items) {
    for (const w of (el.innerText || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []) counts[w] = (counts[w] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
}
```

### 1.4 Apply a deterministic config

Write `$RUN_DIR/e2e-config.json`:

```json
{
  "settings": {
    "enabled": true,
    "mode": "hide",
    "fuzzy": false,
    "checkTitle": true,
    "checkThumbOcr": false,
    "checkSemanticImage": false,
    "checkSpeech": false,
    "hideMembersOnly": false,
    "hideAiGenerated": false,
    "actionDelayMs": 0,
    "logMatch": true
  },
  "keywords": [{ "text": "<keyword>", "enabled": true }]
}
```

Generate the bridge URL:

```bash
node .qoder/skills/e2e-youtube-blocker/scripts/e2e-harness.mjs bridge \
  --base "<baseUrl>" --op config --file "$RUN_DIR/e2e-config.json"
```

Open the bridge from the YouTube page (extension pages cannot be evaluated by Firefox WebDriver, but they can be opened by page script because the harness exposes it):

```js
() => {
  const url = '<bridge config URL>';
  document.getElementById('e2e-open')?.remove();
  const b = document.createElement('button');
  b.id = 'e2e-open';
  b.textContent = 'E2E bridge';
  b.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;width:140px;height:40px';
  b.onclick = () => window.open(url, '_blank');
  document.body.appendChild(b);
  return true;
}
```

`take_snapshot`, then `click_by_uid` on the button. The bridge:
- writes `settings`/`keywords` to `storage.local`,
- sends `config-changed` to every YouTube tab,
- injects `<pre id="yb-e2e-result">` into those tabs with `{source, op, ok, data, published}`.

This is the only result channel; do not try to read the bridge page itself.

### 1.5 P0 assertions

Poll the YouTube tab with `evaluate_script` until the result appears:

```js
() => {
  const SEL = ['ytd-video-renderer','ytd-grid-video-renderer','ytd-rich-item-renderer','ytd-compact-video-renderer','ytd-playlist-panel-video-renderer','ytd-reel-item-renderer','ytm-shorts-lockup-view-model-v2','ytm-shorts-lockup-view-model'].join(',');
  const items = [...document.querySelectorAll(SEL)];
  const hidden = items.filter(el => el.classList.contains('yb-hidden'));
  let result = null;
  try { const raw = document.getElementById('yb-e2e-result')?.textContent; result = raw ? JSON.parse(raw) : null; } catch (e) { result = String(e); }
  return {
    url: location.href,
    total: items.length,
    hidden: hidden.length,
    hideStyle: !!document.getElementById('yb-hide-style'),
    result,
    hiddenTitles: hidden.slice(0, 5).map(el => (el.innerText || '').replace(/\s+/g, ' ').slice(0, 80))
  };
}
```

Pass criteria:
- `result.op === "config"` and `result.ok === true`;
- `result.data.results` contains `"ok"` (if it reports "Could not establish connection", reload YouTube once and re-apply);
- `total > 0`, `hideStyle === true`, `hidden > 0`;
- every `hiddenTitles` entry contains the keyword (title-only config, `hideMode`);
- no unexpected extension errors.

If `hidden === 0` but `result.ok` is true, the keyword did not match. Re-probe titles and repeat with a different token.

### 1.6 Persistence and counters

Generate a read URL:

```bash
node .qoder/skills/e2e-youtube-blocker/scripts/e2e-harness.mjs bridge --base "<baseUrl>" --op read
```

Open it with the same button flow, then read `#yb-e2e-result`.
Assert:
- `data.settings` matches the config (at least `enabled`, `mode`, `checkTitle`, `fuzzy`);
- `data.keywords` contains `{text:"<keyword>", enabled:true}`;
- `data.hiddenCount >= hidden` from the DOM assertion (the counter can be higher after SPA re-renders).

The badge is `dismissedCount + hiddenCount` in `background.js`. Firefox does not expose the toolbar badge to WebDriver, so the storage path is the P0 signal; record the UI badge as "not directly observable in Firefox".

### 1.7 Disable / re-enable

1. Write `$RUN_DIR/e2e-config-disabled.json` with the same keyword but `"enabled": false`.
2. Apply it through the bridge (`op=config`).
3. Reload the YouTube URL with `navigate_page` and wait for cards.
4. Assert `hidden === 0` and `hideStyle === false` (fresh document; no persistent hide class).
5. Re-apply the enabled config, reload, and assert `hidden > 0` again.

### 1.8 Console, network, evidence

```
mcp__firefox_devtools__list_console_messages { "level": "error", "limit": 50 }
```
Fail on errors from `moz-extension://`, `[YB]`, or unhandled exceptions. YouTube's own network noise is not an extension failure.
With semantic/OCR/speech disabled, `list_network_requests` must not show requests to model hosts (Hugging Face, jsDelivr model files).

Capture:
```
mcp__firefox_devtools__screenshot_page { "saveTo": true }
```

The Firefox MCP refuses paths outside `~/.firefox-devtools-mcp/output`; copy the path it returns into the run dir:

```bash
cp "<reported path>" "$RUN_DIR/firefox.png"
```

### 1.9 Cleanup

1. `mcp__firefox_devtools__uninstall_extension { "id": "youtube-blocker-e2e@local.dev" }`
2. `node .qoder/skills/e2e-youtube-blocker/scripts/e2e-harness.mjs cleanup --dir "$RUN_DIR"`

## 2. Chrome (MV3)

### 2.1 Prerequisites

- Build if stale: `node build-chrome.js` (preflight reports freshness).
- Chrome DevTools MCP must expose `install_extension`/`list_extensions`/`uninstall_extension`. This requires `--categoryExtensions` server startup. If the tool is missing, report **BLOCKED** and stop.
- Preflight: `node .qoder/skills/e2e-youtube-blocker/scripts/e2e-preflight.mjs --browser chrome`.

### 2.2 Harness, install, URL

```bash
node .qoder/skills/e2e-youtube-blocker/scripts/e2e-harness.mjs prepare \
  --browser chrome --run-dir "$RUN_DIR"
```

Install `<runDir>/chrome-ext` with the Chrome MCP `install_extension` (unpacked path). Get the extension id from `list_extensions` (or the install result), then:

```bash
node .qoder/skills/e2e-youtube-blocker/scripts/e2e-harness.mjs url --browser chrome --id "<extension-id>"
```

Chrome MCP `navigate_page`/`evaluate_script` require the `pageId` from `list_pages`. Chrome allows direct navigation to `chrome-extension://.../e2e-bridge.html?...` via `new_page`, and extension pages are evaluable, so read the bridge result from `location.hash` (`#r=<urlencoded JSON>`) or the page title (`YB-E2E-OK <op>`); the bridge also publishes `#yb-e2e-result` into YouTube tabs. If direct navigation is blocked, use the YouTube button + `window.open` flow as in Firefox.

### 2.3 Assertions and popup

Use the same config/read/assert snippets as Firefox. In addition:

- Open `popupUrl` (direct navigation or `trigger_extension_action`) and read `#ver`, `#blocked`, `#enabled`, `#mode`, keyword rows. Assert the version matches `manifest.json` and `#blocked` shows `dismissedCount + hiddenCount` for the current page. Counters reset on every YouTube navigation (`background.js`), so expect the current-page count, not a cumulative total.
- Check the service worker for errors if the MCP exposes it; otherwise record "not directly observable".
- Capture `<runDir>/chrome.png`.
- Optional P2: enable semantic/OCR, wait for `semStatus.state` to leave `off`, assert no fatal error and at least one hide/score. Requires `--require-models` assets.

Cleanup: Chrome MCP `uninstall_extension` with the extension id, then `e2e-harness.mjs cleanup --dir "$RUN_DIR"`.

## 3. P1/P2 details

**Badge/counters (P1).** `read` returns `hiddenCount` and `dismissedCount`; both feed `updateBadge()`. In hide mode the extension increments `hiddenCount`. In dismiss mode a verified YouTube "Not interested" increments `dismissedCount`; this depends on YouTube's live UI and is best-effort.

**Members-only / AI badge (P2).** Badges are detected in `content.js` via `badge-shape`, `yt-badge-view-model`, `yt-thumbnail-badge-view-model`, `ytd-badge-supported-renderer`, and text matchers in `matcher.js`. They only exist when the feed contains such cards. If none are present, record "not exercised" and do not claim a pass.

**Semantic/OCR/speech (P2).** Requires `extension/models/siglip-base-patch16-224/onnx/*.onnx` plus tokenizer files and the OCR/whisper assets. Enable `checkSemanticImage`/`checkThumbOcr` only with `--require-models`; first load can take tens of seconds. Assert `semStatus.state` is not `failed` and no `[YB]` errors appear. Accuracy is not asserted here; use the dedicated calibration tests for thresholds.

## 4. Report format

```
E2E YouTube Blocker — YYYY-MM-DD HH:MM
Extension: <version>; Firefox <version>; Chrome <version or not run>
Profile: <MCP profile>; Config: <keyword, mode, flags>

P0 Firefox: PASS/FAIL/BLOCKED
  cards=<n> hidden=<n> hideStyle=<bool> hiddenCount=<n> errors=<n>
P1: ...
P2: ... (or not exercised)
Chrome: PASS/FAIL/BLOCKED/NOT RUN
Evidence: <runDir>/firefox.png, <runDir>/chrome.png, <runDir>/harness.json
Notes: exact blocker or mismatch
```

Never report a browser/scenario as passed when it was not executed. Include counts, not just "works".

## 5. Troubleshooting

- **UUID not found after install:** wait 1–2 s and re-run `url`; the profile may contain a nested `firefox_devtools_mcp_profile/prefs.js`. Never guess a UUID.
- **`navigate_page` timeout on YouTube:** check `location.href` and card count; retry once. SPA navigation frequently reports timeout after the page is usable.
- **`#yb-e2e-result` missing:** the bridge tab probably did not open (popup blocker) or the content script is absent. Check `list_pages` for `e2e-bridge.html`; reload YouTube and re-apply config.
- **`data.results` says "Could not establish connection":** content script not injected yet; reload the tab, wait for cards, re-apply.
- **`hideStyle` true but hidden 0:** keyword mismatch. Use a token from the actual titles and `fuzzy:false`.
- **Duplicate hiding / unexpected pre-existing `#yb-hide-style`:** another copy of the extension is active in the same profile. Use the dedicated MCP profile or uninstall the other copy; do not uninstall the user's production extension without asking.
- **Firefox extension page evaluation fails:** expected. Use the bridge and the injected `#yb-e2e-result`, never `evaluate_script` on `moz-extension://`.
- **Chrome extension tools missing:** the MCP server was started without `--categoryExtensions`. Report the blocker; do not substitute manual Chrome automation for a claimed extension test.
- **Model/OCR missing:** run `./setup.sh`; otherwise skip P2 and state that it was skipped.

## Resources

- `scripts/e2e-preflight.mjs` — static gates, asset checks, Chrome freshness.
- `scripts/e2e-harness.mjs` — `prepare`, `url`, `bridge`, `cleanup` for disposable harnesses.
- `assets/e2e-bridge.html`, `assets/e2e-bridge.js` — test-only storage/config/result bridge copied into the temp extension.
