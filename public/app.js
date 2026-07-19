/* Interview Transcriber — client logic.
   Flow: drop file → transcribe via a backend (local proxy, direct Soniox REST, or mock)
   → render tokens as word spans. Words: click/drag to select, floating toolbar to edit
   (edited = red), double-click to seek the media, current word highlighted during playback.
   Playback runs through one <video> element ("media") for both audio and video: dropping
   a video onto a transcribed session attaches it — synced, never re-transcribed.
   Sessions (transcript + edits + media + position) persist in the browser via sessions.js. */

'use strict';

const $ = (id) => document.getElementById(id);

const dropzone = $('dropzone');
const fileInput = $('fileInput');
const workspace = $('workspace');
const transcript = $('transcript');
const media = $('media');
const videoWrap = $('videoWrap');
const statusChip = $('statusChip');
const edittools = $('edittools');
const seekBar = $('seek');

const MOCK = new URLSearchParams(location.search).has('mock');
const DIRECT = !!window.__DIRECT__; // set by build.js in the single-file microsite build
const SONIOX_BASE = 'https://api.soniox.com';
const DIRECT_MODEL = 'stt-async-v5';

const LS_KEY = 'soniox-transcriber:key';
const LS_POS = 'soniox-transcriber:pos:';

// migrate the pre-namespacing key name
try {
  const legacy = localStorage.getItem('sonioxKey');
  if (legacy && !localStorage.getItem(LS_KEY)) localStorage.setItem(LS_KEY, legacy);
  if (legacy) localStorage.removeItem('sonioxKey');
} catch {}

let CFG = { hasServerKey: false, model: '' };

const S = {
  file: null,
  fileName: null,
  fileSize: null,
  audioURL: null,
  tid: null,
  fid: null,
  ready: false,
  xhr: null,
  elapsedTimer: null,
  wordEls: [],
  times: [],
  dirty: true,
  selected: new Set(),
  anchor: null,
  editing: null,
  editGroups: new Map(), // gid -> { nodes: [original spans], text }
  gidNext: 1,
  edits: 0,
  speakerNames: new Map(),
  follow: true,
  followPausedUntil: 0,
  // session persistence
  sessionId: null,
  audioStored: false,
  needsAudio: false,
  savedDuration: 0,
  saveTimer: null,
  savePending: false,
  lastPosSave: 0,
  // video
  mainIsVideo: false,   // the transcribed file itself was a video
  videoAttached: false, // a separate video is the current playback source
  videoStored: false,
  videoName: null,
  videoSize: 0,
  videoPanelSize: 'md',
};

/* ================= helpers ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toast(msg, isErr) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  $('toasts').append(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3600);
}

function fmtTime(sec) {
  if (!isFinite(sec)) return '0:00';
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
           : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtSize(bytes) {
  return bytes > 1024 * 1024 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.ceil(bytes / 1024) + ' KB';
}

function fmtAgo(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + ' min ago';
  const h = Math.round(min / 60);
  if (h < 24) return h + ' h ago';
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : d + ' days ago';
}

function getKey() {
  try { return localStorage.getItem(LS_KEY) || ''; } catch { return ''; }
}

function apiHeaders() {
  const h = {};
  const k = getKey();
  if (k && !CFG.hasServerKey) h['x-soniox-key'] = k;
  return h;
}

function httpErr(status, msg) {
  return Object.assign(new Error(msg || `HTTP ${status}`), { status });
}

async function fetchJSON(url, init) {
  const r = await fetch(url, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw httpErr(r.status, d.error || d.message || d.error_message);
  return d;
}

function isVideoFile(file) {
  return /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name) || (file.type || '').startsWith('video/');
}

/* ================= backends ================= */

function xhrUpload({ url, headers, body, onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    S.xhr = xhr;
    xhr.open('POST', url);
    for (const k in headers) xhr.setRequestHeader(k, headers[k]);
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener('load', () => {
      S.xhr = null;
      let d = {};
      try { d = JSON.parse(xhr.responseText || '{}'); } catch {}
      if (xhr.status < 200 || xhr.status >= 300) {
        return reject(httpErr(xhr.status, d.error || d.message));
      }
      resolve(d);
    });
    xhr.addEventListener('error', () => { S.xhr = null; reject(new Error('Network error during upload')); });
    xhr.addEventListener('abort', () => { S.xhr = null; reject(Object.assign(new Error('aborted'), { aborted: true })); });
    xhr.send(body);
  });
}

const proxyBackend = {
  async start(file, opts, onProgress) {
    const params = new URLSearchParams();
    if (opts.diarization) params.set('diarization', '1');
    if (opts.languageHints) params.set('language_hints', opts.languageHints);
    const d = await xhrUpload({
      url: '/api/transcribe?' + params.toString(),
      headers: { 'x-filename': encodeURIComponent(file.name), ...apiHeaders() },
      body: file,
      onProgress,
    }).catch((err) => {
      if (err && !err.status && !err.aborted) err.message = 'Network error — is the local server still running?';
      throw err;
    });
    return { tid: d.transcription_id, fid: d.file_id };
  },
  status(tid) { return fetchJSON(`/api/transcriptions/${tid}`, { headers: apiHeaders() }); },
  transcript(tid) { return fetchJSON(`/api/transcriptions/${tid}/transcript`, { headers: apiHeaders() }); },
  cleanup(tid, fid) {
    return fetch('/api/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...apiHeaders() },
      body: JSON.stringify({ transcription_id: tid, file_id: fid }),
    }).catch(() => {});
  },
};

