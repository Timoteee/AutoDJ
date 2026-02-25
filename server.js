const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const multer = require('multer');

// ─── Temp Upload Storage ──────────────────────────────────────────────────────
const TEMP_DIR = path.join(os.tmpdir(), 'autodj-temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TEMP_DIR),
    destination: (req, file, cb) => cb(null, TEMP_DIR),
    filename: (req, file, cb) => {
      // Preserve original filename but sanitize
      const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_ ]/g, '_');
      cb(null, `${Date.now()}_${safe}`);
    }
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB per file
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.mp3','.flac','.wav','.ogg','.m4a','.aac','.opus','.wma'];
    cb(null, allowed.includes(ext));
  }
});

// Track temp files with timestamps for cleanup
let tempFiles = []; // { filepath, filename, uploadedAt, size }

function cleanExpiredTempFiles() {
  // Remove temp files older than 24h as safety net
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  tempFiles = tempFiles.filter(tf => {
    if (tf.uploadedAt < cutoff) {
      try { fs.unlinkSync(tf.filepath); } catch(e) {}
      return false;
    }
    return true;
  });
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ─── Config (loaded from environment or config.json) ─────────────────────────
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = {
  lastfmKey: process.env.LASTFM_API_KEY || '',
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID || '',
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
  openaiKey: process.env.OPENAI_API_KEY || '',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  aiProvider: 'anthropic',
  musicDirs: process.env.MUSIC_DIR ? [process.env.MUSIC_DIR] : [path.join(__dirname, 'music')],
  messages: [
    "🎵 Vibes are immaculate tonight",
    "🔊 Your neighbors are jealous",
    "🎧 DJ AutoDJ never takes requests... except from you",
    "💿 This banger was hand-selected by algorithms",
    "🕺 Statistically, you should be dancing right now",
    "🎶 Fun fact: this song is better loud",
    "🌊 Riding the wave, don't fight it",
    "🎯 BPM calculated. Mood: elevated.",
    "✨ The crossfade was flawless. You're welcome.",
    "🦾 AI DJ > Human DJ (don't @ us)",
    "📻 Broadcasting from the algorithm dimension",
    "🔥 This track was approved by the council of bangers",
    "⚡ Peak hours. Peak vibes.",
    "🎸 No skips. It's in the constitution.",
    "🌙 Late night mode: engaged",
  ]
};

if (fs.existsSync(CONFIG_FILE)) {
  try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch(e) {}
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ─── Shared State (broadcast to nowplaying page) ──────────────────────────────
let sharedState = {
  nowPlaying: null,
  nextUp: null,
  genre: '',
  messages: config.messages,
  queue: [],
  isPlaying: false,
  crossfadeProgress: 0
};

// SSE clients for now-playing page
const sseClients = new Set();

function broadcastState() {
  const data = JSON.stringify(sharedState);
  for (const client of sseClients) {
    try { client.write(`data: ${data}\n\n`); } catch(e) { sseClients.delete(client); }
  }
}

// ─── API: Config ──────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    lastfmKey: config.lastfmKey ? '***set***' : '',
    spotifyClientId: config.spotifyClientId,
    openaiKey: config.openaiKey ? '***set***' : '',
    anthropicKey: config.anthropicKey ? '***set***' : '',
    aiProvider: config.aiProvider,
    musicDirs: config.musicDirs,
    messages: config.messages
  });
});

app.post('/api/config', (req, res) => {
  const { lastfmKey, spotifyClientId, spotifyClientSecret, openaiKey, anthropicKey, aiProvider, musicDirs, messages } = req.body;
  if (lastfmKey && lastfmKey !== '***set***') config.lastfmKey = lastfmKey;
  if (spotifyClientId) config.spotifyClientId = spotifyClientId;
  if (spotifyClientSecret) config.spotifyClientSecret = spotifyClientSecret;
  if (openaiKey && openaiKey !== '***set***') config.openaiKey = openaiKey;
  if (anthropicKey && anthropicKey !== '***set***') config.anthropicKey = anthropicKey;
  if (aiProvider) config.aiProvider = aiProvider;
  if (musicDirs) config.musicDirs = musicDirs;
  if (messages) { config.messages = messages; sharedState.messages = messages; }
  saveConfig();
  res.json({ ok: true });
});

