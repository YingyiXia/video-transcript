import './style.css';
import { Input, ALL_FORMATS, BlobSource, AudioSampleSink } from 'mediabunny';
import { toSrt } from './subtitles.js';

const fileInput = document.querySelector('#file-input');
const dropZone = document.querySelector('#drop-zone');
const video = document.querySelector('#video');
const changeFile = document.querySelector('#change-file');
const fileMeta = document.querySelector('#file-meta');
const transcribeButton = document.querySelector('#transcribe');
const copyButton = document.querySelector('#copy');
const exportButton = document.querySelector('#export');
const exportSrtButton = document.querySelector('#export-srt');
const status = document.querySelector('#status');
const empty = document.querySelector('#transcript-empty');
const list = document.querySelector('#transcript-list');
const lineCount = document.querySelector('#line-count');
const progressWrap = document.querySelector('#progress-wrap');
const progressStage = document.querySelector('#progress-stage');
const progressValue = document.querySelector('#progress-value');
const progressBar = document.querySelector('#progress-bar');
const progressEta = document.querySelector('#progress-eta');
const modeInputs = document.querySelectorAll('input[name="audio-mode"]');
const modeOptions = document.querySelector('.mode-options');

let selectedFile;
let videoUrl;
let segments = [];
let activeIndex = -1;
let worker;
let runId = 0;
let cancelPendingChunk;

function setProgress(stage, percent, eta = '') {
  progressWrap.hidden = false;
  progressStage.textContent = stage;
  progressValue.textContent = Number.isFinite(percent) ? `${Math.round(percent)}%` : '';
  if (Number.isFinite(percent)) {
    const value = Math.max(0, Math.min(100, percent));
    progressBar.classList.remove('indeterminate');
    progressBar.style.setProperty('--progress', `${value}%`);
    progressBar.setAttribute('aria-valuenow', String(Math.round(value)));
  } else {
    progressBar.classList.add('indeterminate');
    progressBar.removeAttribute('aria-valuenow');
  }
  progressEta.textContent = eta;
}

function hideProgress() {
  progressWrap.hidden = true;
  progressBar.classList.remove('indeterminate');
  progressBar.style.setProperty('--progress', '0%');
  progressBar.removeAttribute('aria-valuenow');
  progressEta.textContent = '';
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(seconds || 0));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function setFile(file) {
  if (!file || !file.type.startsWith('video/')) {
    status.textContent = 'Choose a video file.';
    return;
  }
  runId++;
  cancelPendingChunk?.();
  worker?.terminate();
  worker = undefined;
  hideProgress();
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  selectedFile = file;
  videoUrl = URL.createObjectURL(file);
  video.src = videoUrl;
  video.hidden = false;
  dropZone.hidden = true;
  changeFile.hidden = false;
  fileMeta.textContent = file.name;
  segments = [];
  activeIndex = -1;
  list.replaceChildren();
  list.hidden = true;
  empty.hidden = false;
  lineCount.textContent = 'Ready to transcribe';
  status.textContent = 'Video ready.';
  transcribeButton.disabled = false;
  transcribeButton.textContent = 'Transcribe';
  copyButton.disabled = true;
  exportButton.disabled = true;
  exportSrtButton.disabled = true;
}

function renderSegments() {
  list.replaceChildren();
  segments.forEach((segment, index) => {
    const row = document.createElement('div');
    row.className = 'segment';
    row.setAttribute('role', 'listitem');
    row.dataset.index = String(index);
    const time = document.createElement('button');
    time.className = 'segment-time';
    time.type = 'button';
    time.setAttribute('aria-label', `Jump to ${formatTime(segment.start)}`);
    time.textContent = formatTime(segment.start);
    const words = document.createElement('span');
    words.className = 'segment-text';
    words.textContent = segment.text;
    const seek = () => {
      video.currentTime = segment.start;
      video.play().catch(() => {});
      syncActive();
    };
    time.addEventListener('click', seek);
    words.addEventListener('click', () => {
      if (window.getSelection()?.toString()) return;
      seek();
    });
    row.append(time, words);
    list.append(row);
  });
  empty.hidden = true;
  list.hidden = false;
  lineCount.textContent = `${segments.length} ${segments.length === 1 ? 'segment' : 'segments'}`;
  copyButton.disabled = false;
  exportButton.disabled = false;
  exportSrtButton.disabled = false;
}