async function sonioxJSON(method, path, body) {
  const r = await fetch(SONIOX_BASE + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + getKey(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let d = {};
  try { d = text ? JSON.parse(text) : {}; } catch {}
  if (!r.ok) throw httpErr(r.status, d.message || d.error);
  return d;
}

const directBackend = {
  async start(file, opts, onProgress) {
    const key = getKey();
    if (!key) throw httpErr(401, 'Add your Soniox API key first (top right)');
    const form = new FormData();
    form.append('file', file, file.name);
    const up = await xhrUpload({
      url: SONIOX_BASE + '/v1/files',
      headers: { Authorization: 'Bearer ' + key },
      body: form,
      onProgress,
    });
    try {
      const body = { model: DIRECT_MODEL, file_id: up.id };
      if (opts.diarization) body.enable_speaker_diarization = true;
      const hints = (opts.languageHints || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (hints.length) body.language_hints = hints;
      const job = await sonioxJSON('POST', '/v1/transcriptions', body);
      return { tid: job.id, fid: up.id };
    } catch (err) {
      sonioxJSON('DELETE', '/v1/files/' + up.id).catch(() => {});
      throw err;
    }
  },
  status(tid) { return sonioxJSON('GET', '/v1/transcriptions/' + tid); },
  transcript(tid) { return sonioxJSON('GET', `/v1/transcriptions/${tid}/transcript`); },
  async cleanup(tid, fid) {
    try { await sonioxJSON('DELETE', '/v1/transcriptions/' + tid); } catch {}
    try { if (fid) await sonioxJSON('DELETE', '/v1/files/' + fid); } catch {}
  },
};

/* ---- mock backend: canned two-speaker interview, timed to the loaded media ---- */

const MOCK_DIALOGUE = [
  ['1', 'Thanks for making time today. To start, could you tell me a little about your background?'],
  ['2', 'Of course. I spent the last six years building data pipelines, first at a bank and then at a small startup in Austin.'],
  ['1', 'Interesting. What drew you to the startup world?'],
  ['2', 'Honestly, the pace. Decisions that took a quarter now happen in a week, and I really love that energy.'],
  ['1', 'And what would you say is the accomplishment you are most proud of?'],
  ['2', 'We rebuilt the reporting stack around streaming data. Latency dropped from a day to about five minutes, and adoption tripled.'],
];

function mockTokens(durationMs) {
  const totalChars = MOCK_DIALOGUE.reduce((a, [, s]) => a + s.length, 0);
  const gap = 2600;
  const lead = 350;
  const speakable = Math.max(5000, durationMs - lead - gap * (MOCK_DIALOGUE.length - 1));
  const tokens = [];
  let t = lead;
  for (const [speaker, sentence] of MOCK_DIALOGUE) {
    const sentenceMs = (sentence.length / totalChars) * speakable;
    for (const raw of sentence.split(' ')) {
      const m = raw.match(/^(.+?)([.,?!]+)$/);
      const core = m ? m[1] : raw;
      const punct = m ? m[2] : null;
      const wDur = Math.max(110, (raw.length / sentence.length) * sentenceMs * 0.86);
      const leadSpace = tokens.length ? ' ' : '';
      const conf = +(0.7 + ((tokens.length * 7) % 28) / 100).toFixed(2);
      if (core.length > 8) { // mirror Soniox sub-word pieces
        const cut = Math.ceil(core.length / 2);
        tokens.push({ text: leadSpace + core.slice(0, cut), start_ms: Math.round(t), end_ms: Math.round(t + wDur / 2), confidence: conf, speaker });
        tokens.push({ text: core.slice(cut), start_ms: Math.round(t + wDur / 2), end_ms: Math.round(t + wDur), confidence: conf, speaker });
      } else {
        tokens.push({ text: leadSpace + core, start_ms: Math.round(t), end_ms: Math.round(t + wDur), confidence: conf, speaker });
      }
      if (punct) tokens.push({ text: punct, start_ms: Math.round(t + wDur), end_ms: Math.round(t + wDur), confidence: 0.99, speaker });
      t += wDur + (sentenceMs / sentence.length) * raw.length * 0.14 + 55;
    }
    t += gap;
  }
  return { tokens };
}

const mockBackend = {
  async start(file, opts, onProgress) {
    for (let p = 0; p <= 1; p += 0.2) { onProgress(p); await sleep(80); }
    return { tid: 'mock', fid: null };
  },
  async status() { await sleep(900); return { status: 'completed' }; },
  async transcript() {
    const ms = isFinite(media.duration) && media.duration > 0 ? Math.round(media.duration * 1000) : 60000;
    return mockTokens(ms);
  },
  async cleanup() {},
};

function backend() {
  return MOCK ? mockBackend : (DIRECT ? directBackend : proxyBackend);
}

/* ================= API key pill ================= */

function refreshKeyPill() {
  const pill = $('keyPill');
  if (CFG.hasServerKey) {
    pill.classList.add('ok');
    $('keyPillText').textContent = 'API key · server .env';
  } else if (getKey()) {
    pill.classList.add('ok');
    $('keyPillText').textContent = 'API key · saved';
  } else {
    pill.classList.remove('ok');
    $('keyPillText').textContent = 'Add API key';
    $('keyArea').hidden = false;
  }
}

$('keyPill').addEventListener('click', () => {
  if (CFG.hasServerKey) return toast('Key is loaded from .env on the server');
  $('keyArea').hidden = !$('keyArea').hidden;
  if (!$('keyArea').hidden) $('keyInput').focus();
});

$('keySave').addEventListener('click', saveKey);
$('keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(); });

function saveKey() {
  const v = $('keyInput').value.trim();
  if (!v) return toast('Paste a Soniox API key first', true);
  try { localStorage.setItem(LS_KEY, v); } catch {}
  $('keyInput').value = '';
  $('keyArea').hidden = true;
  refreshKeyPill();
  toast('API key saved in this browser');
}

/* ================= file intake ================= */

['dragenter', 'dragover'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('over'); }));

// catch drops anywhere: new audio, replacement audio, or a video to attach
['dragover', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => e.preventDefault()));
window.addEventListener('drop', (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleFile(f);
});

dropzone.addEventListener('click', (e) => {
  if (e.target.closest('.opts, .linklike, input, label, .recent')) return;
  fileInput.click();
});
dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter') fileInput.click(); });
$('browseBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
  fileInput.value = '';
});

function handleFile(file) {
  const isVid = isVideoFile(file);
  const looksAudio = /\.(mp3|m4a|wav|flac|ogg|oga|aac|aiff?|opus|wma|amr)$/i.test(file.name)
    || (file.type || '').startsWith('audio/');
  if (!isVid && !looksAudio) return toast('That does not look like an audio or video file', true);

  // transcript already on screen + video dropped → attach it, never re-transcribe
  if (isVid && S.ready && S.sessionId) {
    attachVideo(file);
    return;
  }

  // resumed session waiting for its media, audio dropped → attach without re-transcribing
  if (S.needsAudio && S.sessionId) {
    if (file.size === S.fileSize ||
        confirm('This file differs in size from the original recording. Attach it anyway?')) {
      reattachAudio(file);
    }
    return;
  }

  // from here on this starts a NEW transcription session
  if (!workspace.hidden && S.savePending &&
      !confirm('Load a new file? Recent changes may not be saved yet.')) return;
  if (isVid && !confirm('Transcribe the audio track of this video with Soniox?')) return;

  resetSession();
  S.file = file;
  S.fileName = file.name;
  S.fileSize = file.size;
  S.mainIsVideo = isVid;
  S.audioURL = URL.createObjectURL(file);
  media.src = S.audioURL;

  $('fileName').textContent = file.name;
  $('fileMeta').textContent = fmtSize(file.size);
  dropzone.hidden = true;
  workspace.hidden = false;
  syncVideoUI();

  startTranscription();
}

