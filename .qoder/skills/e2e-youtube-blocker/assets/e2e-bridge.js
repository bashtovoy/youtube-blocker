/* Test-only bridge. It runs inside the extension origin because WebDriver cannot
   evaluate in Firefox moz-extension pages. It writes storage, notifies content
   scripts, and publishes the result into the page DOM via tabs.executeScript
   (MV2) or scripting.executeScript (MV3). Never ship this file. */
(function () {
  'use strict';
  const api = (typeof browser !== 'undefined') ? browser : chrome;
  const RESULT_ID = 'yb-e2e-result';

  function decodePayload(s) {
    s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function contentCode(json) {
    return `(function(){var el=document.getElementById(${JSON.stringify(RESULT_ID)});` +
      `if(!el){el=document.createElement('pre');el.id=${JSON.stringify(RESULT_ID)};` +
      `el.style.display='none';(document.body||document.documentElement).appendChild(el);}` +
      `el.textContent=${JSON.stringify(json)};})();`;
  }

  async function publishResult(msg) {
    const targets = await api.tabs.query({ url: ['*://*.youtube.com/*', '*://*.music.youtube.com/*'] });
    const results = [];
    for (const t of targets) {
      try {
        if (api.tabs && api.tabs.executeScript) {
          await api.tabs.executeScript(t.id, { code: contentCode(JSON.stringify(msg)) });
        } else if (api.scripting) {
          await api.scripting.executeScript({
            target: { tabId: t.id },
            func: (id, json) => {
              let el = document.getElementById(id);
              if (!el) {
                el = document.createElement('pre');
                el.id = id;
                el.style.display = 'none';
                (document.body || document.documentElement).appendChild(el);
              }
              el.textContent = json;
            },
            args: [RESULT_ID, JSON.stringify(msg)]
          });
        } else {
          throw new Error('no script injection API');
        }
        results.push('ok');
      } catch (e) {
        results.push(String(e && e.message || e));
      }
    }
    return { tabs: targets.length, results };
  }

  async function notifyTabs() {
    const tabs = await api.tabs.query({ url: ['*://*.youtube.com/*', '*://*.music.youtube.com/*'] });
    const results = await Promise.all(tabs.map(t =>
      api.tabs.sendMessage(t.id, { type: 'config-changed' })
        .then(() => 'ok', e => String(e && e.message || e))
    ));
    return { tabs: tabs.length, results };
  }

  async function report(op, ok, data) {
    const msg = { source: 'yb-e2e', op, ok, data: data === undefined ? null : data, at: Date.now() };
    const published = await publishResult(msg).catch(e => ({ tabs: 0, results: [String(e && e.message || e)] }));
    msg.published = published;
    try {
      history.replaceState(null, '', location.pathname + location.search + '#r=' + encodeURIComponent(JSON.stringify(msg)));
    } catch (e) { /* hash is only a fallback channel */ }
    document.title = 'YB-E2E-' + (ok ? 'OK' : 'ERR') + ' ' + op;
  }

  (async () => {
    const q = new URLSearchParams(location.search);
    const op = q.get('op') || 'ping';
    if (op === 'config') {
      const cfg = decodePayload(q.get('payload'));
      await api.storage.local.set({ settings: cfg.settings || {}, keywords: cfg.keywords || [] });
      const n = await notifyTabs();
      await report(op, true, { tabs: n.tabs, results: n.results });
    } else if (op === 'read') {
      const data = await api.storage.local.get(null);
      await report(op, true, {
        settings: data.settings || null,
        keywords: data.keywords || [],
        dismissedCount: data.dismissedCount || 0,
        hiddenCount: data.hiddenCount || 0,
        blockedCount: data.blockedCount || 0,
        semStatus: data.semStatus || null
      });
    } else if (op === 'reset') {
      await api.storage.local.clear();
      const n = await notifyTabs();
      await report(op, true, { tabs: n.tabs });
    } else if (op === 'ocr') {
      /* Test-only OCR probe: prepare + recognize through the same runtime
         message path the content script uses. The fixture lives in the
         disposable harness extension (e2e-ocr/…) and is passed to the host
         as a data: URL, so the host needs no network and no extra permission. */
      const langs = q.get('langs') || 'eng+rus';
      const hint = q.get('hint') || '';
      const fixture = q.get('fixture');
      const prepare = await api.runtime.sendMessage({ type: 'ybocr', op: 'prepare', langs });
      const status = await api.runtime.sendMessage({ type: 'ybocr', op: 'status' });
      let recognize = null;
      if (fixture) {
        const res = await fetch(api.runtime.getURL(fixture));
        if (!res.ok) throw new Error('Fixture HTTP ' + res.status);
        const buf = new Uint8Array(await res.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        }
        const dataUrl = 'data:' + (res.headers.get('content-type') || 'image/jpeg') +
          ';base64,' + btoa(bin);
        recognize = await api.runtime.sendMessage({
          type: 'ybocr', op: 'recognize', url: dataUrl, langs, hint
        });
      }
      const ok = !!(prepare && prepare.ok) && (!recognize || recognize.ok);
      await report(op, ok, { prepare, status, recognize });
    } else {
      await report(op, true, { version: api.runtime.getManifest().version });
    }
  })().catch(e => report(q.get('op') || 'ping', false, { error: String(e && e.message || e) }));
})();