function syncActive() {
  if (!segments.length) return;
  const time = video.currentTime;
  let next = segments.findIndex((segment) => time >= segment.start && time < segment.end);
  if (next < 0) next = segments.findLastIndex((segment) => segment.start <= time);
  if (next === activeIndex) return;
  list.children[activeIndex]?.classList.remove('active');
  activeIndex = next;
  const element = list.children[next];
  element?.classList.add('active');
  if (element && !video.paused) element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function* extractAudioChunks(file, music = false) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const track = await input.getPrimaryAudioTrack();
  if (!track || !await track.canDecode()) throw new Error('Audio track unavailable');
  const sink = new AudioSampleSink(track);
  const inputRate = await track.getSampleRate();
  const totalDuration = await track.getDurationFromMetadata() || video.duration || 0;
  const targetFrames = inputRate * 20;
  let chunks = [];
  let frames = 0;
  let chunkStart = 0;
  let foundAudio = false;

  async function renderChunk() {
    const channels = music ? 2 : 1;
    const sourceBuffer = new AudioBuffer({ length: frames, numberOfChannels: channels, sampleRate: inputRate });
    let offset = 0;
    for (const [left, right] of chunks) {
      sourceBuffer.getChannelData(0).set(left, offset);
      if (music) sourceBuffer.getChannelData(1).set(right, offset);
      offset += left.length;
    }
    const sampleRate = music ? 44100 : 16000;
    const offline = new OfflineAudioContext(channels, Math.ceil(sourceBuffer.duration * sampleRate), sampleRate);
    const source = offline.createBufferSource();
    source.buffer = sourceBuffer;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return {
      audio: music ? [rendered.getChannelData(0).slice(), rendered.getChannelData(1).slice()] : rendered.getChannelData(0).slice(),
      start: chunkStart,
      duration: frames / inputRate,
      totalDuration,
    };
  }

  for await (const sample of sink.samples()) {
    const buffer = sample.toAudioBuffer();
    if (!frames) chunkStart = sample.timestamp;
    const left = new Float32Array(buffer.length);
    const right = music ? (buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : buffer.getChannelData(0).slice()) : null;
    if (music) left.set(buffer.getChannelData(0));
    else for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const values = buffer.getChannelData(channel);
      for (let frame = 0; frame < values.length; frame++) left[frame] += values[frame] / buffer.numberOfChannels;
    }
    chunks.push([left, right]);
    frames += left.length;
    foundAudio = true;
    sample.close();
    if (frames >= targetFrames) {
      yield await renderChunk();
      chunks = [];
      frames = 0;
    }
  }
  if (frames) yield await renderChunk();
  if (!foundAudio) throw new Error('No audio samples');
}

