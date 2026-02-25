const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// ─── Temp Upload Storage ──────────────────────────────────────────────────────
const TEMP_DIR = path.join(os.tmpdir(), 'autodj-temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TEMP_DIR),
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_ ]/g, '_');
      cb(null, `${Date.now()}_${safe}`);
    }
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ['.mp3','.flac','.wav','.ogg','.m4a','.aac','.opus','.wma'].includes(ext));
  }
});

let tempFiles = [];

function cleanExpiredTempFiles() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  tempFiles = tempFiles.filter(tf => {
    if (tf.uploadedAt < cutoff) { try { fs.unlinkSync(tf.filepath); } catch(e) {} return false; }
    return true;
  });
}

// ─── Config ───────────────────────────────────────────────────────────────────
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
  try { const saved = JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')); Object.assign(config, saved); } catch(e) {}
}
function saveConfig() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }

// ─── Shared State (SSE to display page) ──────────────────────────────────────
let sharedState = {
  nowPlaying: null, nextUp: null, genre: '',
  messages: config.messages, queue: [], isPlaying: false, isFading: false
};
const sseClients = new Set();
function broadcastState() {
  const data = JSON.stringify(sharedState);
  for (const c of sseClients) { try { c.write(`data: ${data}\n\n`); } catch(e) { sseClients.delete(c); } }
}

// ─── Config API ───────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => res.json({
  lastfmKey: config.lastfmKey ? '●●●set●●●' : '',
  spotifyClientId: config.spotifyClientId || '',
  openaiKey: config.openaiKey ? '●●●set●●●' : '',
  anthropicKey: config.anthropicKey ? '●●●set●●●' : '',
  aiProvider: config.aiProvider,
  musicDirs: config.musicDirs,
  messages: config.messages,
  hasLastfm: !!config.lastfmKey,
  hasSpotify: !!(config.spotifyClientId && config.spotifyClientSecret),
  hasAI: !!(config.anthropicKey || config.openaiKey)
}));

app.post('/api/config', (req, res) => {
  const b = req.body;
  if (b.lastfmKey && !b.lastfmKey.includes('●')) config.lastfmKey = b.lastfmKey;
  if (b.spotifyClientId) config.spotifyClientId = b.spotifyClientId;
  if (b.spotifyClientSecret) config.spotifyClientSecret = b.spotifyClientSecret;
  if (b.openaiKey && !b.openaiKey.includes('●')) config.openaiKey = b.openaiKey;
  if (b.anthropicKey && !b.anthropicKey.includes('●')) config.anthropicKey = b.anthropicKey;
  if (b.aiProvider) config.aiProvider = b.aiProvider;
  if (b.musicDirs) config.musicDirs = b.musicDirs;
  if (b.messages) { config.messages = b.messages; sharedState.messages = b.messages; }
  saveConfig();
  res.json({ ok: true });
});

// ─── Local Music ──────────────────────────────────────────────────────────────
const AUDIO_EXTS = ['.mp3','.flac','.wav','.ogg','.m4a','.aac','.opus','.wma'];

function scanDir(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const walk = (d) => {
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (AUDIO_EXTS.includes(path.extname(e.name).toLowerCase())) results.push(full);
      }
    } catch(e) {}
  };
  walk(dir);
  return results;
}

app.get('/api/local/scan', (req, res) => {
  const all = [];
  for (const dir of config.musicDirs) all.push(...scanDir(dir));
  res.json(all.map(fp => {
    const stat = fs.statSync(fp);
    const name = path.basename(fp, path.extname(fp));
    const parts = name.split(' - ');
    return {
      type: 'local', filepath: fp,
      filename: path.basename(fp),
      ext: path.extname(fp).toLowerCase(),
      size: stat.size,
      title: parts.length >= 2 ? parts.slice(1).join(' - ') : name,
      artist: parts.length >= 2 ? parts[0] : 'Unknown',
      album: '', duration: 0
    };
  }));
});