// ─── API: Local Music Scanner ─────────────────────────────────────────────────
const AUDIO_EXTS = ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.wma'];

function scanDir(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const walk = (d) => {
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (AUDIO_EXTS.includes(path.extname(e.name).toLowerCase())) {
          results.push(full);
        }
      }
    } catch(err) {}
  };
  walk(dir);
  return results;
}

app.get('/api/local/scan', (req, res) => {
  const all = [];
  for (const dir of config.musicDirs) all.push(...scanDir(dir));
  const tracks = all.map(fp => {
    const stat = fs.statSync(fp);
    return {
      type: 'local',
      filepath: fp,
      filename: path.basename(fp),
      ext: path.extname(fp).toLowerCase(),
      size: stat.size,
      title: path.basename(fp, path.extname(fp)),
      artist: '',
      album: '',
      duration: 0,
      youtubeId: null
    };
  });
  res.json(tracks);
});

// Stream local audio file
app.get('/api/local/stream', (req, res) => {
  const fp = req.query.path;
  if (!fp || !fs.existsSync(fp)) return res.status(404).send('Not found');
  // Security: only serve from configured dirs
  const allowed = config.musicDirs.some(d => fp.startsWith(d)) ||
    fp.startsWith(path.join(__dirname, 'music'));
  if (!allowed) return res.status(403).send('Forbidden');

  const stat = fs.statSync(fp);
  const ext = path.extname(fp).toLowerCase();
  const mimeMap = { '.mp3':'audio/mpeg', '.flac':'audio/flac', '.wav':'audio/wav',
    '.ogg':'audio/ogg', '.m4a':'audio/mp4', '.aac':'audio/aac', '.opus':'audio/ogg', '.wma':'audio/x-ms-wma' };
  const mime = mimeMap[ext] || 'audio/mpeg';

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': mime
    });
    fs.createReadStream(fp, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime });
    fs.createReadStream(fp).pipe(res);
  }
});

