/* semantic-worker.js — local SigLIP text ↔ image embeddings */
import {
  env,
  AutoProcessor,
  AutoTokenizer,
  SiglipVisionModel,
  SiglipTextModel,
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

let processor = null;
let tokenizer = null;
let visionModel = null;
let textModel = null;
let device = null;
let initPromise = null;

function normalizeVector(data) {
  const out = Float32Array.from(data);
  let norm = 0;
  for (const x of out) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return Array.from(out);
}

function splitAndNormalize(data, dims) {
  const rows = Number(dims?.[0]) || 1;
  const width = Number(dims?.[1]) || Math.floor(data.length / rows);
  const out = [];
  for (let row = 0; row < rows; row++) {
    out.push(normalizeVector(data.slice(row * width, (row + 1) * width)));
  }
  return out;
}

async function init(preferredDevice = 'wasm') {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const tryDevice = async (candidate) => {
      processor = await AutoProcessor.from_pretrained(MODEL_ID);
      tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);

      const dtype = candidate === 'webgpu' ? 'q4f16' : 'q4';
      visionModel = await SiglipVisionModel.from_pretrained(MODEL_ID, {
        device: candidate,
        dtype
      });
      textModel = await SiglipTextModel.from_pretrained(MODEL_ID, {
        device: candidate,
        dtype
      });
      device = candidate;
    };

    try {
      await tryDevice(preferredDevice);
    } catch (firstError) {
      if (preferredDevice !== 'wasm') {
        processor = null;
        tokenizer = null;
        visionModel = null;
        textModel = null;
        await tryDevice('wasm');
      } else {
        throw firstError;
      }
    }
    return { device, modelId: MODEL_ID };
  })().catch(err => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

async function embedImage(source) {
  const image = await RawImage.read(source);
  const inputs = await processor(image);
  const output = await visionModel(inputs);
  if (!output?.pooler_output?.data) {
    throw new Error('SigLIP vision model returned no pooler_output');
  }
  return normalizeVector(output.pooler_output.data);
}

async function embedTexts(texts) {
  const list = (texts || []).map(x => String(x || '').trim()).filter(Boolean);
  if (!list.length) return [];
  const inputs = tokenizer(list, { padding: 'max_length', truncation: true });
  const output = await textModel(inputs);
  if (!output?.pooler_output?.data) {
    throw new Error('SigLIP text model returned no pooler_output');
  }
  return splitAndNormalize(output.pooler_output.data, output.pooler_output.dims);
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'init') {
      const ready = await init(msg.device || (self.navigator?.gpu ? 'webgpu' : 'wasm'));
      self.postMessage({ type: 'ready', id: msg.id, ...ready });
    } else if (msg.type === 'embed-image') {
      await init(msg.device || (self.navigator?.gpu ? 'webgpu' : 'wasm'));
      const vector = await embedImage(msg.source);
      self.postMessage({ type: 'image-embedding', id: msg.id, vector });
    } else if (msg.type === 'embed-texts') {
      await init(msg.device || (self.navigator?.gpu ? 'webgpu' : 'wasm'));
      const vectors = await embedTexts(msg.texts);
      self.postMessage({ type: 'text-embeddings', id: msg.id, vectors });
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

