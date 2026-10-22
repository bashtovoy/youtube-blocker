#!/usr/bin/env node
/* Score the OCR arms against the salient-text manifest.
 *
 * CER/WER are computed against the best matching token window in the OCR
 * output.  This tolerates different line breaking and ignores timers/UI noise
 * that are not part of the thumbnail's salient text.  Keyword recall checks
 * whether the words a blocker would care about survived OCR.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const exp = path.resolve(here, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(exp, 'manifest.json'), 'utf8'));
const rawDir = path.join(exp, 'results', 'raw');
const arms = process.argv.slice(2).filter((a) => !a.startsWith('-'));

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[äáàâ]/g, 'a')
    .replace(/[öóòô]/g, 'o')
    .replace(/[üúùû]/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/[éèê]/g, 'e')
    .replace(/[íìî]/g, 'i')
    .replace(/[ñ]/g, 'n')
    .replace(/[ç]/g, 'c')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokens(s) {
  const n = norm(s);
  return n ? n.split(' ') : [];
}

function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Uint32Array(b.length + 1);
  const cur = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev.set(cur);
  }
  return prev[b.length];
}

function levArray(a, b) {
  if (a.length === b.length && a.every((v, i) => v === b[i])) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Uint32Array(b.length + 1);
  const cur = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev.set(cur);
  }
  return prev[b.length];
}

function keywordHit(keyword, ocrText) {
  const k = norm(keyword);
  const o = norm(ocrText);
  if (!k) return false;
  const kt = k.split(' ');
  if (kt.length > 1) {
    const ot = o.split(' ');
    for (let i = 0; i + kt.length <= ot.length; i++) {
      let ok = true;
      for (let j = 0; j < kt.length; j++) {
        if (ot[i + j] !== kt[j]) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  }
  if (k.length <= 3) return (' ' + o + ' ').includes(' ' + k + ' ');
  return o.includes(k);
}

function bestWindow(gt, ocrTokens) {
  const g = tokens(gt);
  if (!g.length) return { cer: 0, wer: 0, text: '' };
  if (!ocrTokens.length) return { cer: 1, wer: 1, text: '' };
  let best = { cer: Infinity, wer: Infinity, text: '' };
  for (let n = Math.max(1, g.length - 2); n <= g.length + 3; n++) {
    for (let i = 0; i + n <= ocrTokens.length; i++) {
      const cand = ocrTokens.slice(i, i + n).join(' ');
      const cer = lev(g.join(' '), cand) / Math.max(1, g.join(' ').length);
      if (cer < best.cer) {
        best = { cer, wer: levArray(g, ocrTokens.slice(i, i + n)) / g.length, text: cand };
      }
    }
  }
  if (!Number.isFinite(best.cer)) {
    const cand = ocrTokens.join(' ');
    best = {
      cer: lev(g.join(' '), cand) / Math.max(1, g.join(' ').length),
      wer: levArray(g, ocrTokens) / g.length,
      text: cand,
    };
  }
  return best;
}

function scoreItem(item, result) {
  const ocrText = String(result.text || '');
  const ocrTokens = tokens(ocrText);
  const gtLines = (item.lines || []).filter((l) => norm(l));
  const perLine = gtLines.map((line) => {
    const b = bestWindow(line, ocrTokens);
    return { line, ...b, exact: b.cer === 0, near: b.cer <= 0.15 };
  });
  const cer = perLine.length ? perLine.reduce((s, x) => s + x.cer, 0) / perLine.length : null;
  const wer = perLine.length ? perLine.reduce((s, x) => s + x.wer, 0) / perLine.length : null;
  const exact = perLine.length ? perLine.filter((x) => x.exact).length / perLine.length : null;
  const near = perLine.length ? perLine.filter((x) => x.near).length / perLine.length : null;
  const kws = item.keywords || [];
  const kwHits = kws.map((k) => keywordHit(k, ocrText));
  const kwRecall = kws.length ? kwHits.filter(Boolean).length / kws.length : null;
  const textTokens = ocrTokens.filter((t) => /[a-zа-я]/i.test(t));
  const falseWords = item.negative ? textTokens.filter((t) => t.length >= 3) : [];
  return {
    id: item.id,
    lang: item.lang,
    split: item.split,
    tags: item.tags,
    negative: !!item.negative,
    groundTruth: gtLines,
    ocrText,
    ocrLines: String(result.text || '').split('\n').map((s) => s.trim()).filter(Boolean),
    ms: result.ms,
    predictMs: result.predictMs ?? null,
    plan: result.plan || '',
    deepModes: result.deepModes || [],
    confidence: result.confidence ?? null,
    cer, wer, exact, near, kwRecall,
    kwHits: kws.map((k, i) => ({ keyword: k, hit: kwHits[i] })),
    perLine,
    falseWords,
    falseWordCount: falseWords.length,
  };
}

function pct(values, p) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return a[i];
}

function mean(values) {
  const a = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
}

function summarize(scored, arm) {
  const textItems = scored.filter((x) => !x.negative);
  const negatives = scored.filter((x) => x.negative);
  const times = scored.map((x) => x.ms).filter(Number.isFinite);
  const byLang = {};
  for (const lang of ['en', 'ru']) {
    byLang[lang] = {
      n: textItems.filter((x) => x.lang === lang).length,
      cer: mean(textItems.filter((x) => x.lang === lang).map((x) => x.cer)),
      kwRecall: mean(textItems.filter((x) => x.lang === lang).map((x) => x.kwRecall)),
    };
  }
  const bySplit = {};
  for (const split of ['dev', 'test']) {
    bySplit[split] = {
      n: textItems.filter((x) => x.split === split).length,
      cer: mean(textItems.filter((x) => x.split === split).map((x) => x.cer)),
      kwRecall: mean(textItems.filter((x) => x.split === split).map((x) => x.kwRecall)),
    };
  }
  const target = scored.find((x) => x.id === 'OhVjcySNqqc');
  return {
    arm,
    n: scored.length,
    textN: textItems.length,
    negativeN: negatives.length,
    meanCer: mean(textItems.map((x) => x.cer)),
    meanWer: mean(textItems.map((x) => x.wer)),
    exactLineRate: mean(textItems.map((x) => x.exact)),
    nearLineRate: mean(textItems.map((x) => x.near)),
    meanKeywordRecall: mean(textItems.map((x) => x.kwRecall)),
    byLang,
    bySplit,
    timing: {
      meanMs: mean(times),
      medianMs: pct(times, 50),
      p95Ms: pct(times, 95),
      maxMs: times.length ? Math.max(...times) : null,
    },
    negatives: {
      meanFalseWords: mean(negatives.map((x) => x.falseWordCount)),
      withText: negatives.filter((x) => x.falseWordCount > 0).length,
      details: negatives.map((x) => ({ id: x.id, words: x.falseWords })),
    },
    target: target ? {
      id: target.id,
      cer: target.cer,
      headlineCer: target.perLine?.[0]?.cer ?? null,
      kwRecall: target.kwRecall,
      text: target.ocrText,
    } : null,
  };
}

const selected = arms.length ? arms : fs.readdirSync(rawDir)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => f.slice(0, -5));
const results = [];
for (const arm of selected) {
  const file = path.join(rawDir, arm + '.json');
  if (!fs.existsSync(file)) {
    console.log('missing ' + file);
    continue;
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byId = new Map((raw.images || []).map((x) => [x.id, x]));
  const scored = [];
  for (const item of manifest.items) {
    const result = byId.get(item.id);
    if (!result) continue;
    scored.push(scoreItem(item, result));
  }
  const summary = { ...summarize(scored, arm), variant: raw.variant || '1280', init: raw.init, langInit: raw.langInit, offline: raw.offline, environment: raw.environment };
  results.push({ summary, images: scored });
}

const outDir = path.join(exp, 'results');
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(results.map((r) => r.summary), null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'scored.json'), JSON.stringify(results, null, 2) + '\n');

console.log('\nARM                  n   CER    WER    exact  near   kwRecall  meanMs  p95Ms  headlineCER  targetKW');
for (const { summary: s } of results) {
  const f = (v, d = 3) => v == null ? '—' : v.toFixed(d);
  console.log(
    s.arm.padEnd(20),
    String(s.textN).padStart(3),
    f(s.meanCer).padStart(6),
    f(s.meanWer).padStart(6),
    f(s.exactLineRate, 2).padStart(6),
    f(s.nearLineRate, 2).padStart(6),
    f(s.meanKeywordRecall, 2).padStart(8),
    String(Math.round(s.timing.meanMs)).padStart(7),
    String(Math.round(s.timing.p95Ms)).padStart(6),
    f(s.target?.headlineCer).padStart(12),
    f(s.target?.kwRecall, 2).padStart(9)
  );
}
console.log('\nwrote results/summary.json and results/scored.json');

/* Print failures that matter for the product: target and Russian items. */
for (const { summary: s, images } of results) {
  console.log('\n== ' + s.arm + ' target ==');
  const t = images.find((x) => x.id === 'OhVjcySNqqc');
  if (t) console.log(JSON.stringify({ text: t.ocrText, cer: t.cer, kw: t.kwRecall }, null, 2));
  console.log('== ' + s.arm + ' Russian ==');
  for (const x of images.filter((i) => i.lang === 'ru')) {
    console.log(x.id, 'CER=' + (x.cer == null ? '—' : x.cer.toFixed(2)), 'kw=' + (x.kwRecall == null ? '—' : x.kwRecall.toFixed(2)), JSON.stringify(x.ocrText.slice(0, 180)));
  }
}