$('newBtn').addEventListener('click', () => {
  if (S.savePending && !confirm('Start over? Recent changes may not be saved yet.')) return;
  resetSession();
  workspace.hidden = true;
  dropzone.hidden = false;
  renderSessionList();
});

function resetSession() {
  if (S.xhr) { try { S.xhr.abort(); } catch {} }
  clearInterval(S.elapsedTimer);
  clearTimeout(S.saveTimer);
  media.pause(); // fires 'pause' → savePosition() while sessionId is still set
  if (S.audioURL) URL.revokeObjectURL(S.audioURL);
  media.removeAttribute('src');
  media.load();
  Object.assign(S, {
    file: null, fileName: null, fileSize: null, audioURL: null, tid: null, fid: null,
    ready: false, xhr: null, elapsedTimer: null, wordEls: [], times: [], dirty: true,
    anchor: null, editing: null, gidNext: 1, edits: 0, followPausedUntil: 0,
    sessionId: null, audioStored: false, needsAudio: false, savedDuration: 0,
    saveTimer: null, savePending: false, lastPosSave: 0,
    mainIsVideo: false, videoAttached: false, videoStored: false,
    videoName: null, videoSize: 0, videoPanelSize: 'md',
  });
  S.selected.clear();
  S.editGroups.clear();
  S.speakerNames.clear();
  lastActive = null;
  transcript.innerHTML = '';
  hideTools();
  showReattachBanner(false);
  syncVideoUI();
  statusChip.hidden = true;
  $('copyBtn').disabled = $('downloadBtn').disabled = true;
  $('curTime').textContent = '0:00';
  $('durTime').textContent = '0:00';
  seekBar.value = 0;
  seekBar.style.setProperty('--p', '0%');
  setPlayIcon(false);
}

/* ================= video attach / remove ================= */

function syncVideoUI() {
  const showPanel = S.videoAttached || S.mainIsVideo;
  videoWrap.hidden = !showPanel;
  videoWrap.classList.toggle('sm', S.videoPanelSize === 'sm');
  $('addVideoBtn').hidden = showPanel || !S.sessionId || !S.ready;
  $('vidRemove').hidden = !S.videoAttached;
}

async function attachVideo(file) {
  const keepT = media.currentTime || (readPosition(S.sessionId) || {}).t || 0;
  const wasPlaying = !media.paused && !media.ended;

  if (S.audioURL) URL.revokeObjectURL(S.audioURL);
  S.audioURL = URL.createObjectURL(file);
  media.src = S.audioURL;
  S.videoAttached = true;
  S.videoName = file.name;
  S.videoSize = file.size;
  S.needsAudio = false;
  showReattachBanner(false);
  syncVideoUI();

  media.addEventListener('loadedmetadata', () => {
    if (keepT) seekTo(Math.min(keepT, media.duration || keepT));
    const ref = S.savedDuration || 0;
    if (ref && isFinite(media.duration) && Math.abs(media.duration - ref) > 3) {
      toast(`Heads up: video is ${fmtTime(media.duration)} but the transcript audio was ${fmtTime(ref)} — timings may drift`, true);
    }
    if (wasPlaying) media.play().catch(() => {});
  }, { once: true });

  S.videoStored = false;
  try {
    await Sessions.saveVideo(S.sessionId, file);
    S.videoStored = true;
  } catch {
    toast('Video too large to store for resume — it plays now but must be re-added after reload', true);
  }
  scheduleSave();
  toast('Video attached — playback and transcript stay in sync');
}

async function removeVideo() {
  if (!S.videoAttached) return;
  const keepT = media.currentTime || 0;
  try { await Sessions.removeVideo(S.sessionId); } catch {}
  S.videoAttached = false;
  S.videoStored = false;
  S.videoName = null;
  S.videoSize = 0;

  let blob = S.file; // in-memory original from this browser session
  if (!blob) {
    try { blob = await Sessions.getAudio(S.sessionId); } catch {}
  }
  if (S.audioURL) { URL.revokeObjectURL(S.audioURL); S.audioURL = null; }
  if (blob) {
    S.audioURL = URL.createObjectURL(blob);
    media.src = S.audioURL;
    media.addEventListener('loadedmetadata', () => seekTo(keepT), { once: true });
    toast('Video removed — audio playback restored');
  } else {
    media.removeAttribute('src');
    media.load();
    S.needsAudio = true;
    showReattachBanner(true);
    toast('Video removed — drop the original audio to play again', true);
  }
  syncVideoUI();
  scheduleSave();
}

$('addVideoBtn').addEventListener('click', () => $('videoInput').click());
$('vidReplace').addEventListener('click', () => $('videoInput').click());
$('videoInput').addEventListener('change', () => {
  const f = $('videoInput').files[0];
  if (f) {
    if (isVideoFile(f)) attachVideo(f);
    else toast('Pick a video file', true);
  }
  $('videoInput').value = '';
});
$('vidRemove').addEventListener('click', removeVideo);
$('vidSize').addEventListener('click', () => {
  S.videoPanelSize = S.videoPanelSize === 'sm' ? 'md' : 'sm';
  syncVideoUI();
  scheduleSave();
});
$('vidPip').addEventListener('click', async () => {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await media.requestPictureInPicture();
  } catch { toast('Picture-in-picture is not available here', true); }
});
$('vidFull').addEventListener('click', () => {
  try { media.requestFullscreen(); } catch { toast('Fullscreen is not available here', true); }
});
document.addEventListener('fullscreenchange', () => {
  media.toggleAttribute('controls', document.fullscreenElement === media);
});
media.addEventListener('click', () => {
  if (document.fullscreenElement === media) return; // native controls own the clicks there
  togglePlay();
});

/* ================= transcription pipeline ================= */

