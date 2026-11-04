import { env, pipeline } from '@huggingface/transformers';

env.backends.onnx.wasm.numThreads = 1;

let transcriber;

self.onmessage = async ({ data }) => {
  const { audio, sampleRate } = data;
  try {
    self.postMessage({ type: 'status', message: 'Loading speech model. The first run may take a few minutes…' });
    transcriber ??= await pipeline('automatic-speech-recognition', 'Xenova/whisper-base', {
      progress_callback: ({ status, progress }) => {
        if (status === 'progress' && Number.isFinite(progress)) {
          self.postMessage({ type: 'status', message: `Loading speech model ${Math.round(progress)}%…` });
        }
      },
    });
    self.postMessage({ type: 'status', message: 'Recognizing speech…' });
    const result = await transcriber(audio, {
      sampling_rate: sampleRate,
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      task: 'transcribe',
    });
    self.postMessage({ type: 'result', result });
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || 'Try another video.' });
  }
};