function streamFile(fp, req, res) {
  const stat = fs.statSync(fp);
  const ext = path.extname(fp).toLowerCase();
  const mimeMap = { '.mp3':'audio/mpeg','.flac':'audio/flac','.wav':'audio/wav',
    '.ogg':'audio/ogg','.m4a':'audio/mp4','.aac':'audio/aac','.opus':'audio/ogg','.wma':'audio/x-ms-wma' };
  const mime = mimeMap[ext] || 'audio/mpeg';
  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace(/bytes=/,'').split('-');
    const start = parseInt(s, 10);
    const end = e ? parseInt(e, 10) : stat.size - 1;
    res.writeHead(206, { 'Content-Range':`bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges':'bytes', 'Content-Length':end-start+1, 'Content-Type':mime });
    fs.createReadStream(fp, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length':stat.size, 'Content-Type':mime, 'Accept-Ranges':'bytes' });
    fs.createReadStream(fp).pipe(res);
  }
}

app.get('/api/local/stream', (req, res) => {
  const fp = req.query.path;
  if (!fp || !fs.existsSync(fp)) return res.status(404).send('Not found');
  const allowed = config.musicDirs.some(d => fp.startsWith(d)) || fp.startsWith(path.join(__dirname,'music'));
  if (!allowed) return res.status(403).send('Forbidden');
  streamFile(fp, req, res);
});

// ─── Last.fm ──────────────────────────────────────────────────────────────────
app.get('/api/lastfm', async (req, res) => {
  if (!config.lastfmKey) return res.status(400).json({ error: 'No Last.fm API key' });
  try {
    const url = new URL('https://ws.audioscrobbler.com/2.0/');
    Object.entries({ ...req.query, api_key: config.lastfmKey, format: 'json' })
      .forEach(([k,v]) => url.searchParams.set(k,v));
    const r = await fetch(url.toString());
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Spotify ──────────────────────────────────────────────────────────────────
let spotifyToken = null, spotifyTokenExpiry = 0;
async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyTokenExpiry) return spotifyToken;
  if (!config.spotifyClientId || !config.spotifyClientSecret) return null;
  const creds = Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method:'POST', headers:{'Authorization':`Basic ${creds}`,'Content-Type':'application/x-www-form-urlencoded'},
    body:'grant_type=client_credentials'
  });
  const d = await r.json();
  spotifyToken = d.access_token;
  spotifyTokenExpiry = Date.now() + (d.expires_in * 1000) - 60000;
  return spotifyToken;
}
app.get('/api/spotify/:endpoint(*)', async (req, res) => {
  try {
    const token = await getSpotifyToken();
    if (!token) return res.status(400).json({ error: 'No Spotify credentials' });
    const url = `https://api.spotify.com/v1/${req.params.endpoint}?${new URLSearchParams(req.query)}`;
    const r = await fetch(url, { headers:{'Authorization':`Bearer ${token}`} });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── AI ───────────────────────────────────────────────────────────────────────
app.post('/api/ai/recommend', async (req, res) => {
  const { history, currentTrack, tags, mood } = req.body;
  const prompt = `You are an expert music DJ AI. Recommend 5 specific songs to queue next for the best mix flow.
Current track: ${JSON.stringify(currentTrack)}
Recent history: ${JSON.stringify((history||[]).slice(-5))}
Genre/Tags: ${(tags||[]).join(', ')}
Mood/Vibe: ${mood || 'not specified'}
Respond ONLY with a JSON array of 5 objects: [{"title":string,"artist":string,"reason":string}]`;
  try {
    if (config.aiProvider === 'anthropic' && config.anthropicKey) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{'x-api-key':config.anthropicKey,'anthropic-version':'2023-06-01','content-type':'application/json'},
        body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:1024, messages:[{role:'user',content:prompt}] })
      });
      const d = await r.json();
      const text = (d.content?.[0]?.text||'[]').replace(/```json|```/g,'').trim();
      res.json(JSON.parse(text));
    } else if (config.aiProvider === 'openai' && config.openaiKey) {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method:'POST',
        headers:{'Authorization':`Bearer ${config.openaiKey}`,'Content-Type':'application/json'},
        body: JSON.stringify({ model:'gpt-4o-mini', messages:[{role:'user',content:prompt}] })
      });
      const d = await r.json();
      const text = (d.choices?.[0]?.message?.content||'[]').replace(/```json|```/g,'').trim();
      res.json(JSON.parse(text));
    } else {
      res.status(400).json({ error: 'No AI provider configured' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Video Search — Piped API (NewPipe backend) + Invidious fallback ──────────
app.get('/api/youtube/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);

  // Piped instances (NewPipe alternative, open source YouTube frontend)
  const pipedInstances = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.reallyaweso.me',
    'https://pipedapi.tokhmi.xyz',
    'https://piped-api.garudalinux.org',
    'https://api.piped.projectsegfau.lt',
  ];

  // Try Piped first
  for (const instance of pipedInstances) {
    try {
      const url = `${instance}/search?q=${encodeURIComponent(q)}&filter=videos`;
      const r = await fetch(url, { signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'AutoDJ/2.0' } });
      if (!r.ok) continue;
      const data = await r.json();
      const items = (data.items || []).filter(i => i.type === 'stream' || i.url).slice(0, 3);
      if (items.length > 0) {
        return res.json(items.map(i => ({
          videoId: i.url?.replace('/watch?v=','') || i.videoId,
          title: i.title,
          author: i.uploaderName || i.author,
          lengthSeconds: i.duration || 0
        })));
      }
    } catch(e) { continue; }
  }

  // Invidious fallback
  const invidiousInstances = [
    'https://invidious.privacyredirect.com',
    'https://iv.datura.network',
    'https://invidious.nerdvpn.de',
  ];
  for (const instance of invidiousInstances) {
    try {
      const url = `${instance}/api/v1/search?q=${encodeURIComponent(q)}&type=video&fields=videoId,title,author,lengthSeconds`;
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const data = await r.json();
      if (Array.isArray(data) && data.length > 0) return res.json(data.slice(0, 3));
    } catch(e) { continue; }
  }

  res.json([]);
});