async function transcribe() {
  if (!selectedFile) return;
  const thisRun = ++runId;
  const music = document.querySelector('input[name="audio-mode"]:checked').value === 'music';
  transcribeButton.disabled = true;
  transcribeButton.textContent = 'Transcribing…';
  status.textContent = 'Reading audio from video…';
  setProgress('Preparing audio', NaN);
  const currentWorker = music
    ? new Worker(new URL('./music-worker.js', import.meta.url), { type: 'module' })
    : new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker = currentWorker;
  const allSegments = [];
  let processed = 0;
  try {
    for await (const part of extractAudioChunks(selectedFile, music)) {
      if (thisRun !== runId) return;
      const result = await new Promise((resolve, reject) => {
        cancelPendingChunk = () => reject(new Error('Cancelled'));
        currentWorker.onmessage = ({ data }) => {
          if (data.type === 'status') status.textContent = data.message;
          if (data.type === 'progress') {
            const isModelDownload = data.stage?.startsWith('Downloading');
            const percent = isModelDownload ? data.percent : part.totalDuration
              ? (processed + part.duration * (Number.isFinite(data.percent) ? data.percent / 100 : 0)) / part.totalDuration * 100
              : NaN;
            setProgress(isModelDownload ? data.stage : 'Transcribing video', percent, data.eta || '');
          }
          if (data.type === 'error') reject(new Error(data.message));
          if (data.type === 'result') resolve(data.result);
        };
        currentWorker.onerror = () => reject(new Error('The transcription worker stopped unexpectedly.'));
        const { audio } = part;
        if (music) currentWorker.postMessage({ audio, sampleRate: 44100 }, audio.map((channel) => channel.buffer));
        else currentWorker.postMessage({ audio, sampleRate: 16000 }, [audio.buffer]);
      });
      if (thisRun === runId) cancelPendingChunk = undefined;
      if (thisRun !== runId) return;
      const newSegments = (result.chunks || []).map((chunk) => ({
        start: Math.max(0, part.start + (Number(chunk.timestamp?.[0]) || 0)),
        end: Math.max(0, part.start + (Number(chunk.timestamp?.[1]) || part.duration)),
        text: chunk.text.trim(),
      })).filter((chunk) => chunk.text);
      if (!newSegments.length && result.text?.trim()) newSegments.push({ start: part.start, end: part.start + part.duration, text: result.text.trim() });
      allSegments.push(...newSegments);
      processed += part.duration;
      setProgress('Transcribing video', part.totalDuration ? processed / part.totalDuration * 100 : NaN);
    }
    if (thisRun !== runId) return;
    segments = allSegments;
    hideProgress();
    if (segments.length) {
      renderSegments();
      status.textContent = 'Transcript ready.';
      syncActive();
    } else status.textContent = 'No speech found. Try another video.';
    transcribeButton.textContent = 'Transcribe again';
  } catch (error) {
    if (thisRun !== runId) return;
    status.textContent = `Transcription failed: ${error?.message || 'Could not read audio. Try an MP4 or WebM file.'}`;
    hideProgress();
    transcribeButton.textContent = 'Try again';
  } finally {
    if (thisRun === runId) cancelPendingChunk = undefined;
    currentWorker.terminate();
    if (worker === currentWorker) worker = undefined;
    if (thisRun === runId) transcribeButton.disabled = false;
  }
}

function transcriptText() {
  return segments.map((segment) => `[${formatTime(segment.start)}] ${segment.text}`).join('\n');
}

fileInput.addEventListener('change', () => setFile(fileInput.files[0]));
changeFile.addEventListener('click', () => fileInput.click());
modeInputs.forEach((input) => input.addEventListener('change', () => {
  if (!input.checked) return;
  modeOptions.dataset.mode = input.value;
  runId++;
  cancelPendingChunk?.();
  worker?.terminate();
  worker = undefined;
  hideProgress();
  transcribeButton.disabled = !selectedFile;
  transcribeButton.textContent = 'Transcribe';
  if (selectedFile) status.textContent = input.value === 'music' ? 'Music mode ready. Vocals will be separated first.' : 'Speech mode ready.';
}));
dropZone.addEventListener('dragover', (event) => { event.preventDefault(); dropZone.classList.add('dragging'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
  setFile(event.dataTransfer.files[0]);
});
video.addEventListener('timeupdate', syncActive);
transcribeButton.addEventListener('click', transcribe);
copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(transcriptText());
    status.textContent = 'Transcript copied.';
  } catch {
    status.textContent = 'Could not copy. Try Export .txt.';
  }
});
exportButton.addEventListener('click', () => {
  const blob = new Blob([transcriptText()], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${selectedFile.name.replace(/\.[^.]+$/, '')}-transcript.txt`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status.textContent = 'Transcript exported.';
});
exportSrtButton.addEventListener('click', () => {
  const blob = new Blob([toSrt(segments, video.duration)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${selectedFile.name.replace(/\.[^.]+$/, '')}-subtitles.srt`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status.textContent = 'SRT subtitles exported.';
});
