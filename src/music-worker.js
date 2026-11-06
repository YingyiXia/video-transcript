import * as ort from 'onnxruntime-web';

const MODEL_URL = 'https://huggingface.co/StemSplitio/htdemucs-ft-vocals-onnx/resolve/main/htdemucs_ft_vocals_fp16weights.onnx';
const SAMPLE_RATE = 44100;
const SEGMENT = Math.round(7.8 * SAMPLE_RATE);
const OVERLAP = Math.floor(SEGMENT / 4);
const STRIDE = SEGMENT - OVERLAP;

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/';
let session;
let whisper;

function remaining(seconds) {
  return seconds < 60 ? `About ${Math.max(1, Math.ceil(seconds))}s remaining` : `About ${Math.ceil(seconds / 60)} min remaining`;
}

function resampleMono(left, right) {
  const count = Math.round(left.length * 16000 / SAMPLE_RATE);
  const output = new Float32Array(count);
  const ratio = SAMPLE_RATE / 16000;
  for (let index = 0; index < count; index++) {
    const source = index * ratio;
    const first = Math.floor(source);
    const next = Math.min(first + 1, left.length - 1);
    const blend = source - first;
    output[index] = ((left[first] + right[first]) * (1 - blend) + (left[next] + right[next]) * blend) / 2;
  }
  return output;
}

async function separate(audio) {
  if (!session) {
    self.postMessage({ type: 'status', message: 'Loading Demucs vocals model (166 MB on first use)…' });
    self.postMessage({ type: 'progress', stage: 'Downloading vocals model', percent: NaN });
    session = await ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  }
  const length = audio[0].length;
  const total = Math.max(1, Math.ceil(length / STRIDE));
  const vocals = [new Float32Array(length), new Float32Array(length)];
  const weights = new Float32Array(length);
  const chunk = new Float32Array(2 * SEGMENT);
  const started = performance.now();
  for (let index = 0; index < total; index++) {
    const start = index * STRIDE;
    const end = Math.min(start + SEGMENT, length);
    chunk.fill(0);
    for (let channel = 0; channel < 2; channel++) chunk.set(audio[channel].subarray(start, end), channel * SEGMENT);
    const result = await session.run({ mix: new ort.Tensor('float32', chunk, [1, 2, SEGMENT]) });
    const stems = result.stems.data;
    for (let position = 0; position < end - start; position++) {
      const weight = Math.min(1, position / OVERLAP, (SEGMENT - 1 - position) / OVERLAP);
      weights[start + position] += weight;
      vocals[0][start + position] += stems[6 * SEGMENT + position] * weight;
      vocals[1][start + position] += stems[7 * SEGMENT + position] * weight;
    }
    const done = index + 1;
    const eta = (performance.now() - started) / 1000 / done * (total - done);
    self.postMessage({ type: 'progress', stage: 'Separating vocals', percent: done / total * 100, eta: done < total ? remaining(eta) : '' });
  }
  for (let position = 0; position < length; position++) {
    const weight = Math.max(weights[position], 1e-8);
    vocals[0][position] /= weight;
    vocals[1][position] /= weight;
  }
  return resampleMono(vocals[0], vocals[1]);
}

self.onmessage = async ({ data }) => {
  try {
    const vocals = await separate(data.audio);
    self.postMessage({ type: 'status', message: 'Vocals separated. Loading Whisper…' });
    if (!whisper) {
      whisper = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      whisper.onmessage = ({ data: message }) => self.postMessage(message);
      whisper.onerror = (error) => self.postMessage({ type: 'error', message: error.message || 'Whisper could not start.' });
    }
    whisper.postMessage({ audio: vocals, sampleRate: 16000 }, [vocals.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || 'Could not separate vocals.' });
  }
};
