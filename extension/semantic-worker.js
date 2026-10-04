/* semantic-worker.js — local SigLIP vision encoder for semantic image similarity */
import {
  env,
  AutoProcessor,
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

let processor = null;
let model = null;
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

async function init(preferredDevice = 'wasm') {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const tryDevice = async (candidate) => {
      processor = await AutoProcessor.from_pretrained(MODEL_ID);
      model = await SiglipVisionModel.from_pretrained(MODEL_ID, {
        device: candidate,
        dtype: 'q4f16'
      });
      device = candidate;
    };

    try {
      await tryDevice(preferredDevice);
    } catch (firstError) {
      if (preferredDevice !== 'wasm') {
        processor = null;
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

async function embed(source) {
  const image = await RawImage.read(source);
  const inputs = await processor(image);
  const output = await model(inputs);
  if (!output?.pooler_output?.data) {
    throw new Error('SigLIP vision model returned no pooler_output');
  }
  return normalizeVector(output.pooler_output.data);
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'init') {
      const ready = await init(msg.device || (self.navigator?.gpu ? 'webgpu' : 'wasm'));
      self.postMessage({ type: 'ready', id: msg.id, ...ready });
    } else if (msg.type === 'embed') {
      await init(msg.device || (self.navigator?.gpu ? 'webgpu' : 'wasm'));
      const vector = await embed(msg.source);
      self.postMessage({ type: 'embedding', id: msg.id, vector });
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
