/* semantic-worker.js — lokales SigLIP: Text- und Bild-Embeddings.
   Modellbezug: lokal zuerst (`extension/models/`, gefüllt von setup.sh für
   Dev), sonst automatisch von HuggingFace (Revision gepinnt) mit Ablage im
   Browser-Cache (Cache API „transformers-cache"; unlimitedStorage steht im
   Manifest). So funktioniert auch die signierte AMO-Version ohne
   mitgelieferte Modelle (200-MB-Uploadlimit). Nach dem ersten Bezug läuft
   alles offline; die Inferenz bleibt lokal.

   Zwei Betriebsarten in einer Datei (entscheidet das Nachrichtenprotokoll):

   1) Hauptmodus (Bildmessung): hält dauerhaft nur den Bild-Turm
      (`SiglipVisionModel`, ~55–63 MB quantisiert statt 218 MB des
      Gesamtmodells). Pro Vorschaubild wird ein normalisiertes Bild-Embedding
      berechnet und der rohe Kosinus gegen die zwischengespeicherten
      Text-Embeddings gebildet.

   2) Textmodus (Nachricht `text-embeds`): läuft in einem temporären,
      verschachtelten Worker dieses Files. Er lädt einmalig den Text-Turm
      (`SiglipTextModel`, ~99–155 MB quantisiert) und berechnet die
      Text-Embeddings der Nutzerkonzepte. Danach wird der temporäre Worker
      beendet; sein Modell wird sofort freigegeben.

   Warum getrennt: Der Text-Turm lief bisher bei JEDEM Bild mit (~1 s pro
   Bild) und das Modell blieb dauerhaft im Speicher. Getrennt sind es
   einmalig ~4 s mehr (Lauf pro Wortlisten-Revision) und danach schneller +
   deutlich speicherärmer. Siehe docs/SEMANTIC_FILTER_ROUTING.md
   (Punkte 3: roher Kosinus/kontrastive Margin, 9: Text-Embeddings einmal
   pro Revision statt pro Karte). */
import {
  env,
  AutoProcessor,
  AutoTokenizer,
  SiglipTextModel,
  SiglipVisionModel,
  RawImage
} from './lib/transformers.min.js';

const MODEL_ID = 'siglip-base-patch16-224';
/* Fixierte Revision: Der signierte Build lädt immer genau diese Gewichte —
   kein stilles Mitändern durch Upstream-Updates. */
const REVISION = '4649052661e53c7000355844105f8a1792088239';

env.allowLocalModels = true;
env.allowRemoteModels = true;
env.localModelPath = new URL('./models/', import.meta.url).href;
/* Die lokale ID bleibt „siglip-base-patch16-224“ (Modelle liegen unter
   models/siglip-base-patch16-224/), bezogen wird aber aus dem kanonischen
   Repo „Xenova/siglip-base-patch16-224“ — ohne Owner liefert HF 401. */
env.remotePathTemplate = 'Xenova/{model}/resolve/{revision}/';
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = new URL('./lib/', import.meta.url).href;
  env.backends.onnx.wasm.numThreads = 1;
}

function dtypeFor(device) {
  return device === 'webgpu' ? 'q4f16' : 'q4';
}

function deviceGuess() {
  return self.navigator?.gpu ? 'webgpu' : 'wasm';
}

/* Fortschritt an den Host (semantic-host.js) melden, gedrosselt: Beim
   Erstbezug streamt transformers.js den Download in kleinen Häppchen. */
let lastProgressAt = 0;
function reportProgress(phase) {
  return (p) => {
    if (!p || typeof p !== 'object') return;
    const done = p.status === 'done';
    const pct = Number.isFinite(Number(p.progress)) ? Math.round(Number(p.progress)) : 0;
    const now = Date.now();
    if (!done && pct < 100 && now - lastProgressAt < 120) return;
    lastProgressAt = now;
    self.postMessage({
      type: 'progress',
      phase,
      status: p.status || 'progress',
      file: String(p.file || p.name || ''),
      loaded: p.loaded || 0,
      total: p.total || 0,
      progress: pct
    });
  };
}

/* Netzwerk-/Download-Fehler sind wiederholbar: Der Kanal darf sich nicht für
   die ganze Seitensession abschalten, nur weil der Erstbezug kurz scheitert. */
function isNetworkishError(err) {
  const msg = String((err && err.message) || err);
  return err instanceof TypeError ||
    /fetch|network|download|occurred while trying|unable to load from local path|timeout/i.test(msg);
}

function markRetryable(err) {
  if (isNetworkishError(err)) err.retryable = true;
  return err;
}

