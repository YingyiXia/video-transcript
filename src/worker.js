import { env, pipeline } from '@huggingface/transformers';

env.backends.onnx.wasm.numThreads = 1;

let transcriber;

function formatRemaining(seconds) {
  if (seconds < 60) return `About ${Math.max(1, Math.ceil(seconds))}s remaining`;
  return `About ${Math.ceil(seconds / 60)} min remaining`;
}

self.onmessage = async ({ data }) => {
  const { audio, sampleRate } = data;
  try {
    self.postMessage({ type: 'status', message: 'Loading speech model. The first run may take a few minutes…' });
    transcriber ??= await pipeline('automatic-speech-recognition', 'Xenova/whisper-base', {
      progress_callback: ({ status, progress }) => {
        if (status === 'progress' && Number.isFinite(progress)) {
          self.postMessage({ type: 'status', message: `Loading speech model ${Math.round(progress)}%…` });
          self.postMessage({ type: 'progress', stage: 'Downloading model file', percent: progress });
        }
      },
    });
    self.postMessage({ type: 'status', message: 'Recognizing speech…' });
    const windowSize = sampleRate * 30;
    const overlap = sampleRate * 5;
    const step = windowSize - overlap;
    const total = Math.max(1, Math.ceil((audio.length - overlap) / step));
    const chunks = [];
    const started = performance.now();
    self.postMessage({ type: 'progress', stage: 'Transcribing video', percent: 0 });
    for (let index = 0; index < total; index++) {
      const start = index * step;
      const end = Math.min(audio.length, start + windowSize);
      const result = await transcriber(audio.subarray(start, end), {
        sampling_rate: sampleRate,
        return_timestamps: true,
        task: 'transcribe',
      });
      const keepFrom = index === 0 ? 0 : start / sampleRate + overlap / sampleRate / 2;
      const keepUntil = index === total - 1 ? Infinity : (start + windowSize - overlap / 2) / sampleRate;
      for (const chunk of result.chunks || []) {
        const chunkStart = start / sampleRate + (chunk.timestamp?.[0] ?? 0);
        const chunkEnd = start / sampleRate + (chunk.timestamp?.[1] ?? (end - start) / sampleRate);
        const midpoint = (chunkStart + chunkEnd) / 2;
        if (midpoint >= keepFrom && midpoint < keepUntil) {
          chunks.push({ text: chunk.text, timestamp: [chunkStart, chunkEnd] });
        }
      }
      const completed = index + 1;
      const remaining = (performance.now() - started) / 1000 / completed * (total - completed);
      self.postMessage({ type: 'progress', stage: 'Transcribing video', percent: completed / total * 100, eta: completed < total ? formatRemaining(remaining) : '' });
    }
    self.postMessage({ type: 'result', result: { chunks, text: chunks.map((chunk) => chunk.text).join(' ').trim() } });
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || 'Try another video.' });
  }
};
