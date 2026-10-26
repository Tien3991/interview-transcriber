/* Interview Transcriber — local server.
   Serves the UI and proxies the Soniox REST API so the API key never reaches the browser.
   Zero dependencies; requires Node 18+ (built-in fetch/FormData/Blob). Run: node server.js */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SONIOX = 'https://api.soniox.com';
const MAX_UPLOAD = 700 * 1024 * 1024;

loadDotEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 4823);
const MODEL = process.env.SONIOX_MODEL || 'stt-async-v5';

function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.json': 'application/json',
};

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': typeof data === 'object' && !Buffer.isBuffer(data) ? 'application/json' : headers['Content-Type'] || 'text/plain',
    'Cache-Control': 'no-store', // edits must always show — no stale pages
    ...headers,
  });
  res.end(body);
}

function readBody(req, limit = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('File too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function keyFor(req) {
  return req.headers['x-soniox-key'] || process.env.SONIOX_API_KEY || '';
}

async function soniox(key, method, apiPath, body, isForm) {
  const headers = { Authorization: `Bearer ${key}` };
  let payload = body;
  if (body && !isForm) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const resp = await fetch(SONIOX + apiPath, { method, headers, body: payload });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!resp.ok) {
    const msg = (data && (data.message || data.error || data.detail)) || `Soniox API error (HTTP ${resp.status})`;
    throw Object.assign(new Error(msg), { status: resp.status });
  }
  return data;
}

/* ---------- API routes ---------- */
/* (Mock mode lives entirely in the client — open the app with ?mock=1.) */

async function api(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]

  if (req.method === 'GET' && url.pathname === '/api/config') {
    return send(res, 200, {
      hasServerKey: !!process.env.SONIOX_API_KEY,
      model: MODEL,
      dropboxToken: process.env.DROPBOX_TOKEN || '', // backups stay off without it
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/transcribe') {
    const body = await readBody(req);
    const filename = decodeURIComponent(req.headers['x-filename'] || 'audio');

    const key = keyFor(req);
    if (!key) return send(res, 401, { error: 'No Soniox API key configured. Add one in the app header or in .env.' });

    const form = new FormData();
    form.append('file', new Blob([body]), filename);
    const uploaded = await soniox(key, 'POST', '/v1/files', form, true);

    const opts = { model: url.searchParams.get('model') || MODEL, file_id: uploaded.id };
    if (url.searchParams.get('diarization')) opts.enable_speaker_diarization = true;
    const hints = (url.searchParams.get('language_hints') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (hints.length) opts.language_hints = hints;

    let job;
    try {
      job = await soniox(key, 'POST', '/v1/transcriptions', opts);
    } catch (err) {
      soniox(key, 'DELETE', `/v1/files/${uploaded.id}`).catch(() => {});
      throw err;
    }
    return send(res, 200, { transcription_id: job.id, file_id: uploaded.id });
  }

  if (req.method === 'GET' && seg[1] === 'transcriptions' && seg[2] && !seg[3]) {
    return send(res, 200, await soniox(keyFor(req), 'GET', `/v1/transcriptions/${seg[2]}`));
  }

  if (req.method === 'GET' && seg[1] === 'transcriptions' && seg[3] === 'transcript') {
    return send(res, 200, await soniox(keyFor(req), 'GET', `/v1/transcriptions/${seg[2]}/transcript`));
  }

  // Remove the audio + transcription from Soniox storage once the client has the result.
  if (req.method === 'POST' && url.pathname === '/api/cleanup') {
    const body = JSON.parse((await readBody(req, 1e6)).toString() || '{}');
    const key = keyFor(req);
    if (key && body.transcription_id) {
      try { await soniox(key, 'DELETE', `/v1/transcriptions/${body.transcription_id}`); } catch {}
    }
    if (key && body.file_id) {
      try { await soniox(key, 'DELETE', `/v1/files/${body.file_id}`); } catch {}
    }
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Not found' });
}

/* ---------- static files ---------- */

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const external = rel.startsWith('/dev/') || rel.startsWith('/dist/');
  const base = external ? ROOT : PUBLIC_DIR;
  const file = path.normalize(path.join(base, external ? rel : rel.slice(1)));
  if (!file.startsWith(base)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(url.pathname, res);
  } catch (err) {
    send(res, err.status || 500, { error: err.message || String(err) });
  }
});

server.listen(PORT, () => {
  const keyState = process.env.SONIOX_API_KEY ? 'from .env / environment' : 'not set — paste it in the app header';
  console.log(`Interview Transcriber  →  http://localhost:${PORT}`);
  console.log(`Model: ${MODEL}   API key: ${keyState}`);
});