function normalizeVector(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

function outputKeys(output) {
  return output && typeof output === 'object' ? Object.keys(output).join(',') : String(output);
}

/* ============================ Textmodus ============================ */

async function computeTextEmbeds(preferredDevice, labels) {
  const progress = reportProgress('text');
  const tryDevice = async (candidate) => {
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, {
      revision: REVISION,
      progress_callback: progress
    });
    const model = await SiglipTextModel.from_pretrained(MODEL_ID, {
      device: candidate,
      dtype: dtypeFor(candidate),
      revision: REVISION,
      progress_callback: progress
    });
    return { tokenizer, model, device: candidate };
  };
  let ctx;
  try {
    ctx = await tryDevice(preferredDevice);
  } catch (firstError) {
    /* Netzproblem: Gerätewechsel hilft nicht — Fehler unverändert weiterreichen. */
    if (isNetworkishError(firstError)) throw markRetryable(firstError);
    /* Gerätewechsel meldet der Aufrufer an (er startet dafür einen frischen
       Worker): Ein gescheiterter WebGPU-Versuch hinterlässt den Zustand der
       ONNX-Laufzeit beschädigt — ein Wasm-Versuch im selben Worker scheitert
       reproduzierbar mit derselben Adapter-Meldung. */
    if (preferredDevice !== 'wasm' && firstError && typeof firstError === 'object') {
      firstError.deviceFallback = 'wasm';
    }
    throw firstError;
  }
  /* SigLIP wurde mit natürlichsprachigen Prompts trainiert; für den
     Bildabgleich wird die Foto-Formulierung verwendet, während die
     Nutzertexte unverändert als Labels erhalten bleiben. */
  const prompts = labels.map(x => (/^a photo of\b/i.test(x) ? x : 'a photo of ' + x));
  /* padding:true füllt nur auf die längste Sequenz im Batch auf (das frühere
     'max_length' blähte jeden Prompt auf 64 Tokens auf → Text-Turm dominierte
     den Score). */
  const textInputs = ctx.tokenizer(prompts, { padding: true, truncation: true });
  const output = await ctx.model(textInputs);
  /* Der separate Text-Turm liefert das Embedding als pooler_output
     (= text_embeds des Gesamtmodells; per Diagnose verifiziert).
     last_hidden_state dient als Notnagel (Mean-Pooling). */
  let pooled = output?.pooler_output?.data ? output.pooler_output.data : null;
  if (!pooled && output?.last_hidden_state?.data) {
    const t = output.last_hidden_state;
    const [, seq, dim] = t.dims;
    const mean = new Float32Array(dim);
    for (let s = 0; s < seq; s++) {
      for (let d = 0; d < dim; d++) mean[d] += t.data[s * dim + d];
    }
    for (let d = 0; d < dim; d++) mean[d] /= seq;
    pooled = mean;
  }
  if (!pooled) {
    throw new Error('SigLIP lieferte keine Text-Embeddings (Keys: ' + outputKeys(output) + ')');
  }
  const dims = output.pooler_output?.dims || output.last_hidden_state?.dims;
  const n = Array.isArray(dims) ? dims[0] : labels.length;
  const dim = Array.isArray(dims) ? dims[1] : Math.floor(pooled.length / n);
  const flat = new Float32Array(n * dim);
  for (let i = 0; i < n; i++) {
    flat.set(normalizeVector(pooled.subarray(i * dim, (i + 1) * dim)), i * dim);
  }
  return { embeds: flat, dim, labels, device: ctx.device };
}

/* ============================ Hauptmodus ============================ */

let processor = null;
let vision = null;
let device = null;
let initPromise = null;

let textEmbeds = null;   /* Float32Array n*dim, normalisiert */
let textDim = 0;
let textLabels = [];

async function init(preferredDevice) {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const progress = reportProgress('vision');
    const tryDevice = async (candidate) => {
      processor = await AutoProcessor.from_pretrained(MODEL_ID, {
        revision: REVISION,
        progress_callback: progress
      });
      vision = await SiglipVisionModel.from_pretrained(MODEL_ID, {
        device: candidate,
        dtype: dtypeFor(candidate),
        revision: REVISION,
        progress_callback: progress
      });
      device = candidate;
    };
    const preferred = preferredDevice || deviceGuess();
    try {
      await tryDevice(preferred);
    } catch (firstError) {
      /* Netzproblem: Gerätewechsel hilft nicht — Fehler unverändert weiterreichen. */
      if (isNetworkishError(firstError)) throw markRetryable(firstError);
      /* Gerätewechsel meldet der Host an (er verwirft diesen Worker und startet
         einen frischen): Ein gescheiterter WebGPU-Versuch hinterlässt den
         Zustand der ONNX-Laufzeit beschädigt — ein Wasm-Versuch im selben
         Worker scheitert reproduzierbar mit derselben Adapter-Meldung. */
      if (preferred !== 'wasm' && firstError && typeof firstError === 'object') {
        firstError.deviceFallback = 'wasm';
      }
      throw firstError;
    }
    return { device, modelId: MODEL_ID, tower: 'vision' };
  })().catch(err => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

/* Temporärer Text-Worker: berechnet die Text-Embeddings und wird danach
   beendet (einziger Weg, das Modell sicher freizugeben — die Bibliothek
   bietet kein modellweises dispose()). */
function spawnTextWorker(preferredDevice, labels) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./semantic-worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(e);
      return;
    }
    const cleanup = () => { try { worker.terminate(); } catch (e) { /* schon weg */ } };
    worker.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'text-embeds-result') {
        cleanup();
        resolve(msg);
      } else if (msg.type === 'progress') {
        /* Downloadfortschritt des Text-Turms an den Host durchreichen. */
        self.postMessage({ ...msg, phase: 'text' });
      } else if (msg.type === 'error') {
        cleanup();
        const err = new Error(msg.error || 'Text-Embeddings fehlgeschlagen');
        if (msg.retryable) err.retryable = true;
        if (msg.deviceFallback) err.deviceFallback = msg.deviceFallback;
        reject(err);
      }
    };
    worker.onerror = (e) => {
      cleanup();
      reject(new Error((e && e.message) || 'Text-Worker fehlgeschlagen'));
    };
    worker.postMessage({ type: 'text-embeds', device: preferredDevice, texts: labels });
  });
}