function chip(text, busy, error) {
  statusChip.hidden = false;
  statusChip.className = 'chip' + (error ? ' error' : '');
  statusChip.innerHTML = '';
  if (busy) {
    const sp = document.createElement('span');
    sp.className = 'mini-spin';
    statusChip.append(sp);
  }
  statusChip.append(document.createTextNode(text));
}

function showStage(title, opts = {}) {
  transcript.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'stage' + (opts.error ? ' error' : '');
  if (!opts.error) {
    const sp = document.createElement('div');
    sp.className = 'spinner';
    box.append(sp);
  }
  const h = document.createElement('h3');
  h.textContent = title;
  box.append(h);
  if (opts.bar) {
    const bar = document.createElement('div');
    bar.className = 'upbar';
    bar.innerHTML = '<div></div>';
    box.append(bar);
  }
  const sub = document.createElement('p');
  sub.className = 'substat';
  sub.textContent = opts.sub || '';
  box.append(sub);
  if (opts.retry) {
    const b = document.createElement('button');
    b.className = 'primary';
    b.textContent = 'Try again';
    b.addEventListener('click', startTranscription);
    box.append(b);
  }
  transcript.append(box);
  return { title: h, sub, bar: box.querySelector('.upbar > div') };
}

async function startTranscription() {
  if (!S.file) return;
  S.ready = false;
  const stage = showStage('Uploading — 0%', {
    bar: true,
    sub: DIRECT ? 'Sending audio to Soniox' : 'Sending audio to your local server → Soniox',
  });
  chip('Uploading 0%', true);
  try {
    const { tid, fid } = await backend().start(S.file, {
      diarization: $('optDiarize').checked,
      languageHints: $('optLangs').value.trim(),
    }, (frac) => {
      const pct = Math.round(frac * 100);
      stage.title.textContent = `Uploading — ${pct}%`;
      stage.bar.style.width = pct + '%';
      chip(`Uploading ${pct}%`, true);
    });
    S.tid = tid;
    S.fid = fid;
    await pollUntilDone();
  } catch (err) {
    if (err && err.aborted) return;
    if (err && err.status === 401 && !CFG.hasServerKey) { $('keyArea').hidden = false; $('keyInput').focus(); }
    fail(err.message);
  }
}

async function pollUntilDone() {
  const started = Date.now();
  const stage = showStage('Transcribing with Soniox…', { sub: 'Usually much faster than the recording itself' });
  chip('Transcribing', true);
  clearInterval(S.elapsedTimer);
  S.elapsedTimer = setInterval(() => {
    stage.sub.textContent = `Elapsed ${fmtTime((Date.now() - started) / 1000)}`;
  }, 1000);

  const token = S.tid; // if the user resets mid-poll, S.tid changes and we bail out
  while (true) {
    const d = await backend().status(S.tid);
    if (S.tid !== token) return;
    if (d.status === 'completed') break;
    if (d.status === 'error') throw new Error(d.error_message || 'Soniox could not transcribe this file');
    await sleep(1800);
    if (S.tid !== token) return;
  }
  clearInterval(S.elapsedTimer);
  const d = await backend().transcript(S.tid);
  if (S.tid !== token) return;
  renderTranscript(d.tokens || []);
  backend().cleanup(S.tid, S.fid);
  createSessionRecord();
}

function fail(msg) {
  clearInterval(S.elapsedTimer);
  if (workspace.hidden) return; // session was reset while work was in flight
  chip('Failed', false, true);
  showStage(msg || 'Something went wrong', { error: true, retry: true, sub: 'Nothing was saved — you can retry.' });
  toast(msg || 'Transcription failed', true);
}

/* ================= tokens → words → blocks ================= */

function tokensToWords(tokens) {
  const clean = tokens.filter((t) => t && t.text && !/^<.*>$/.test(t.text));
  const spaced = clean.some((t, i) => i > 0 && /^\s/.test(t.text));
  const isPunct = (s) => /^[.,!?;:…)\]}%»”’'"-]+$/.test(s.trim());
  const words = [];
  let cur = null;

  for (const t of clean) {
    const sp = t.speaker != null ? String(t.speaker) : null;
    const breaks = spaced ? /^\s/.test(t.text) : !isPunct(t.text);
    const spkChange = cur && sp !== null && cur.speaker !== null && sp !== cur.speaker;

    if (!cur || breaks || spkChange) {
      if (cur && cur.text) words.push(cur);
      cur = {
        text: (spaced ? t.text.trimStart() : t.text.trim()),
        s: t.start_ms ?? 0,
        e: t.end_ms ?? t.start_ms ?? 0,
        speaker: sp,
      };
      if (!cur.text) cur = null;
    } else {
      cur.text += (spaced ? t.text : t.text.trim());
      if (t.end_ms != null) cur.e = t.end_ms;
      if (cur.speaker == null && sp != null) cur.speaker = sp;
    }
  }
  if (cur && cur.text) words.push(cur);
  return words;
}

function groupBlocks(words) {
  const blocks = [];
  let b = null;
  let prevEnd = null;
  for (const w of words) {
    const spkChange = !b || w.speaker !== b.speaker;
    const pause = b && prevEnd != null && w.s - prevEnd > 2500;
    const tooLong = b && b.words.length >= 220;
    if (!b || spkChange || pause || tooLong) {
      b = { speaker: w.speaker, words: [] };
      blocks.push(b);
    }
    b.words.push(w);
    prevEnd = w.e;
  }
  return blocks;
}

function wordSpan(w) {
  const el = document.createElement('span');
  el.className = 'word';
  el.textContent = w.text;
  el.dataset.s = w.s;
  el.dataset.e = w.e;
  return el;
}

// serialized word ({t,s,e,gid?,title?}) → span, restoring edit marks
function restoreSpan(w) {
  const el = wordSpan({ text: w.t, s: w.s, e: w.e });
  if (w.gid) {
    el.dataset.gid = w.gid;
    el.classList.add('edited');
    if (w.title) el.title = w.title;
  }
  return el;
}

function displayName(spk) {
  return S.speakerNames.get(spk) || 'Speaker ' + spk;
}