// ─── API: Last.fm ─────────────────────────────────────────────────────────────
app.get('/api/lastfm', async (req, res) => {
  if (!config.lastfmKey) return res.status(400).json({ error: 'No Last.fm API key configured' });
  try {
    const url = new URL('https://ws.audioscrobbler.com/2.0/');
    const params = { ...req.query, api_key: config.lastfmKey, format: 'json' };
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const r = await fetch(url.toString());
    const data = await r.json();
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Spotify ─────────────────────────────────────────────────────────────
let spotifyToken = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyTokenExpiry) return spotifyToken;
  if (!config.spotifyClientId || !config.spotifyClientSecret) return null;
  const creds = Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const data = await r.json();
  spotifyToken = data.access_token;
  spotifyTokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
  return spotifyToken;
}

app.get('/api/spotify/:endpoint(*)', async (req, res) => {
  try {
    const token = await getSpotifyToken();
    if (!token) return res.status(400).json({ error: 'No Spotify credentials configured' });
    const url = `https://api.spotify.com/v1/${req.params.endpoint}?${new URLSearchParams(req.query)}`;
    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── API: AI Queuing Intelligence ─────────────────────────────────────────────
app.post('/api/ai/recommend', async (req, res) => {
  const { history, queue, currentTrack, tags, mood } = req.body;

  const prompt = `You are an expert music DJ AI. Based on the following context, recommend 5 specific songs to queue next that will create the best mix flow.

Current track: ${JSON.stringify(currentTrack)}
Recent history (last 5): ${JSON.stringify(history?.slice(-5))}
Genre/Tags: ${tags?.join(', ')}
Mood/Vibe: ${mood || 'not specified'}

Respond ONLY with a JSON array of 5 objects, each with: { "title": string, "artist": string, "reason": string }
Choose tracks that have good musical compatibility, similar energy/BPM range, and interesting genre progression.`;

  try {
    if (config.aiProvider === 'anthropic' && config.anthropicKey) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': config.anthropicKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await r.json();
      const text = data.content?.[0]?.text || '[]';
      const clean = text.replace(/```json|```/g, '').trim();
      res.json(JSON.parse(clean));

    } else if (config.aiProvider === 'openai' && config.openaiKey) {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${config.openaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' }
        })
      });
      const data = await r.json();
      const text = data.choices?.[0]?.message?.content || '{"tracks":[]}';
      const parsed = JSON.parse(text);
      res.json(parsed.tracks || parsed);
    } else {
      res.status(400).json({ error: 'No AI provider configured' });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Invidious YouTube search ───────────────────────────────────────────
app.get('/api/youtube/search', async (req, res) => {
  const { q } = req.query;
  const instances = [
    'https://iv.datura.network',
    'https://invidious.privacyredirect.com',
    'https://invidious.nerdvpn.de',
    'https://inv.tux.pizza'
  ];
  for (const instance of instances) {
    try {
      const url = `${instance}/api/v1/search?q=${encodeURIComponent(q)}&type=video&fields=videoId,title,author,lengthSeconds&page=1`;
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const data = await r.json();
      if (Array.isArray(data) && data.length > 0) return res.json(data.slice(0, 3));
    } catch(e) { continue; }
  }
  res.json([]);
});

// ─── SSE: Now Playing state ───────────────────────────────────────────────────
app.get('/api/nowplaying/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  res.write(`data: ${JSON.stringify(sharedState)}\n\n`);
  req.on('close', () => sseClients.delete(res));
});

app.post('/api/nowplaying/update', (req, res) => {
  Object.assign(sharedState, req.body);
  broadcastState();
  res.json({ ok: true });
});

app.get('/api/nowplaying', (req, res) => res.json(sharedState));

// ─── API: Temp Upload ─────────────────────────────────────────────────────────
// Upload files to temp folder (cleared when queue is cleared or server restarts)
app.post('/api/temp/upload', upload.array('files', 100), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
  const added = req.files.map(f => {
    const record = {
      filepath: f.path,
      filename: f.originalname,
      storedName: f.filename,
      size: f.size,
      ext: path.extname(f.originalname).toLowerCase(),
      uploadedAt: Date.now()
    };
    tempFiles.push(record);
    return {
      filepath: f.path,
      filename: f.originalname,
      size: f.size,
      title: path.basename(f.originalname, path.extname(f.originalname)),
      artist: '',
      type: 'temp',
      url: `/api/temp/stream?file=${encodeURIComponent(f.filename)}`
    };
  });
  res.json({ ok: true, files: added, count: added.length });
});

// Stream a temp file
app.get('/api/temp/stream', (req, res) => {
  const filename = req.query.file;
  if (!filename) return res.status(400).send('Missing file param');
  const fp = path.join(TEMP_DIR, filename);
  if (!fp.startsWith(TEMP_DIR)) return res.status(403).send('Forbidden');
  if (!fs.existsSync(fp)) return res.status(404).send('Temp file not found or expired');

  const stat = fs.statSync(fp);
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = { '.mp3':'audio/mpeg', '.flac':'audio/flac', '.wav':'audio/wav',
    '.ogg':'audio/ogg', '.m4a':'audio/mp4', '.aac':'audio/aac', '.opus':'audio/ogg', '.wma':'audio/x-ms-wma' };
  const mime = mimeMap[ext] || 'audio/mpeg';

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': mime
    });
    fs.createReadStream(fp, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime });
    fs.createReadStream(fp).pipe(res);
  }
});

// List current temp files
app.get('/api/temp/list', (req, res) => {
  cleanExpiredTempFiles();
  res.json(tempFiles.map(tf => ({
    filename: tf.filename,
    storedName: tf.storedName,
    size: tf.size,
    uploadedAt: tf.uploadedAt,
    url: `/api/temp/stream?file=${encodeURIComponent(tf.storedName)}`
  })));
});

