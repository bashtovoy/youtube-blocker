/* semantic-worker.js — local SigLIP text ↔ image semantic matching */
import {
  env,
  AutoProcessor,
  AutoTokenizer,
  SiglipModel,
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
let model = null;
let device = null;
let initPromise = null;
let textInputs = null;
let textLabels = [];

function tensorToArray(tensor) {
  return tensor?.data ? Array.from(tensor.data) : [];
}

async function init(preferredDevice = 'wasm') {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const tryDevice = async (candidate) => {
      processor = await AutoProcessor.from_pretrained(MODEL_ID);
      tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
      model = await SiglipModel.from_pretrained(MODEL_ID, {
        device: candidate,
        dtype: candidate === 'webgpu' ? 'q4f16' : 'q4'
      });
      device = candidate;
    };
    try {
      await tryDevice(preferredDevice);
    } catch (firstError) {
      if (preferredDevice !== 'wasm') {
        processor = null;
        tokenizer = null;
        model = null;
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

async function setTexts(labels) {
  const list = (labels || []).map(x => String(x || '').trim()).filter(Boolean);
  if (!list.length) {
    textInputs = null;
    textLabels = [];
    return [];
  }
  await init();
  /*
   * SigLIP was trained with natural-language prompts. Keeping the user's
   * wording in the visible result while using a photo prompt improves
   * image/text alignment for short concepts.
   */
  const prompts = list.map(x => /^a photo of\b/i.test(x) ? x : 'a photo of ' + x);
  textInputs = tokenizer(prompts, { padding: 'max_length', truncation: true });
  textLabels = list;
  return list;
}

async function scoreImage(source) {
  await init();
  if (!textInputs || !textLabels.length) return [];
  const image = await RawImage.read(source);
  const imageInputs = await processor(image);
  const output = await model({ ...textInputs, ...imageInputs });
  const logits = tensorToArray(output?.logits_per_image);
  if (logits.length !== textLabels.length) {
    throw new Error('SigLIP returned unexpected logits shape');
  }
  /*
   * SigLIP uses independent sigmoid scores rather than a softmax over labels.
   * Return both calibrated probability and raw logit for diagnostics.
   */
  return textLabels.map((text, i) => {
    const logit = logits[i];
    const probability = 1 / (1 + Math.exp(-logit));
    return { text, score: probability, logit };
  });
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'init') {
      const ready = await init(msg.device || (self.navigator?.gpu ? 'webgpu' : 'wasm'));
      self.postMessage({ type: 'ready', id: msg.id, ...ready });
    } else if (msg.type === 'set-texts') {
      const labels = await setTexts(msg.texts);
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