async function setTexts(labels) {
  const list = (labels || []).map(x => String(x || '').trim()).filter(Boolean);
  if (!list.length) {
    textEmbeds = null;
    textDim = 0;
    textLabels = [];
    return [];
  }
  /* Läuft bewusst parallel zu init() (der Host startet beide). Der Text-Turm
     bekommt je Versuch einen frischen temporären Worker — der Gerätewechsel
     ist hier deshalb direkt möglich (kein beschädigter Laufzeit-Zustand). */
  const preferred = device || deviceGuess();
  let res;
  try {
    res = await spawnTextWorker(preferred, list);
  } catch (err) {
    if (err && err.deviceFallback && preferred !== err.deviceFallback) {
      res = await spawnTextWorker(err.deviceFallback, list);
    } else {
      throw err;
    }
  }
  textEmbeds = res.embeds instanceof Float32Array ? res.embeds : new Float32Array(res.embeds || []);
  textDim = res.dim || 0;
  textLabels = Array.isArray(res.labels) ? res.labels : list;
  if (!textDim || !textEmbeds.length) throw new Error('Leere Text-Embeddings');
  return textLabels;
}

function setTextEmbeds(embeds, dim, labels) {
  const flat = embeds instanceof Float32Array ? embeds : new Float32Array(embeds || []);
  const list = (labels || []).map(x => String(x || '')).filter(Boolean);
  if (!dim || !flat.length || list.length !== Math.floor(flat.length / dim)) {
    throw new Error('Ungültige gespeicherte Text-Embeddings');
  }
  textEmbeds = flat;
  textDim = dim;
  textLabels = list;
  return textLabels;
}

async function scoreImage(source) {
  await init();
  if (!textEmbeds || !textLabels.length) return [];
  const image = await RawImage.read(source);
  const imageInputs = await processor(image);
  const output = await vision(imageInputs);
  let pooled = output?.pooler_output?.data ? output.pooler_output.data : null;
  if (!pooled && output?.last_hidden_state?.data) {
    /* Notnagel: Mean-Pooling, falls der Export keinen pooler_output liefert. */
    const t = output.last_hidden_state;
    const [, seq, dim] = t.dims;
    const mean = new Float32Array(dim);
    for (let s = 0; s < seq; s++) {
      for (let d = 0; d < dim; d++) mean[d] += t.data[s * dim + d];
    }
    for (let d = 0; d < dim; d++) mean[d] /= seq;
    pooled = mean;
  }
  if (!pooled) {
    throw new Error('SigLIP lieferte kein Bild-Embedding (Keys: ' + outputKeys(output) + ')');
  }
  const img = normalizeVector(pooled);
  const scores = [];
  for (let i = 0; i < textLabels.length; i++) {
    const off = i * textDim;
    let dot = 0;
    for (let d = 0; d < textDim; d++) dot += img[d] * textEmbeds[off + d];
    scores.push({ text: textLabels[i], cos: dot });
  }
  return scores;
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'text-embeds') {
      /* Modus des temporären Text-Workers. */
      const labels = (msg.texts || []).map(x => String(x || '').trim()).filter(Boolean);
      const result = await computeTextEmbeds(msg.device || deviceGuess(), labels);
      self.postMessage({
        type: 'text-embeds-result',
        id: msg.id,
        embeds: result.embeds,
        dim: result.dim,
        labels: result.labels,
        device: result.device
      });
      return;
    }
    if (msg.type === 'init') {
      const ready = await init(msg.device);
      self.postMessage({ type: 'ready', id: msg.id, ...ready });
    } else if (msg.type === 'set-texts') {
      const labels = await setTexts(msg.texts);
      self.postMessage({ type: 'texts-ready', id: msg.id, labels, embeds: textEmbeds, dim: textDim });
    } else if (msg.type === 'set-text-embeds') {
      const labels = setTextEmbeds(msg.embeds, msg.dim, msg.labels);
      self.postMessage({ type: 'texts-ready', id: msg.id, labels });
    } else if (msg.type === 'score-image') {
      const scores = await scoreImage(msg.source);
      self.postMessage({ type: 'image-scores', id: msg.id, scores });
    } else if (msg.type === 'ping') {
      self.postMessage({ type: 'pong', id: msg.id, device, modelId: MODEL_ID });
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id: msg.id,
      error: String(error?.message || error),
      retryable: !!error?.retryable,
      deviceFallback: (error && error.deviceFallback) || null
    });
  }
};