// Delete all temp files (called when queue is cleared)
app.delete('/api/temp/clear', (req, res) => {
  let deleted = 0;
  for (const tf of tempFiles) {
    try { fs.unlinkSync(tf.filepath); deleted++; } catch(e) {}
  }
  tempFiles = [];
  res.json({ ok: true, deleted });
});

// Delete single temp file
app.delete('/api/temp/file', (req, res) => {
  const stored = req.query.file;
  const idx = tempFiles.findIndex(tf => tf.storedName === stored);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(tempFiles[idx].filepath); } catch(e) {}
  tempFiles.splice(idx, 1);
  res.json({ ok: true });
});

// ─── API: System Stats ────────────────────────────────────────────────────────
function getTempDirSize() {
  try {
    let total = 0;
    if (fs.existsSync(TEMP_DIR)) {
      const files = fs.readdirSync(TEMP_DIR);
      for (const f of files) {
        try { total += fs.statSync(path.join(TEMP_DIR, f)).size; } catch(e) {}
      }
    }
    return total;
  } catch(e) { return 0; }
}

function getDiskStats(dir) {
  try {
    // Cross-platform disk stats using Node's statfs (Node 19+) or statvfs
    if (fs.statfsSync) {
      const s = fs.statfsSync(dir || '/');
      return {
        total: s.blocks * s.bsize,
        free: s.bfree * s.bsize,
        available: s.bavail * s.bsize
      };
    }
    // Fallback: try df command
    const out = execSync(`df -k "${dir || '/'}" 2>/dev/null | tail -1`).toString().trim().split(/\s+/);
    return {
      total: parseInt(out[1]) * 1024 || 0,
      free: parseInt(out[3]) * 1024 || 0,
      available: parseInt(out[3]) * 1024 || 0
    };
  } catch(e) { return { total: 0, free: 0, available: 0 }; }
}

// CPU usage (sample over 100ms)
let lastCpuSample = null;
function getCpuPercent() {
  const cpus = os.cpus();
  const now = cpus.map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a,b)=>a+b,0) }));
  if (!lastCpuSample) { lastCpuSample = now; return 0; }
  let idleDiff = 0, totalDiff = 0;
  for (let i = 0; i < now.length; i++) {
    idleDiff += now[i].idle - lastCpuSample[i].idle;
    totalDiff += now[i].total - lastCpuSample[i].total;
  }
  lastCpuSample = now;
  return totalDiff === 0 ? 0 : Math.round(100 * (1 - idleDiff / totalDiff));
}
// Warm up CPU sampler
setInterval(() => getCpuPercent(), 1000);

app.get('/api/system/stats', (req, res) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const disk = getDiskStats(path.join(__dirname));
  const proc = process.memoryUsage();

  res.json({
    cpu: {
      percent: getCpuPercent(),
      cores: os.cpus().length,
      model: os.cpus()[0]?.model?.trim() || 'Unknown'
    },
    ram: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      percent: Math.round((usedMem / totalMem) * 100),
      processRss: proc.rss,
      processHeap: proc.heapUsed
    },
    disk: {
      total: disk.total,
      free: disk.free,
      used: disk.total - disk.free,
      percent: disk.total > 0 ? Math.round(((disk.total - disk.free) / disk.total) * 100) : 0
    },
    temp: {
      files: tempFiles.length,
      size: getTempDirSize(),
      dir: TEMP_DIR
    },
    uptime: process.uptime(),
    platform: os.platform(),
    hostname: os.hostname()
  });
});

// ─── Serve pages ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/dj'));
app.get('/dj', (req, res) => res.sendFile(path.join(__dirname, 'dj.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'display.html')));

app.listen(PORT, () => {
  console.log(`\n🎧 AutoDJ running at http://localhost:${PORT}`);
  console.log(`   DJ Console  →  http://localhost:${PORT}/dj`);
  console.log(`   Now Playing →  http://localhost:${PORT}/display\n`);
});
