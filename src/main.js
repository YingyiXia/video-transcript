import './style.css';
import { Input, ALL_FORMATS, BlobSource, AudioSampleSink } from 'mediabunny';

const fileInput = document.querySelector('#file-input');
const dropZone = document.querySelector('#drop-zone');
const video = document.querySelector('#video');
const changeFile = document.querySelector('#change-file');
const fileMeta = document.querySelector('#file-meta');
const transcribeButton = document.querySelector('#transcribe');
const copyButton = document.querySelector('#copy');
const exportButton = document.querySelector('#export');
const status = document.querySelector('#status');
const empty = document.querySelector('#transcript-empty');
const list = document.querySelector('#transcript-list');
const lineCount = document.querySelector('#line-count');

let selectedFile;
let videoUrl;
let segments = [];
let activeIndex = -1;
let worker;

function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(seconds || 0));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function setFile(file) {
  if (!file || !file.type.startsWith('video/')) {
    status.textContent = 'Choose a video file.';
    return;
  }
  worker?.terminate();
  worker = undefined;
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

async function extractAudio(file) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const track = await input.getPrimaryAudioTrack();
  if (!track || !await track.canDecode()) throw new Error('Audio track unavailable');
  const sink = new AudioSampleSink(track);
  const chunks = [];
  let totalFrames = 0;
  for await (const sample of sink.samples()) {
    const buffer = sample.toAudioBuffer();
    const mono = new Float32Array(buffer.length);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const values = buffer.getChannelData(channel);
      for (let frame = 0; frame < values.length; frame++) mono[frame] += values[frame] / buffer.numberOfChannels;
    }
    chunks.push(mono);
    totalFrames += mono.length;
    sample.close();
  }
  if (!totalFrames) throw new Error('No audio samples');
  const context = new AudioContext();
  try {
    const buffer = context.createBuffer(1, totalFrames, await track.getSampleRate());
    let offset = 0;
    for (const chunk of chunks) {
      buffer.getChannelData(0).set(chunk, offset);
      offset += chunk.length;
    }
    const length = Math.ceil(buffer.duration * 16000);
    const offline = new OfflineAudioContext(1, length, 16000);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0).slice();
  } finally {
    await context.close();
  }
}

async function transcribe() {
  if (!selectedFile) return;
  transcribeButton.disabled = true;
  transcribeButton.textContent = 'Transcribing…';
  status.textContent = 'Reading audio from video…';
  try {
    const audio = await extractAudio(selectedFile);
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'status') status.textContent = data.message;
      if (data.type === 'error') {
        status.textContent = `Transcription failed: ${data.message}`;
        transcribeButton.disabled = false;
        transcribeButton.textContent = 'Try again';
        worker?.terminate();
        worker = undefined;
      }
      if (data.type === 'result') {
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
      status.textContent = 'Transcription failed. Try again.';
      transcribeButton.disabled = false;
      transcribeButton.textContent = 'Try again';
      worker?.terminate();
      worker = undefined;
    };
    worker.postMessage({ audio, sampleRate: 16000 }, [audio.buffer]);
  } catch (error) {
    status.textContent = 'Could not read audio. Try an MP4 (H.264/AAC) or WebM file.';
    transcribeButton.disabled = false;
    transcribeButton.textContent = 'Try again';
  }
}

function transcriptText() {
  return segments.map((segment) => `[${formatTime(segment.start)}] ${segment.text}`).join('\n');
}

fileInput.addEventListener('change', () => setFile(fileInput.files[0]));
changeFile.addEventListener('click', () => fileInput.click());
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
