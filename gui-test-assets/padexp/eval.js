/* eval.js — padexp: Offline-Evaluierung des semantischen Kanals.
   Liest ein extern vorbereitetes CSV-Manifest (image,keyword,label) + einen
   Bilderordner, scored alle Bilder über denselben Worker wie das Produkt und
   gibt aus (docs/SEMANTIC_FILTER_ROUTING.md, Punkte 11–12):

   - Precision/Recall/F1/FPR je Schlüsselwort (kalibriert UND Holdout)
   - Verteilungen Ziel-Kosinus / kontrastive Margin (Positiv/Negativ)
   - Kalibrierungstabelle (Schwelle → Recall/FPR/F1, 0…0,5)
   - Latenz p50/p95 der Bildstufe
   - report.json zum Download

   Deterministischer 70/30-Split (Kalibrierung/Holdout) über den FNV-1a-Hash
   des Bildnamens. Kein Modell-/Bildmaterial liegt im Repo. */
'use strict';

(function () {
  const $ = id => document.getElementById(id);
  const out = $('out');
  const logEl = $('log');
  const log = (line) => {
    logEl.textContent += line + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  };

  let report = null;
  $('dljson').onclick = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'padexp-report.json';
    a.click();
  };

  /* ---------- CSV ---------- */
  function parseCsv(text) {
    const rows = [];
    const lines = text.split(/\r?\n/);
    let start = 0;
    if (lines.length && /image\s*,\s*keyword/i.test(lines[0])) start = 1;   /* Kopfzeile */
    for (let i = start; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split(',');
      if (parts.length < 3) throw new Error('Zeile ' + (i + 1) + ': erwartet image,keyword,label');
      const image = parts[0].trim();
      const keyword = parts.slice(1, parts.length - 1).join(',').trim();   /* Kommas im Konzept erlaubt */
      const rawLabel = parts[parts.length - 1].trim().toLowerCase();
      const label = ['1', 'true', 'yes', 'ja', 'y'].includes(rawLabel) ? 1
        : (['0', 'false', 'no', 'nein', 'n'].includes(rawLabel) ? 0 : null);
      if (!image || !keyword || label === null) throw new Error('Zeile ' + (i + 1) + ': image/keyword/label ungültig');
      rows.push({ image, keyword, label });
    }
    return rows;
  }

  /* ---------- Split & Statistik ---------- */
  function fnv1a(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  const isCalibration = name => fnv1a(name) % 10 < 7;   /* 70 % Kalibrierung, 30 % Holdout */

  function quantile(sorted, p) {
    if (!sorted.length) return null;
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }
  function dist(list) {
    const s = list.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!s.length) return null;
    return {
      n: s.length, min: s[0], p25: quantile(s, 0.25), median: quantile(s, 0.5),
      p75: quantile(s, 0.75), p95: quantile(s, 0.95), max: s[s.length - 1],
      mean: s.reduce((a, b) => a + b, 0) / s.length
    };
  }

  /* Kontrastive Margin je Bild/Schlüsselwort — identische Formel wie im Produkt
     (window.YB.semantic.marginDecision); hier direkt, um Rohwerte zu behalten. */
  function marginsFor(cosScores) {
    const out = {};
    const list = (cosScores || []).filter(s => s && s.text && Number.isFinite(s.cos));
    for (const item of list) {
      let ref = -Infinity;
      for (const other of list) {
        if (other !== item && other.cos > ref) ref = other.cos;
      }
      out[item.text] = {
        cos: item.cos,
        margin: list.length > 1 ? item.cos - ref : item.cos,
        refCos: list.length > 1 ? ref : null
      };
    }
    return out;
  }

  function keywordMetrics(rows, cosByImage, keyword, threshold) {
    let tp = 0, fp = 0, fn = 0, tn = 0, missing = 0;
    const cosPos = [], cosNeg = [], marPos = [], marNeg = [];
    for (const r of rows) {
      if (r.keyword !== keyword) continue;
      const m = cosByImage[r.image] && cosByImage[r.image][keyword];
      if (!m) { missing++; continue; }
      if (r.label) { cosPos.push(m.cos); marPos.push(m.margin); } else { cosNeg.push(m.cos); marNeg.push(m.margin); }
      const pred = m.margin >= threshold;
      if (r.label && pred) tp++;
      else if (r.label && !pred) fn++;
      else if (!r.label && pred) fp++;
      else tn++;
    }
    const precision = (tp + fp) ? tp / (tp + fp) : 0;
    const recall = (tp + fn) ? tp / (tp + fn) : 0;
    const f1 = (precision + recall) ? 2 * precision * recall / (precision + recall) : 0;
    const fpr = (fp + tn) ? fp / (fp + tn) : 0;
    return {
      keyword, threshold, tp, fp, fn, tn, missing, precision, recall, f1, fpr,
      cos: { pos: dist(cosPos), neg: dist(cosNeg) },
      margin: { pos: dist(marPos), neg: dist(marNeg) }
    };
  }

  function macroSummary(metricsList) {
    const withPos = metricsList.filter(m => (m.tp + m.fn) > 0);
    const avg = key => withPos.length
      ? withPos.reduce((a, m) => a + m[key], 0) / withPos.length : 0;
    return {
      keywordsWithPositives: withPos.length,
      precision: avg('precision'), recall: avg('recall'), f1: avg('f1'), fpr: avg('fpr')
    };
  }

  /* ---------- Worker ---------- */
  let seq = 0;
  const pending = new Map();
  let worker = null;

  function call(type, payload) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage(Object.assign({ type, id }, payload));
    });
  }

  function startWorker() {
    worker = new Worker(new URL('../../extension/semantic-worker.js', location.href), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data || {};
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.type === 'ready' || m.type === 'texts-ready') p.resolve(m);
      else if (m.type === 'image-scores') p.resolve(m.scores);
      else p.reject(new Error(m.error || 'Worker-Fehler'));
    };
    worker.onerror = (e) => {
      const err = new Error((e && e.message) || 'Worker abgestürzt');
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    };
  }

  /* ---------- Lauf ---------- */
  function fmt(x, d = 3) { return Number.isFinite(x) ? x.toFixed(d) : '–'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  $('run').onclick = async () => {
    const csvFile = $('csv').files[0];
    const folder = $('imgs').files;
    const threshold = Number($('thr').value);
    if (!csvFile) { alert('Bitte CSV-Manifest wählen'); return; }
    if (!folder || !folder.length) { alert('Bitte Bilderordner wählen'); return; }
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) { alert('Schwelle muss 0…1 sein'); return; }

    $('run').disabled = true;
    logEl.textContent = '';
    out.innerHTML = '';
    report = null;
    $('dljson').disabled = true;

    try {
      const rows = parseCsv(await csvFile.text());
      const keywords = [...new Set(rows.map(r => r.keyword))];
      const wanted = new Set(rows.map(r => r.image));
      const files = Array.from(folder).filter(f => /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name) && wanted.has(f.name));
      const missingFiles = [...wanted].filter(n => !files.some(f => f.name === n));
      log(`Manifest: ${rows.length} Zeilen · ${keywords.length} Konzepte · ${wanted.size} Bilder`);
      if (missingFiles.length) log(`WARNUNG: ${missingFiles.length} Bilder fehlen im Ordner (z. B. ${missingFiles.slice(0, 3).join(', ')})`);
      if (!files.length) throw new Error('Keine passenden Bilder im Ordner gefunden');

      startWorker();
      const t0 = performance.now();
      const ready = await call('init', { device: navigator.gpu ? 'webgpu' : 'wasm' });
      log(`Modell bereit: device=${ready.device} (${Math.round(performance.now() - t0)} ms)`);
      const texts = await call('set-texts', { texts: keywords });
      log(`Text-Embeddings berechnet: ${(texts.labels || keywords).length} Konzepte`);

      const cosByImage = {};
      const latencies = [];
      let done = 0;
      for (const file of files) {
        const url = URL.createObjectURL(file);
        const t = performance.now();
        try {
          cosByImage[file.name] = marginsFor(await call('score-image', { source: url }));
        } finally {
          URL.revokeObjectURL(url);
        }
        latencies.push(performance.now() - t);
        done++;
        if (done % 10 === 0 || done === files.length) log(`gescort: ${done}/${files.length}`);
      }

      const lat = dist(latencies);
      const calibRows = rows.filter(r => isCalibration(r.image));
      const holdoutRows = rows.filter(r => !isCalibration(r.image));

      const calibMetrics = keywords.map(k => keywordMetrics(calibRows, cosByImage, k, threshold));
      const holdoutMetrics = keywords.map(k => keywordMetrics(holdoutRows, cosByImage, k, threshold));
      const calibMacro = macroSummary(calibMetrics);
      const holdoutMacro = macroSummary(holdoutMetrics);

      /* Kalibrierungstabelle: Schwellen-Sweep auf dem Kalibrierungsset */
      const sweep = [];
      for (let t = 0; t <= 0.5 + 1e-9; t += 0.01) {
        const m = keywords.map(k => keywordMetrics(calibRows, cosByImage, k, t));
        sweep.push(Object.assign({ threshold: Number(t.toFixed(2)) }, macroSummary(m)));
      }

      report = {
        createdAt: new Date().toISOString(),
        source: 'gui-test-assets/padexp',
        files: files.length, rows: rows.length, keywords,
        missingFiles,
        threshold,
        split: { calibration: calibRows.length, holdout: holdoutRows.length },
        latencyMs: lat,
        calibration: { macro: calibMacro, perKeyword: calibMetrics },
        holdout: { macro: holdoutMacro, perKeyword: holdoutMetrics },
        sweep
      };

      /* ---------- Ausgabe ---------- */
      const head = '<tr><th>Konzept</th><th>P</th><th>R</th><th>F1</th><th>FPR</th><th>TP/FP/FN/TN</th></tr>';
      const table = (metrics) => '<table>' + head + metrics.map(m =>
        `<tr><td>${esc(m.keyword)}</td><td>${fmt(m.precision)}</td><td>${fmt(m.recall)}</td>` +
        `<td>${fmt(m.f1)}</td><td>${fmt(m.fpr)}</td><td>${m.tp}/${m.fp}/${m.fn}/${m.tn}</td></tr>`).join('') + '</table>';

      out.innerHTML =
        `<h2>Kalibrierung (${calibRows.length} Zeilen, Makro: P ${fmt(calibMacro.precision)} · R ${fmt(calibMacro.recall)} · F1 ${fmt(calibMacro.f1)} · FPR ${fmt(calibMacro.fpr)})</h2>` +
        table(calibMetrics) +
        `<h2>Holdout (${holdoutRows.length} Zeilen, Makro: P ${fmt(holdoutMacro.precision)} · R ${fmt(holdoutMacro.recall)} · F1 ${fmt(holdoutMacro.f1)} · FPR ${fmt(holdoutMacro.fpr)})</h2>` +
        table(holdoutMetrics) +
        `<h2>Latenz Bildstufe: p50 ${fmt(lat && lat.median, 0)} ms · p95 ${fmt(lat && lat.p95, 0)} ms (n=${lat ? lat.n : 0})</h2>` +
        `<h2>Schwellen-Sweep (Kalibrierung, Makro)</h2>` +
        '<table><tr><th>Schwelle</th><th>Recall</th><th>FPR</th><th>F1</th></tr>' +
        sweep.filter(s => Math.abs(s.threshold * 100 % 5) < 1e-6)
          .map(s => `<tr><td>${s.threshold.toFixed(2)}</td><td>${fmt(s.recall)}</td><td>${fmt(s.fpr)}</td><td>${fmt(s.f1)}</td></tr>`).join('') +
        '</table>' +
        '<p class="muted">Produktionsschwelle konservativ wählen (FPR hat Vorrang vor Recall) und dokumentieren; ' +
        'report.json enthält alle Verteilungen und den vollen Sweep.</p>';

      $('dljson').disabled = false;
      log('Fertig.');
    } catch (err) {
      log('FEHLER: ' + (err && err.message || err));
    } finally {
      if (worker) { try { worker.terminate(); } catch (e) { /* egal */ } worker = null; }
      $('run').disabled = false;
    }
  };
})();