// ─── Piped stream URL resolver (gets direct audio stream) ─────────────────────
app.get('/api/piped/streams', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: 'Missing videoId' });

  const pipedInstances = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.reallyaweso.me',
    'https://pipedapi.tokhmi.xyz',
    'https://piped-api.garudalinux.org',
    'https://api.piped.projectsegfau.lt',
  ];

  for (const instance of pipedInstances) {
    try {
      const r = await fetch(`${instance}/streams/${videoId}`, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'AutoDJ/2.0' }
      });
      if (!r.ok) continue;
      const data = await r.json();
      if (data.audioStreams && data.audioStreams.length > 0) {
        // Sort by quality, prefer high bitrate
        const sorted = data.audioStreams.sort((a,b) => (b.bitrate||0)-(a.bitrate||0));
        return res.json({
          title: data.title,
          uploader: data.uploader,
          duration: data.duration,
          thumbnail: data.thumbnailUrl,
          audioStreams: sorted.slice(0, 3).map(s => ({
            url: s.url,
            mimeType: s.mimeType,
            bitrate: s.bitrate,
            quality: s.quality
          }))
        });
      }
    } catch(e) { continue; }
  }
  res.status(404).json({ error: 'No streams found' });
});

// ─── Temp Upload ──────────────────────────────────────────────────────────────
app.post('/api/temp/upload', upload.array('files', 100), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No files' });
  const added = req.files.map(f => {
    tempFiles.push({ filepath: f.path, filename: f.originalname, storedName: f.filename, size: f.size, uploadedAt: Date.now() });
    const name = path.basename(f.originalname, path.extname(f.originalname));
    const parts = name.split(' - ');
    return {
      filepath: f.path, filename: f.originalname, size: f.size,
      title: parts.length >= 2 ? parts.slice(1).join(' - ') : name,
      artist: parts.length >= 2 ? parts[0] : 'Unknown',
      storedName: f.filename,
      url: `/api/temp/stream?file=${encodeURIComponent(f.filename)}`
    };
  });
  res.json({ ok: true, files: added, count: added.length });
});

app.get('/api/temp/stream', (req, res) => {
  const filename = req.query.file;
  if (!filename) return res.status(400).send('Missing file');
  const fp = path.resolve(TEMP_DIR, filename);
  if (!fp.startsWith(TEMP_DIR) || !fs.existsSync(fp)) return res.status(404).send('Not found');
  streamFile(fp, req, res);
});

