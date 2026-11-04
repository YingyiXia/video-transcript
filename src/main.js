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

let selectedFile;
let videoUrl;
let segments = [];
let activeIndex = -1;
let worker;
let runId = 0;

function setProgress(stage, percent, eta = '') {
  progressWrap.hidden = false;
  progressStage.textContent = stage;
  progressValue.textContent = Number.isFinite(percent) ? `${Math.round(percent)}%` : '';
  if (Number.isFinite(percent)) progressBar.value = Math.max(0, Math.min(100, percent));
  else progressBar.removeAttribute('value');
  progressEta.textContent = eta;
}

function hideProgress() {
  progressWrap.hidden = true;
  progressBar.removeAttribute('value');
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

async function extractAudio(file, music = false) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const track = await input.getPrimaryAudioTrack();
  if (!track || !await track.canDecode()) throw new Error('Audio track unavailable');
  const sink = new AudioSampleSink(track);
  const chunks = [];
  let totalFrames = 0;
  for await (const sample of sink.samples()) {
    const buffer = sample.toAudioBuffer();
    const left = buffer.getChannelData(0).slice();
    const right = (buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0)).slice();
    chunks.push([left, right]);
    totalFrames += left.length;
    sample.close();
  }
  if (!totalFrames) throw new Error('No audio samples');
  const context = new AudioContext();
  try {
    const buffer = context.createBuffer(2, totalFrames, await track.getSampleRate());
    let offset = 0;
    for (const [left, right] of chunks) {
      buffer.getChannelData(0).set(left, offset);
      buffer.getChannelData(1).set(right, offset);
      offset += left.length;
    }
    const sampleRate = music ? 44100 : 16000;
    const offline = new OfflineAudioContext(music ? 2 : 1, Math.ceil(buffer.duration * sampleRate), sampleRate);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return music ? [rendered.getChannelData(0).slice(), rendered.getChannelData(1).slice()] : rendered.getChannelData(0).slice();
  } finally {
    await context.close();
  }
}

async function transcribe() {
  if (!selectedFile) return;
  const thisRun = ++runId;
  const music = document.querySelector('input[name="audio-mode"]:checked').value === 'music';
  transcribeButton.disabled = true;
  transcribeButton.textContent = 'Transcribing…';
  status.textContent = 'Reading audio from video…';
  setProgress('Preparing audio', NaN);
  try {
    const audio = await extractAudio(selectedFile, music);
    if (thisRun !== runId) return;
    setProgress(music ? 'Loading vocals model' : 'Loading speech model', NaN);
    worker = music
      ? new Worker(new URL('./music-worker.js', import.meta.url), { type: 'module' })
      : new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (thisRun !== runId) return;
      if (data.type === 'status') status.textContent = data.message;
      if (data.type === 'progress') setProgress(data.stage, data.percent, data.eta || '');
      if (data.type === 'error') {
        status.textContent = `Transcription failed: ${data.message}`;
        hideProgress();
        transcribeButton.disabled = false;
        transcribeButton.textContent = 'Try again';
        worker?.terminate();
        worker = undefined;
      }
      if (data.type === 'result') {
        hideProgress();
        segments = (data.result.chunks || [])
          .map((chunk) => ({ start: Number(chunk.timestamp?.[0]) || 0, end: Number(chunk.timestamp?.[1]) || video.duration || 0, text: chunk.text.trim() }))
          .filter((chunk) => chunk.text);
        if (!segments.length && data.result.text?.trim()) {
          segments = [{ start: 0, end: video.duration || 0, text: data.result.text.trim() }];
        }
        if (segments.length) {
          renderSegments();
          status.textContent = 'Transcript ready.';
          syncActive();
        } else {
          status.textContent = 'No speech found. Try another video.';
        }
        transcribeButton.disabled = false;
        transcribeButton.textContent = 'Transcribe again';
        worker?.terminate();
        worker = undefined;
      }
    };
    worker.onerror = () => {
      if (thisRun !== runId) return;
      status.textContent = 'Transcription failed. Try again.';
      hideProgress();
      transcribeButton.disabled = false;
      transcribeButton.textContent = 'Try again';
      worker?.terminate();
      worker = undefined;
    };
    if (music) worker.postMessage({ audio, sampleRate: 44100 }, audio.map((channel) => channel.buffer));
    else worker.postMessage({ audio, sampleRate: 16000 }, [audio.buffer]);
  } catch (error) {
    if (thisRun !== runId) return;
    status.textContent = 'Could not read audio. Try an MP4 (H.264/AAC) or WebM file.';
    hideProgress();
    transcribeButton.disabled = false;
    transcribeButton.textContent = 'Try again';
  }
}

function transcriptText() {
  return segments.map((segment) => `[${formatTime(segment.start)}] ${segment.text}`).join('\n');
}

fileInput.addEventListener('change', () => setFile(fileInput.files[0]));
changeFile.addEventListener('click', () => fileInput.click());
modeInputs.forEach((input) => input.addEventListener('change', () => {
  runId++;
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
