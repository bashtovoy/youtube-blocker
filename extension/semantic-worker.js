/* semantic-worker.js — lokales SigLIP: Text- und Bild-Embeddings.
   Zwei Betriebsarten in einer Datei (entscheidet das Nachrichtenprotokoll):

   1) Hauptmodus (Bildmessung): hält dauerhaft nur den Bild-Turm
      (`SiglipVisionModel`, 63 MB q4 statt 218 MB des Gesamtmodells).
      Pro Vorschaubild wird ein normalisiertes Bild-Embedding berechnet und
      der rohe Kosinus gegen die zwischengespeicherten Text-Embeddings gebildet.

   2) Textmodus (Nachricht `text-embeds`): läuft in einem temporären,
      verschachtelten Worker dieses Files. Er lädt einmalig das volle
      `SiglipModel`, berechnet die Text-Embeddings der Nutzerkonzepte
      (Dummy-Bild nötig — das Gesamtmodell führt beide Türme in einem
      ONNX-Lauf aus) und liefert sie normalisiert zurück. Danach wird der
      temporäre Worker beendet; seine 218 MB werden sofort freigegeben.

   Warum getrennt: Der Text-Turm lief bisher bei JEDEM Bild mit (~1 s pro
   Bild) und das Gesamtmodell blieb dauerhaft im Speicher. Getrennt sind es
   einmalig ~4 s mehr (Dummy-Lauf pro Wortlisten-Revision) und danach
   schneller + deutlich speicherärmer. Siehe docs/SEMANTIC_FILTER_ROUTING.md
   (Punkte 3: roher Kosinus/kontrastive Margin, 9: Text-Embeddings einmal
   pro Revision statt pro Karte). */
import {
  env,
  AutoProcessor,
  AutoTokenizer,
  SiglipModel,
  SiglipVisionModel,
  RawImage
} from './lib/transformers.min.js';

const MODEL_ID = 'siglip-base-patch16-224';

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = new URL('./models/', import.meta.url).href;
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
  const tryDevice = async (candidate) => {
    const processor = await AutoProcessor.from_pretrained(MODEL_ID);
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
    const model = await SiglipModel.from_pretrained(MODEL_ID, {
      device: candidate,
      dtype: dtypeFor(candidate)
    });
    return { processor, tokenizer, model, device: candidate };
  };
  let ctx;
  try {
    ctx = await tryDevice(preferredDevice);
  } catch (firstError) {
    if (preferredDevice !== 'wasm') {
      ctx = await tryDevice('wasm');
    } else {
      throw firstError;
    }
  }
  /* SigLIP wurde mit natürlichsprachigen Prompts trainiert; für den
     Bildabgleich wird die Foto-Formulierung verwendet, während die
     Nutzertexte unverändert als Labels erhalten bleiben. */
  const prompts = labels.map(x => (/^a photo of\b/i.test(x) ? x : 'a photo of ' + x));
  /* padding:true füllt nur auf die längste Sequenz im Batch auf (das frühere
     'max_length' blähte jeden Prompt auf 64 Tokens auf → Text-Turm dominierte
     den Score). */
  const textInputs = ctx.tokenizer(prompts, { padding: true, truncation: true });
  /* Dummy-Bild (1×1 schwarz): nur zum Erfüllen der Modell-Signatur. */
  const dummy = new RawImage(new Uint8Array([0, 0, 0]), 1, 1, 3);
  const imageInputs = await ctx.processor(dummy);
  const output = await ctx.model({ ...textInputs, ...imageInputs });
  const embeds = output?.text_embeds;
  if (!embeds?.data) {
    throw new Error('SigLIP lieferte keine Text-Embeddings (Keys: ' + outputKeys(output) + ')');
  }
  const n = Array.isArray(embeds.dims) ? embeds.dims[0] : labels.length;
  const dim = Array.isArray(embeds.dims) ? embeds.dims[1] : Math.floor(embeds.data.length / n);
  const flat = new Float32Array(n * dim);
  for (let i = 0; i < n; i++) {
    flat.set(normalizeVector(embeds.data.subarray(i * dim, (i + 1) * dim)), i * dim);
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
    const tryDevice = async (candidate) => {
      processor = await AutoProcessor.from_pretrained(MODEL_ID);
      vision = await SiglipVisionModel.from_pretrained(MODEL_ID, {
        device: candidate,
        dtype: dtypeFor(candidate)
      });
      device = candidate;
    };
    const preferred = preferredDevice || deviceGuess();
    try {
      await tryDevice(preferred);
    } catch (firstError) {
      if (preferred !== 'wasm') {
        processor = null;
        vision = null;
        await tryDevice('wasm');
      } else {
        throw firstError;
      }
    }
    return { device, modelId: MODEL_ID, tower: 'vision' };
  })().catch(err => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

/* Temporärer Text-Worker: berechnet die Text-Embeddings und wird danach
   beendet (einziger Weg, die 218 MB des Gesamtmodells sicher freizugeben —
   die Bibliothek bietet kein modellweises dispose()). */
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
      } else if (msg.type === 'error') {
        cleanup();
        reject(new Error(msg.error || 'Text-Embeddings fehlgeschlagen'));
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
  /* Läuft bewusst parallel zu init() (der Host startet beide): Die
     Gerätewahl ist in beiden Pfaden identisch (gleiche Fallback-Logik). */
  const res = await spawnTextWorker(device || deviceGuess(), list);
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
      error: String(error?.message || error)
    });
  }
};