// blocksData: [{spk, labeled, words: [{t,s,e,gid?,title?}]}] — shared by fresh
// transcription and session restore
function renderBlocks(blocksData) {
  transcript.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const b of blocksData) {
    const div = document.createElement('div');
    div.className = 'block';
    if (b.spk != null) {
      div.dataset.spk = b.spk;
      div.classList.add('spk-' + (((parseInt(b.spk, 10) || 1) - 1) % 5 + 1));
      if (b.labeled) {
        const label = document.createElement('div');
        label.className = 'spk-label';
        label.dataset.spk = b.spk;
        label.textContent = displayName(b.spk);
        label.title = 'Click to rename this speaker';
        div.append(label);
      }
    }
    const p = document.createElement('p');
    for (const w of b.words) p.append(restoreSpan(w), ' ');
    div.append(p);
    frag.append(div);
  }
  transcript.append(frag);
  S.dirty = true;
  ensureIndex();
}

function renderTranscript(tokens) {
  const words = tokensToWords(tokens);
  statusChip.hidden = true;

  if (!words.length) {
    transcript.innerHTML = '';
    showStage('No speech detected in this file', { error: true, retry: true });
    return;
  }

  const blocksData = [];
  let prevSpk = null;
  let first = true;
  for (const b of groupBlocks(words)) {
    blocksData.push({
      spk: b.speaker ?? null,
      labeled: b.speaker != null && (first || b.speaker !== prevSpk),
      words: b.words.map((w) => ({ t: w.text, s: w.s, e: w.e })),
    });
    prevSpk = b.speaker;
    first = false;
  }
  renderBlocks(blocksData);
  S.ready = true;
  $('copyBtn').disabled = $('downloadBtn').disabled = false;
  toast(`Transcribed — ${S.wordEls.length} words`);
}

function ensureIndex() {
  if (!S.dirty) return;
  S.wordEls = [...transcript.querySelectorAll('.word')];
  S.times = S.wordEls.map((el) => ({ s: +el.dataset.s, e: +el.dataset.e }));
  S.dirty = false;
}

/* ================= session persistence ================= */

function spanToData(el) {
  const d = { t: el.textContent, s: +el.dataset.s, e: +el.dataset.e };
  if (el.dataset.gid) {
    d.gid = el.dataset.gid;
    if (el.title) d.title = el.title;
  }
  return d;
}

function snapshotSession() {
  return {
    id: S.sessionId,
    fileName: S.fileName || 'audio',
    fileSize: S.fileSize || 0,
    duration: S.savedDuration || (isFinite(media.duration) && media.duration > 0 ? media.duration : 0),
    savedAt: Date.now(),
    options: { diarize: $('optDiarize').checked, langs: $('optLangs').value.trim() },
    speakerNames: [...S.speakerNames],
    blocks: [...transcript.querySelectorAll('.block')].map((block) => ({
      spk: block.dataset.spk ?? null,
      labeled: !!block.querySelector('.spk-label'),
      words: [...block.querySelectorAll('.word')].map(spanToData),
    })),
    editGroups: [...S.editGroups].map(([gid, g]) => [gid, { text: g.text, words: g.nodes.map(spanToData) }]),
    gidNext: S.gidNext,
    wordCount: S.wordEls.length,
    editCount: S.edits,
    hasAudio: S.audioStored,
    mainIsVideo: S.mainIsVideo,
    hasVideo: S.videoStored,
    videoName: S.videoName,
    videoSize: S.videoSize,
    videoPanelSize: S.videoPanelSize,
  };
}

function scheduleSave() {
  if (!S.sessionId || !S.ready) return;
  S.savePending = true;
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(flushSave, 600);
}

async function flushSave() {
  if (!S.sessionId || !S.ready || S.editing) return;
  clearTimeout(S.saveTimer);
  try {
    await Sessions.save(snapshotSession());
    S.savePending = false;
  } catch {
    /* stays pending; beforeunload will warn */
  }
}

function savePosition() {
  if (!S.sessionId) return;
  try {
    localStorage.setItem(LS_POS + S.sessionId,
      JSON.stringify({ t: media.currentTime || 0, rate: media.playbackRate || 1 }));
  } catch {}
}

function readPosition(id) {
  try { return JSON.parse(localStorage.getItem(LS_POS + id) || 'null'); } catch { return null; }
}

async function createSessionRecord() {
  S.sessionId = (crypto.randomUUID && crypto.randomUUID()) ||
    Date.now().toString(36) + Math.random().toString(36).slice(2);
  S.audioStored = false;
  if (S.file) {
    try {
      await Sessions.saveAudio(S.sessionId, S.file);
      S.audioStored = true;
    } catch {
      toast('Media could not be stored for resume (disk quota) — transcript is still saved', true);
    }
  }
  savePosition();
  syncVideoUI();
  S.savePending = true;
  await flushSave();
}

async function resumeSession(id) {
  let sess = null;
  try { sess = await Sessions.get(id); } catch {}
  if (!sess) {
    toast('Could not load that session', true);
    renderSessionList();
    return;
  }
  resetSession();
  S.sessionId = sess.id;
  S.fileName = sess.fileName;
  S.fileSize = sess.fileSize;
  S.savedDuration = sess.duration || 0;
  S.speakerNames = new Map(sess.speakerNames || []);
  S.editGroups = new Map((sess.editGroups || []).map(([gid, g]) =>
    [gid, { text: g.text, nodes: (g.words || []).map(restoreSpan) }]));
  S.gidNext = sess.gidNext || 1;
  S.edits = sess.editCount || 0;
  S.mainIsVideo = !!sess.mainIsVideo;
  S.videoPanelSize = sess.videoPanelSize || 'md';
  if (sess.options) {
    $('optDiarize').checked = !!sess.options.diarize;
    const langs = $('optLangs');
    langs.value = sess.options.langs || '';
    if (langs.selectedIndex < 0) langs.value = 'vi'; // saved hint not in the dropdown
  }

  $('fileName').textContent = sess.fileName;
  $('fileMeta').textContent = fmtSize(sess.fileSize || 0) + (sess.duration ? ' · ' + fmtTime(sess.duration) : '');
  $('durTime').textContent = fmtTime(sess.duration || 0);
  dropzone.hidden = true;
  workspace.hidden = false;

  renderBlocks(sess.blocks || []);
  S.ready = true;
  $('copyBtn').disabled = $('downloadBtn').disabled = false;

  const pos = readPosition(sess.id);
  if (pos && pos.rate) {
    media.playbackRate = pos.rate;
    $('speed').value = String(pos.rate);
  }

  // prefer the attached video as the playback source, then the main media blob
  let vblob = null;
  if (sess.hasVideo) {
    try { vblob = await Sessions.getVideo(sess.id); } catch {}
  }
  if (vblob) {
    S.videoAttached = true;
    S.videoStored = true;
    S.videoName = sess.videoName || null;
    S.videoSize = sess.videoSize || 0;
    attachAudioBlob(vblob, pos);
    toast('Session restored — video playback ready');
  } else {
    let blob = null;
    try { blob = await Sessions.getAudio(sess.id); } catch {}
    if (blob) {
      S.audioStored = true;
      attachAudioBlob(blob, pos);
      toast('Session restored');
    } else {
      S.audioStored = false;
      S.needsAudio = true;
      showReattachBanner(true);
      toast('Session restored — drop the original audio or video to enable playback');
    }
  }
  syncVideoUI();
}