app.get('/api/temp/list', (req, res) => {
  cleanExpiredTempFiles();
  res.json(tempFiles.map(tf => ({ filename: tf.filename, storedName: tf.storedName, size: tf.size,
    uploadedAt: tf.uploadedAt, url: `/api/temp/stream?file=${encodeURIComponent(tf.storedName)}` })));
});
app.delete('/api/temp/clear', (req, res) => {
  let deleted = 0;
  for (const tf of tempFiles) { try { fs.unlinkSync(tf.filepath); deleted++; } catch(e) {} }
  tempFiles = [];
  res.json({ ok: true, deleted });
});
app.delete('/api/temp/file', (req, res) => {
  const idx = tempFiles.findIndex(tf => tf.storedName === req.query.file);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(tempFiles[idx].filepath); } catch(e) {}
  tempFiles.splice(idx, 1);
  res.json({ ok: true });
});

// ─── System Stats ─────────────────────────────────────────────────────────────
let lastCpu = null;
function getCpuPercent() {
  const cpus = os.cpus();
  const now = cpus.map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a,b)=>a+b,0) }));
  if (!lastCpu) { lastCpu = now; return 0; }
  let idleDiff = 0, totalDiff = 0;
  for (let i = 0; i < now.length; i++) { idleDiff += now[i].idle - lastCpu[i].idle; totalDiff += now[i].total - lastCpu[i].total; }
  lastCpu = now;
  return totalDiff === 0 ? 0 : Math.round(100 * (1 - idleDiff / totalDiff));
}
setInterval(() => getCpuPercent(), 1000);

function getDiskStats() {
  try {
    if (fs.statfsSync) { const s = fs.statfsSync('/'); return { total: s.blocks*s.bsize, free: s.bfree*s.bsize }; }
    const out = execSync('df -k / 2>/dev/null | tail -1').toString().trim().split(/\s+/);
    return { total: parseInt(out[1])*1024||0, free: parseInt(out[3])*1024||0 };
  } catch(e) { return { total: 0, free: 0 }; }
}

function getTempDirSize() {
  let total = 0;
  try { for (const f of fs.readdirSync(TEMP_DIR)) { try { total += fs.statSync(path.join(TEMP_DIR,f)).size; } catch(e) {} } } catch(e) {}
  return total;
}

app.get('/api/system/stats', (req, res) => {
  const total = os.totalmem(), free = os.freemem(), used = total - free;
  const disk = getDiskStats();
  const proc = process.memoryUsage();
  res.json({
    cpu: { percent: getCpuPercent(), cores: os.cpus().length, model: os.cpus()[0]?.model?.trim()||'Unknown' },
    ram: { total, used, free, percent: Math.round(used/total*100), processRss: proc.rss, processHeap: proc.heapUsed },
    disk: { total: disk.total, free: disk.free, used: disk.total-disk.free,
      percent: disk.total > 0 ? Math.round((disk.total-disk.free)/disk.total*100) : 0 },
    temp: { files: tempFiles.length, size: getTempDirSize(), dir: TEMP_DIR },
    uptime: process.uptime(), platform: os.platform(), hostname: os.hostname()
  });
});


// ─── Piped audio relay for display page ───────────────────────────────────────
// The display page cannot directly fetch Piped URLs (CORS). Relay through server.
app.get('/api/piped/relay', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');
  try {
    const upstream = await fetch(decodeURIComponent(url), {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'AutoDJ/2.0', 'Range': req.headers.range || 'bytes=0-' }
    });
    res.status(upstream.status);
    ['content-type','content-length','content-range','accept-ranges'].forEach(h => {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    upstream.body.pipe(res);
  } catch(e) { res.status(502).send('Relay error: ' + e.message); }
});

// ─── SSE / Now Playing ────────────────────────────────────────────────────────
app.get('/api/nowplaying/stream', (req, res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
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

// ─── Pages ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/dj'));
app.get('/dj', (req, res) => res.sendFile(path.join(__dirname, 'dj.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'display.html')));

app.listen(PORT, () => {
  console.log(`\n🎧 AutoDJ running at http://localhost:${PORT}`);
  console.log(`   DJ Console  →  http://localhost:${PORT}/dj`);
  console.log(`   Now Playing →  http://localhost:${PORT}/display\n`);
});