function attachAudioBlob(blob, pos) {
  if (S.audioURL) URL.revokeObjectURL(S.audioURL);
  S.audioURL = URL.createObjectURL(blob);
  media.src = S.audioURL;
  if (pos && pos.t) {
    media.addEventListener('loadedmetadata', () => seekTo(pos.t), { once: true });
  }
  showReattachBanner(false);
}

async function reattachAudio(file) {
  S.needsAudio = false;
  S.fileSize = file.size;
  attachAudioBlob(file, readPosition(S.sessionId));
  try {
    await Sessions.saveAudio(S.sessionId, file);
    S.audioStored = true;
    scheduleSave();
  } catch {}
  toast('Audio re-attached');
}

function showReattachBanner(on) {
  $('reattach').hidden = !on;
}

async function renderSessionList() {
  const wrap = $('recentWrap');
  let sessions = [];
  try { sessions = await Sessions.list(); } catch {}
  if (!sessions.length) {
    wrap.hidden = true;
    return;
  }
  const ul = $('recentList');
  ul.innerHTML = '';
  for (const s of sessions) {
    const li = document.createElement('li');

    const open = document.createElement('button');
    open.className = 'recent-open';
    const name = document.createElement('strong');
    name.textContent = s.fileName;
    const meta = document.createElement('span');
    meta.textContent = [
      fmtAgo(s.savedAt),
      s.duration ? fmtTime(s.duration) : null,
      (s.wordCount || 0) + ' words',
      s.editCount ? s.editCount + ' edit' + (s.editCount > 1 ? 's' : '') : null,
      (s.hasVideo || s.mainIsVideo) ? 'video' : null,
      s.hasAudio ? null : 'media not stored',
    ].filter(Boolean).join(' · ');
    open.append(name, meta);
    open.addEventListener('click', (e) => { e.stopPropagation(); resumeSession(s.id); });

    const del = document.createElement('button');
    del.className = 'recent-del';
    del.title = 'Delete this saved session';
    del.textContent = '✕';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete saved session “${s.fileName}”?`)) return;
      try { await Sessions.remove(s.id); } catch {}
      try { localStorage.removeItem(LS_POS + s.id); } catch {}
      renderSessionList();
    });

    li.append(open, del);
    ul.append(li);
  }
  wrap.hidden = false;
}

window.addEventListener('pagehide', () => { savePosition(); flushSave(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { savePosition(); flushSave(); }
});

/* ================= player ================= */

let rafId = null;
let lastActive = null;

function setPlayIcon(playing) {
  // SVG elements have no `hidden` IDL property — must toggle the attribute
  $('iconPlay').toggleAttribute('hidden', playing);
  $('iconPause').toggleAttribute('hidden', !playing);
  $('playBtn').setAttribute('aria-label', playing ? 'Pause (Space)' : 'Play (Space)');
}

function togglePlay() {
  if (!media.src) return;
  media.paused ? media.play() : media.pause();
}

$('playBtn').addEventListener('click', togglePlay);
$('back5').addEventListener('click', () => seekTo(media.currentTime - 5));
$('fwd5').addEventListener('click', () => seekTo(media.currentTime + 5));
$('speed').addEventListener('change', (e) => {
  media.playbackRate = Number(e.target.value);
  savePosition();
});
$('followBtn').addEventListener('click', () => {
  S.follow = !S.follow;
  $('followBtn').classList.toggle('on', S.follow);
});

seekBar.addEventListener('input', () => {
  if (!isFinite(media.duration)) return;
  media.currentTime = (seekBar.value / 1000) * media.duration;
});

media.addEventListener('play', () => {
  setPlayIcon(true);
  if (!rafId) tickLoop();
});
media.addEventListener('pause', () => {
  setPlayIcon(false);
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  updatePlayerUI();
  savePosition();
});
media.addEventListener('timeupdate', () => {
  if (media.paused) { updateActive(); updatePlayerUI(); }
});
media.addEventListener('loadedmetadata', () => {
  // streaming containers (e.g. MediaRecorder webm) report Infinity — fall back to the transcript's duration
  const dur = isFinite(media.duration) && media.duration > 0 ? media.duration : S.savedDuration;
  $('durTime').textContent = fmtTime(dur);
  if (!S.videoAttached) {
    if (isFinite(media.duration) && media.duration > 0) S.savedDuration = media.duration;
    if (S.fileSize) $('fileMeta').textContent = `${fmtSize(S.fileSize)} · ${fmtTime(dur)}`;
  }
});

function tickLoop() {
  updateActive();
  updatePlayerUI();
  if (Date.now() - S.lastPosSave > 3000) {
    S.lastPosSave = Date.now();
    savePosition();
  }
  rafId = requestAnimationFrame(tickLoop);
}

function updatePlayerUI() {
  $('curTime').textContent = fmtTime(media.currentTime);
  if (isFinite(media.duration) && media.duration > 0) {
    const frac = media.currentTime / media.duration;
    seekBar.value = Math.round(frac * 1000);
    seekBar.style.setProperty('--p', (frac * 100).toFixed(2) + '%');
  }
}

function seekTo(sec) {
  if (!media.src) return;
  const max = isFinite(media.duration) ? media.duration : sec;
  media.currentTime = Math.min(Math.max(0, sec), max);
  updateActive();
  updatePlayerUI();
  savePosition();
}

function updateActive() {
  if (!S.ready) return;
  ensureIndex();
  const t = media.currentTime * 1000;
  let lo = 0, hi = S.times.length - 1, idx = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (S.times[m].s <= t) { idx = m; lo = m + 1; } else hi = m - 1;
  }
  let active = null;
  if (idx >= 0) {
    const cur = S.times[idx];
    const nextS = idx + 1 < S.times.length ? S.times[idx + 1].s : Infinity;
    if (t < Math.max(cur.e + 350, nextS)) active = S.wordEls[idx];
  }
  if (active !== lastActive) {
    if (lastActive) lastActive.classList.remove('active');
    if (active) active.classList.add('active');
    lastActive = active;
    if (active && S.follow && Date.now() > S.followPausedUntil && !S.selected.size && !S.editing) {
      const r = active.getBoundingClientRect();
      if (r.top < 150 || r.bottom > innerHeight - 110) {
        active.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }
}

['wheel', 'touchmove'].forEach((ev) =>
  window.addEventListener(ev, () => { S.followPausedUntil = Date.now() + 4000; }, { passive: true }));

/* ================= word selection ================= */

let drag = null;

function orderedSelection() {
  ensureIndex();
  return S.wordEls.filter((el) => S.selected.has(el));
}

function clearSel() {
  for (const el of S.selected) el.classList.remove('sel');
  S.selected.clear();
}

function addSel(el) {
  S.selected.add(el);
  el.classList.add('sel');
}

function selectRange(a, b, additive) {
  ensureIndex();
  let i = S.wordEls.indexOf(a);
  let j = S.wordEls.indexOf(b);
  if (i < 0 || j < 0) return;
  if (i > j) [i, j] = [j, i];
  if (!additive) clearSel();
  for (let k = i; k <= j; k++) addSel(S.wordEls[k]);
}

transcript.addEventListener('mousedown', (e) => {
  if (S.editing) return;
  const w = e.target.closest('.word');
  if (!w) return;
  e.preventDefault(); // keep native text selection off; words have their own selection
  if (e.detail > 1) return; // second click of a double-click
  drag = { start: w, last: w, moved: false, additive: e.metaKey || e.ctrlKey, shift: e.shiftKey };
});

transcript.addEventListener('mouseover', (e) => {
  if (!drag) return;
  const w = e.target.closest('.word');
  if (!w || w === drag.last) return;
  drag.moved = true;
  drag.last = w;
  selectRange(drag.start, w, drag.additive);
});

document.addEventListener('mouseup', (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.moved) {
    S.anchor = d.start;
    showTools();
    return;
  }
  const w = d.start;
  if (d.shift && S.anchor) {
    selectRange(S.anchor, w, false);
  } else if (d.additive) {
    if (S.selected.has(w)) { S.selected.delete(w); w.classList.remove('sel'); }
    else addSel(w);
    S.anchor = w;
  } else if (S.selected.size === 1 && S.selected.has(w)) {
    clearSel();
  } else {
    clearSel();
    addSel(w);
    S.anchor = w;
  }
  showTools();
});

// double-click a word → jump the media there
transcript.addEventListener('dblclick', (e) => {
  const w = e.target.closest('.word');
  if (!w || S.editing) return;
  e.preventDefault();
  clearSel();
  hideTools();
  if (!media.src) {
    if (S.needsAudio) toast('Drop the original audio or video file to enable playback', true);
    return;
  }
  seekTo(Number(w.dataset.s) / 1000);
  w.classList.remove('flash');
  void w.offsetWidth; // restart the animation
  w.classList.add('flash');
  setTimeout(() => w.classList.remove('flash'), 750);
});

// click on empty space clears the selection
document.addEventListener('mousedown', (e) => {
  if (S.editing) return;
  if (e.target.closest('.word, .edittools, .spk-label, .spk-rename')) return;
  if (S.selected.size) { clearSel(); hideTools(); }
});

/* ================= floating edit toolbar ================= */

function showTools() {
  const sel = orderedSelection();
  if (!sel.length) return hideTools();
  const rect = sel[0].getBoundingClientRect();
  edittools.hidden = false;
  const below = rect.top < 130;
  edittools.classList.toggle('below', below);
  const half = edittools.offsetWidth / 2;
  const x = Math.min(Math.max(rect.left + rect.width / 2, half + 8), innerWidth - half - 8);
  edittools.style.left = x + 'px';
  edittools.style.top = (below ? rect.bottom : rect.top) + 'px';
  $('etRevert').hidden = !sel.some((el) => el.dataset.gid);
  $('etCount').textContent = sel.length > 1 ? sel.length + ' words' : '';
}

function hideTools() {
  edittools.hidden = true;
}

window.addEventListener('scroll', () => {
  if (S.selected.size && !S.editing && !edittools.hidden) showTools();
}, { passive: true });
window.addEventListener('resize', () => {
  if (S.selected.size && !edittools.hidden) showTools();
});

$('etPlay').addEventListener('click', () => {
  const sel = orderedSelection();
  if (!sel.length) return;
  if (!media.src) {
    if (S.needsAudio) toast('Drop the original audio or video file to enable playback', true);
    return;
  }
  seekTo(Number(sel[0].dataset.s) / 1000);
  clearSel();
  hideTools();
  media.play();
});

$('etEdit').addEventListener('click', beginEdit);
$('etRevert').addEventListener('click', revertSelection);

/* ================= editing ================= */

function beginEdit() {
  const sel = orderedSelection();
  if (!sel.length || S.editing) return;
  const p = sel[0].closest('p');
  if (sel.some((el) => el.closest('p') !== p)) {
    return toast('Select words within a single paragraph to edit', true);
  }
  ensureIndex();
  const i0 = S.wordEls.indexOf(sel[0]);
  const i1 = S.wordEls.indexOf(sel[sel.length - 1]);
  const run = S.wordEls.slice(i0, i1 + 1); // contiguous range incl. any unselected gaps
  clearSel();
  hideTools();

  const originalText = run.map((el) => el.textContent).join(' ');
  const input = document.createElement('input');
  input.className = 'word-editor';
  input.value = originalText;
  input.spellcheck = false;
  sizeEditor(input);

  const detached = [];
  p.insertBefore(input, run[0]);
  for (const el of run) {
    const next = el.nextSibling;
    if (next && next.nodeType === 3 && !next.textContent.trim()) next.remove();
    el.classList.remove('sel', 'active');
    if (el === lastActive) lastActive = null;
    detached.push(el);
    el.remove();
  }

  S.editing = {
    input, p, detached, originalText,
    s: Number(run[0].dataset.s),
    e: Number(run[run.length - 1].dataset.e),
  };
  S.dirty = true;

  input.addEventListener('input', () => sizeEditor(input));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commitEdit(false);
    else if (e.key === 'Escape') commitEdit(true);
  });
  input.addEventListener('blur', () => commitEdit(false));
  input.focus();
  input.select();
}

function sizeEditor(input) {
  input.style.width = Math.max(3, input.value.length + 1.5) + 'ch';
}

function commitEdit(cancel) {
  const ed = S.editing;
  if (!ed || ed.done) return;
  ed.done = true;
  S.editing = null;

  const val = ed.input.value.replace(/\s+/g, ' ').trim();
  const unchanged = val === ed.originalText;

  if (cancel || unchanged || !val) {
    for (const node of ed.detached) {
      ed.p.insertBefore(node, ed.input);
      ed.p.insertBefore(document.createTextNode(' '), ed.input);
    }
    ed.input.remove();
    if (!cancel && !val) toast('Empty edit ignored — text restored');
  } else {
    const gid = String(S.gidNext++);
    S.editGroups.set(gid, { nodes: ed.detached, text: ed.originalText });
    const parts = val.split(' ');
    const total = parts.reduce((a, w) => a + w.length, 0) || 1;
    let acc = 0;
    for (const part of parts) {
      const s = ed.s + (ed.e - ed.s) * (acc / total);
      acc += part.length;
      const e = ed.s + (ed.e - ed.s) * (acc / total);
      const el = wordSpan({ text: part, s: Math.round(s), e: Math.round(e) });
      el.classList.add('edited');
      el.dataset.gid = gid;
      el.title = `Edited — was: “${ed.originalText}”. Select and Revert to restore.`;
      ed.p.insertBefore(el, ed.input);
      ed.p.insertBefore(document.createTextNode(' '), ed.input);
    }
    ed.input.remove();
    S.edits++;
    scheduleSave();
  }
  S.dirty = true;
  ensureIndex();
  updateActive();
}

function revertSelection() {
  const gids = [...new Set(orderedSelection().map((el) => el.dataset.gid).filter(Boolean))];
  if (!gids.length) return;
  for (const gid of gids) {
    const group = S.editGroups.get(gid);
    const spans = [...transcript.querySelectorAll(`.word[data-gid="${gid}"]`)];
    if (!group || !spans.length) continue;
    const p = spans[0].parentNode;
    for (const node of group.nodes) {
      node.classList.remove('sel', 'active');
      p.insertBefore(node, spans[0]);
      p.insertBefore(document.createTextNode(' '), spans[0]);
    }
    for (const el of spans) {
      const next = el.nextSibling;
      if (next && next.nodeType === 3 && !next.textContent.trim()) next.remove();
      if (el === lastActive) lastActive = null;
      el.remove();
    }
    S.editGroups.delete(gid);
    S.edits = Math.max(0, S.edits - 1);
  }
  clearSel();
  hideTools();
  S.dirty = true;
  ensureIndex();
  updateActive();
  scheduleSave();
  toast('Original text restored');
}

/* ================= speaker rename ================= */

transcript.addEventListener('click', (e) => {
  const label = e.target.closest('.spk-label');
  if (!label || S.editing || label.querySelector('.spk-rename')) return;
  const spk = label.dataset.spk;
  const input = document.createElement('input');
  input.className = 'spk-rename';
  input.value = displayName(spk);
  input.style.width = Math.max(8, input.value.length + 2) + 'ch';
  label.textContent = '';
  label.append(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (cancel) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (!cancel && name) {
      S.speakerNames.set(spk, name);
      scheduleSave();
    }
    for (const l of transcript.querySelectorAll(`.spk-label[data-spk="${CSS.escape(spk)}"]`)) {
      l.textContent = displayName(spk);
    }
  };
  input.addEventListener('input', () => { input.style.width = Math.max(8, input.value.length + 2) + 'ch'; });
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') commit(false);
    else if (ev.key === 'Escape') commit(true);
  });
  input.addEventListener('blur', () => commit(false));
});

/* ================= export ================= */

function transcriptText() {
  const out = [];
  for (const block of transcript.querySelectorAll('.block')) {
    const words = [...block.querySelectorAll('.word')].map((el) => el.textContent).join(' ');
    if (!words) continue;
    const label = block.querySelector('.spk-label');
    out.push(label ? `${label.textContent}: ${words}` : words);
  }
  return out.join('\n\n');
}

$('copyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(transcriptText());
    toast('Transcript copied to clipboard');
  } catch {
    toast('Could not access the clipboard', true);
  }
});

$('downloadBtn').addEventListener('click', () => {
  const name = (S.fileName || 'transcript').replace(/\.[^.]+$/, '') + '.txt';
  const blob = new Blob([transcriptText()], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

/* ================= keyboard ================= */

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, button, a, [contenteditable]')) return;
  if (workspace.hidden) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    seekTo(media.currentTime - 5);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    seekTo(media.currentTime + 5);
  } else if (e.key === 'Escape') {
    clearSel();
    hideTools();
  } else if ((e.key === 'Enter' || e.key.toLowerCase() === 'e') && S.selected.size && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    beginEdit();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && S.selected.size) {
    e.preventDefault();
    navigator.clipboard.writeText(orderedSelection().map((el) => el.textContent).join(' ')).catch(() => {});
    toast('Selected words copied');
  }
});

window.addEventListener('beforeunload', (e) => {
  if (S.savePending) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* ================= init ================= */

(async function init() {
  if (DIRECT) {
    const note = document.querySelector('.key-note');
    if (note) note.textContent = 'Stored only in this browser and sent straight to Soniox — never anywhere else.';
  } else {
    try {
      CFG = await (await fetch('/api/config')).json();
    } catch {
      toast('Cannot reach the local server — start it with: node server.js', true);
    }
  }
  if (!document.pictureInPictureEnabled) $('vidPip').hidden = true;
  refreshKeyPill();
  renderSessionList();
  if (MOCK) toast('Mock mode — transcription is simulated, no API key used');
})();

// dev helper: load a media file by URL as if it were dropped
window.__loadTestFile = async (url) => {
  const r = await fetch(url);
  const b = await r.blob();
  const name = url.split('/').pop() || 'test-audio.m4a';
  handleFile(new File([b], name, { type: b.type || 'audio/mp4' }));
};
