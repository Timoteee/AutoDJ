const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const multer = require('multer');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── Session Middleware ──────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'autodj-secret-' + Math.random().toString(36).slice(2),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false, // set true if behind HTTPS proxy
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// ─── Auth Credentials ────────────────────────────────────────────────────────
const AUTH_FILE = path.join(__dirname, '.auth.json');
const DEFAULT_USER = 'admin';
const DEFAULT_PASS = 'adminroot123';

function loadAuth() {
  if (fs.existsSync(AUTH_FILE)) {
    try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch(e) {}
  }
  // Initialize with default credentials
  const auth = { username: DEFAULT_USER, passwordHash: bcrypt.hashSync(DEFAULT_PASS, 10) };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
  return auth;
}

function saveAuth(auth) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
}

let authData = loadAuth();

// ─── Auth Middleware ─────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  // For API calls return 401, for pages redirect to login
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect('/login');
}

// ─── Public Routes (login page, display page, static assets) ────────────────
app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/dj');
  const loginPath = path.join(__dirname, 'login.html');
  if (!fs.existsSync(loginPath)) {
    return res.status(500).send('login.html not found at ' + loginPath + '. Ensure it was copied into the Docker image.');
  }
  res.sendFile(loginPath);
});

// Serve static files selectively — protect dj.js and engine.js
app.use((req, res, next) => {
  const protectedFiles = ['/dj.js', '/engine.js', '/dj.html'];
  if (protectedFiles.includes(req.path)) {
    if (req.session && req.session.authenticated) {
      return res.sendFile(path.join(__dirname, req.path.slice(1)));
    }
    return res.redirect('/login');
  }
  next();
});

app.use(express.static(__dirname));

// ─── Auth API ────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

  if (username !== authData.username) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  if (!bcrypt.compareSync(password, authData.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  req.session.authenticated = true;
  req.session.username = username;
  res.json({ ok: true, username });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/auth/check', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.json({ authenticated: true, username: req.session.username });
  }
  res.json({ authenticated: false });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Both current and new password required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  if (!bcrypt.compareSync(currentPassword, authData.passwordHash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  authData.passwordHash = bcrypt.hashSync(newPassword, 10);
  saveAuth(authData);
  res.json({ ok: true, message: 'Password changed successfully' });
});

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
  marqueeMode: 'static', // 'static' or 'rss'
  rssUrl: '',
  bgArtSource: 'track', // 'track' or 'artist'
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
  messages: config.marqueeMode === 'rss' ? ['📰 Loading RSS feed...'] : config.messages,
  queue: [], isPlaying: false, isFading: false,
  recentlyPlayed: [], bgArtSource: config.bgArtSource || 'track',
  bgImageUrl: '', artistImageUrl: '',
  deckState: { activeDeck: 'a', crossfader: 0, decks: { a: {}, b: {} } },
  marqueeMode: config.marqueeMode || 'static'
};
const sseClients = new Set();
function broadcastState() {
  const data = JSON.stringify(sharedState);
  for (const c of sseClients) { try { c.write(`data: ${data}\n\n`); } catch(e) { sseClients.delete(c); } }
}

// ─── Config API (protected) ──────────────────────────────────────────────────
app.get('/api/config', requireAuth, (req, res) => res.json({
  lastfmKey: config.lastfmKey ? '●●●set●●●' : '',
  spotifyClientId: config.spotifyClientId || '',
  openaiKey: config.openaiKey ? '●●●set●●●' : '',
  anthropicKey: config.anthropicKey ? '●●●set●●●' : '',
  aiProvider: config.aiProvider,
  musicDirs: config.musicDirs,
  messages: config.messages,
  marqueeMode: config.marqueeMode || 'static',
  rssUrl: config.rssUrl || '',
  bgArtSource: config.bgArtSource || 'track',
  hasLastfm: !!config.lastfmKey,
  hasSpotify: !!(config.spotifyClientId && config.spotifyClientSecret),
  hasAI: !!(config.anthropicKey || config.openaiKey)
}));

app.post('/api/config', requireAuth, (req, res) => {
  const b = req.body;
  if (b.lastfmKey && !b.lastfmKey.includes('●')) config.lastfmKey = b.lastfmKey;
  if (b.spotifyClientId) config.spotifyClientId = b.spotifyClientId;
  if (b.spotifyClientSecret) config.spotifyClientSecret = b.spotifyClientSecret;
  if (b.openaiKey && !b.openaiKey.includes('●')) config.openaiKey = b.openaiKey;
  if (b.anthropicKey && !b.anthropicKey.includes('●')) config.anthropicKey = b.anthropicKey;
  if (b.aiProvider) config.aiProvider = b.aiProvider;
  if (b.musicDirs) config.musicDirs = b.musicDirs;
  if (b.messages) { config.messages = b.messages; if (config.marqueeMode !== 'rss') sharedState.messages = b.messages; }
  if (b.marqueeMode !== undefined) {
    config.marqueeMode = b.marqueeMode;
    sharedState.marqueeMode = b.marqueeMode;
    // If switching TO static mode, revert messages immediately
    if (b.marqueeMode === 'static') {
      sharedState.messages = config.messages;
      broadcastState();
    }
  }
  if (b.rssUrl !== undefined) config.rssUrl = b.rssUrl;
  if (b.bgArtSource) { config.bgArtSource = b.bgArtSource; sharedState.bgArtSource = b.bgArtSource; }
  saveConfig();

  // Immediately fetch RSS and broadcast if mode is rss
  if (config.marqueeMode === 'rss' && config.rssUrl) {
    sharedState.messages = ['📰 Loading RSS feed...'];
    broadcastState(); // Push placeholder immediately so display clears old messages
    fetchRSS(config.rssUrl).then(items => {
      if (items.length) {
        rssCache = { items, lastFetch: Date.now(), url: config.rssUrl };
        sharedState.messages = items.map(i => `📰 ${i.title}`);
        console.log(`[RSS] Loaded ${items.length} items on config save`);
      } else {
        sharedState.messages = ['📰 No RSS items found — check feed URL'];
      }
      broadcastState();
    }).catch(e => {
      console.error('[RSS] fetch on save failed:', e);
      sharedState.messages = [`📰 RSS error: ${e.message}`];
      broadcastState();
    });
  }

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

// ─── Music Source Instances (centralized) ────────────────────────────────────
// Updated Mar 2026 — comprehensive list from community instance trackers
// Piped: https://github.com/TeamPiped/Piped/wiki/Instances
// Invidious: https://docs.invidious.io/instances/
const SOURCES = {
  piped: [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.adminforge.de',
    'https://pipedapi.r4fo.com',
    'https://api.piped.yt',
    'https://pipedapi.darkness.services',
    'https://pipedapi.leptons.xyz',
    'https://pipedapi.drgns.space',
    'https://piped-api.lunar.icu',
    'https://pa.il.ax',
    'https://pipedapi.in.projectsegfau.lt',
  ],
  invidious: [
    'https://inv.nadeko.net',
    'https://iv.datura.network',
    'https://yewtu.be',
    'https://invidious.protokolla.fi',
    'https://inv.tux.pizza',
    'https://invidious.materialio.us',
    'https://yt.drgnz.club',
    'https://invidious.privacyredirect.com',
    'https://invidious.lunar.icu',
    'https://inv.in.projectsegfau.lt',
  ],
  cobalt: [
    'https://api.cobalt.tools',
  ],
  monochrome: [
    'https://api.monochrome.tf',
    'https://arran.monochrome.tf',
    'https://monochrome-api.samidy.com',
    'https://triton.squid.wtf',
    'https://wolf.qqdl.site',
    'https://maus.qqdl.site',
    'https://hifi-one.spotisaver.net',
    'https://tidal-api.binimum.org',
    'https://tidal.kinoplus.online',
  ],
  dab: ['https://api.zozoki.com']
};

// Track instance health
let instanceHealth = {};
function markInstance(url, ok, latency) {
  instanceHealth[url] = { ok, latency: latency||0, checkedAt: Date.now() };
}
function getHealthyInstances(list) {
  // Prefer instances with known-good status, then unknown, then known-bad
  return [...list].sort((a,b) => {
    const ha = instanceHealth[a], hb = instanceHealth[b];
    if (ha?.ok && !hb?.ok) return -1;
    if (!ha?.ok && hb?.ok) return 1;
    if (ha?.ok && hb?.ok) return (ha.latency||9999) - (hb.latency||9999);
    return 0;
  });
}

// ─── Monochrome / HiFi API — PRIMARY music source ──────────────────────────
app.get('/api/monochrome/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  console.log(`[Monochrome] Searching: "${q}"`);

  for (const inst of getHealthyInstances(SOURCES.monochrome)) {
    try {
      const start = Date.now();
      const r = await fetch(`${inst}/api/search?query=${encodeURIComponent(q)}&type=track&limit=5`, {
        signal: AbortSignal.timeout(6000),
        headers: { 'User-Agent': 'AutoDJ/4.0' }
      });
      if (!r.ok) { markInstance(inst, false); console.error(`[Monochrome] ${inst}: HTTP ${r.status}`); continue; }
      const data = await r.json();
      markInstance(inst, true, Date.now() - start);
      const tracks = (data.results || data.tracks || data.items || data.data || []).slice(0, 5);
      if (tracks.length > 0) {
        console.log(`[Monochrome] Found ${tracks.length} results via ${inst}`);
        return res.json(tracks.map(t => ({
          id: t.id || t.trackId || t.videoId,
          title: t.title || t.name || 'Unknown',
          artist: t.artist || t.artistName || t.uploaderName || t.author || 'Unknown',
          album: t.album || t.albumName || '',
          duration: t.duration || t.lengthSeconds || 0,
          thumbnail: t.thumbnail || t.cover || t.image || '',
          streamUrl: t.streamUrl || t.url || '',
          source: 'monochrome',
          instance: inst
        })));
      }
    } catch(e) { markInstance(inst, false); console.error(`[Monochrome] ${inst}: ${e.message}`); }
  }
  res.json([]);
});

app.get('/api/monochrome/stream/:id', async (req, res) => {
  const { id } = req.params;
  for (const inst of getHealthyInstances(SOURCES.monochrome)) {
    try {
      const r = await fetch(`${inst}/api/stream/${id}`, {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'AutoDJ/4.0', 'Range': req.headers.range || 'bytes=0-' }
      });
      if (!r.ok) continue;
      res.status(r.status);
      ['content-type','content-length','content-range','accept-ranges'].forEach(h => {
        const v = r.headers.get(h); if (v) res.setHeader(h, v);
      });
      res.setHeader('Access-Control-Allow-Origin', '*');
      r.body.pipe(res);
      return;
    } catch(e) { console.error(`[Monochrome] stream ${inst}: ${e.message}`); }
  }
  res.status(502).json({ error: 'No stream available' });
});

// ─── Unified Multi-Source Search — direct calls, no self-referencing ────────
app.get('/api/search/all', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ results: [], source: 'none' });
  console.log(`[Search] "${q}"`);

  // 1. Try Piped (most reliable for YouTube music)
  for (const inst of getHealthyInstances(SOURCES.piped)) {
    try {
      const start = Date.now();
      const url = `${inst}/search?q=${encodeURIComponent(q)}&filter=videos`;
      const r = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'AutoDJ/4.0' } });
      if (!r.ok) { markInstance(inst, false); continue; }
      const data = await r.json();
      markInstance(inst, true, Date.now() - start);
      const items = (data.items || []).filter(i => i.type === 'stream' || i.url).slice(0, 5);
      if (items.length > 0) {
        console.log(`[Search] Piped ${inst}: ${items.length} results`);
        return res.json({ results: items.map(i => ({
          id: (i.url || '').replace('/watch?v=','') || i.videoId || '',
          title: i.title || 'Unknown',
          artist: i.uploaderName || i.author || 'Unknown',
          duration: i.duration || 0,
          thumbnail: i.thumbnail || '',
          source: 'piped',
          instance: inst
        })), source: 'piped' });
      }
    } catch(e) { markInstance(inst, false); }
  }

  // 2. Try Invidious
  for (const inst of getHealthyInstances(SOURCES.invidious)) {
    try {
      const start = Date.now();
      const r = await fetch(`${inst}/api/v1/search?q=${encodeURIComponent(q)}&type=video`, {
        signal: AbortSignal.timeout(6000)
      });
      if (!r.ok) { markInstance(inst, false); continue; }
      const data = await r.json();
      markInstance(inst, true, Date.now() - start);
      if (Array.isArray(data) && data.length > 0) {
        console.log(`[Search] Invidious ${inst}: ${data.length} results`);
        return res.json({ results: data.slice(0, 5).map(i => ({
          id: i.videoId || '',
          title: i.title || 'Unknown',
          artist: i.author || 'Unknown',
          duration: i.lengthSeconds || 0,
          thumbnail: (i.videoThumbnails || [{}])[0]?.url || '',
          source: 'invidious'
        })), source: 'invidious' });
      }
    } catch(e) { markInstance(inst, false); }
  }

  // 3. Try Monochrome/HiFi
  for (const inst of getHealthyInstances(SOURCES.monochrome).slice(0, 4)) {
    try {
      const start = Date.now();
      const r = await fetch(`${inst}/api/search?query=${encodeURIComponent(q)}&type=track&limit=5`, {
        signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'AutoDJ/4.0' }
      });
      if (!r.ok) { markInstance(inst, false); continue; }
      const data = await r.json();
      markInstance(inst, true, Date.now() - start);
      const tracks = (data.results || data.tracks || data.items || data.data || []).slice(0, 5);
      if (tracks.length > 0) {
        console.log(`[Search] Monochrome ${inst}: ${tracks.length} results`);
        return res.json({ results: tracks.map(t => ({
          id: t.id || t.trackId || '',
          title: t.title || t.name || 'Unknown',
          artist: t.artist || t.artistName || 'Unknown',
          album: t.album || t.albumName || '',
          duration: t.duration || 0,
          thumbnail: t.thumbnail || t.cover || '',
          source: 'monochrome',
          instance: inst
        })), source: 'monochrome' });
      }
    } catch(e) { markInstance(inst, false); }
  }

  // 4. Try DAB/Zozoki
  for (const inst of SOURCES.dab) {
    try {
      const r = await fetch(`${inst}/api/search?query=${encodeURIComponent(q)}&type=track&limit=5`, {
        signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'AutoDJ/4.0' }
      });
      if (!r.ok) continue;
      const data = await r.json();
      const tracks = (data.results || data.tracks || data.data || []).slice(0, 5);
      if (tracks.length > 0) {
        console.log(`[Search] DAB: ${tracks.length} results`);
        return res.json({ results: tracks.map(t => ({
          id: t.id || '', title: t.title || t.name || 'Unknown', artist: t.artist || 'Unknown',
          duration: t.duration || 0, source: 'dab'
        })), source: 'dab' });
      }
    } catch(e) {}
  }

  console.warn(`[Search] No results for "${q}" from any source`);
  res.json({ results: [], source: 'none' });
});

// Legacy wrapper — converts unified results to the old {videoId, title, author} format
app.get('/api/youtube/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);

  // Call the same logic inline (no self-referencing fetch)
  // Try Piped first for video IDs
  for (const inst of getHealthyInstances(SOURCES.piped)) {
    try {
      const r = await fetch(`${inst}/search?q=${encodeURIComponent(q)}&filter=videos`, {
        signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'AutoDJ/4.0' }
      });
      if (!r.ok) { markInstance(inst, false); continue; }
      const data = await r.json();
      markInstance(inst, true);
      const items = (data.items || []).filter(i => i.type === 'stream' || i.url).slice(0, 5);
      if (items.length > 0) {
        return res.json(items.map(i => ({
          videoId: (i.url || '').replace('/watch?v=','') || i.videoId,
          title: i.title || 'Unknown',
          author: i.uploaderName || i.author || 'Unknown',
          lengthSeconds: i.duration || 0
        })));
      }
    } catch(e) { markInstance(inst, false); }
  }

  // Invidious fallback
  for (const inst of getHealthyInstances(SOURCES.invidious)) {
    try {
      const r = await fetch(`${inst}/api/v1/search?q=${encodeURIComponent(q)}&type=video`, {
        signal: AbortSignal.timeout(6000)
      });
      if (!r.ok) { markInstance(inst, false); continue; }
      const data = await r.json();
      markInstance(inst, true);
      if (Array.isArray(data) && data.length > 0) {
        return res.json(data.slice(0, 5).map(i => ({
          videoId: i.videoId, title: i.title || 'Unknown',
          author: i.author || 'Unknown', lengthSeconds: i.lengthSeconds || 0
        })));
      }
    } catch(e) { markInstance(inst, false); }
  }

  res.json([]);
});

// ─── Video Search — DAB API + Piped + Invidious (multi-fallback) ─────────────
// DAB API is a free music streaming API — primary source for audio
app.get('/api/dab/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  console.log(`[DAB] Searching: "${q}"`);
  for (const inst of SOURCES.dab) {
    try {
      const r = await fetch(`${inst}/api/search?query=${encodeURIComponent(q)}&type=track&limit=5`, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'AutoDJ/4.0' }
      });
      if (!r.ok) { console.error(`[DAB] ${inst}: HTTP ${r.status}`); continue; }
      const data = await r.json();
      const tracks = (data.results || data.tracks || data.data || []).slice(0, 5);
      if (tracks.length > 0) {
        console.log(`[DAB] Found ${tracks.length} results`);
        return res.json(tracks);
      }
    } catch(e) { console.error(`[DAB] ${inst} error: ${e.message}`); }
  }
  res.json([]);
});

app.get('/api/dab/stream', async (req, res) => {
  const { id, url: streamUrl } = req.query;
  if (!id && !streamUrl) return res.status(400).json({ error: 'Missing id or url' });
  for (const inst of SOURCES.dab) {
    try {
      const target = streamUrl || `${inst}/api/stream/${id}`;
      const r = await fetch(target, {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'AutoDJ/4.0', 'Range': req.headers.range || 'bytes=0-' }
      });
      if (!r.ok) continue;
      res.status(r.status);
      ['content-type','content-length','content-range','accept-ranges'].forEach(h => {
        const v = r.headers.get(h); if (v) res.setHeader(h, v);
      });
      res.setHeader('Access-Control-Allow-Origin', '*');
      r.body.pipe(res);
      return;
    } catch(e) { console.error(`[DAB] stream error: ${e.message}`); }
  }
  res.status(502).json({ error: 'Stream unavailable' });
});

// ─── MusicBrainz Proxy ──────────────────────────────────────────────────────
app.get('/api/musicbrainz/:endpoint(*)', async (req, res) => {
  try {
    const url = `https://musicbrainz.org/ws/2/${req.params.endpoint}?${new URLSearchParams({...req.query, fmt: 'json'})}`;
    console.log(`[MusicBrainz] ${url}`);
    const r = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'AutoDJ/3.0 (https://github.com/autodj)' }
    });
    if (!r.ok) return res.status(r.status).json({ error: `MusicBrainz HTTP ${r.status}` });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Discogs Proxy ──────────────────────────────────────────────────────────
app.get('/api/discogs/search', async (req, res) => {
  try {
    const params = new URLSearchParams(req.query);
    // Discogs allows some free API access without a token
    const url = `https://api.discogs.com/database/search?${params}`;
    console.log(`[Discogs] ${url}`);
    const r = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'AutoDJ/3.0' }
    });
    if (!r.ok) return res.status(r.status).json({ error: `Discogs HTTP ${r.status}` });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── API Service Testing ────────────────────────────────────────────────────
app.get('/api/test/services', requireAuth, async (req, res) => {
  const results = {};

  // Test Last.fm
  if (config.lastfmKey) {
    try {
      const r = await fetch(`https://ws.audioscrobbler.com/2.0/?method=chart.gettopartists&api_key=${config.lastfmKey}&format=json&limit=1`, { signal: AbortSignal.timeout(5000) });
      const d = await r.json();
      results.lastfm = d.error ? { ok: false, error: d.message } : { ok: true };
    } catch(e) { results.lastfm = { ok: false, error: e.message }; }
  } else { results.lastfm = { ok: false, error: 'No API key' }; }

  // Test Spotify
  if (config.spotifyClientId && config.spotifyClientSecret) {
    try {
      const token = await getSpotifyToken();
      results.spotify = token ? { ok: true } : { ok: false, error: 'Token failed' };
    } catch(e) { results.spotify = { ok: false, error: e.message }; }
  } else { results.spotify = { ok: false, error: 'No credentials' }; }

  // Test AI (Anthropic or OpenAI)
  if (config.aiProvider === 'anthropic' && config.anthropicKey) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: {'x-api-key':config.anthropicKey,'anthropic-version':'2023-06-01','content-type':'application/json'},
        body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user',content:'ping'}] })
      });
      results.ai = r.ok ? { ok: true, provider: 'anthropic' } : { ok: false, error: `HTTP ${r.status}`, provider: 'anthropic' };
    } catch(e) { results.ai = { ok: false, error: e.message, provider: 'anthropic' }; }
  } else if (config.aiProvider === 'openai' && config.openaiKey) {
    try {
      const r = await fetch('https://api.openai.com/v1/models', {
        signal: AbortSignal.timeout(5000),
        headers: { 'Authorization': `Bearer ${config.openaiKey}` }
      });
      results.ai = r.ok ? { ok: true, provider: 'openai' } : { ok: false, error: `HTTP ${r.status}`, provider: 'openai' };
    } catch(e) { results.ai = { ok: false, error: e.message, provider: 'openai' }; }
  } else { results.ai = { ok: false, error: 'No AI key configured' }; }

  // Test MusicBrainz (free, no key needed)
  try {
    const r = await fetch('https://musicbrainz.org/ws/2/artist?query=test&limit=1&fmt=json', {
      signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'AutoDJ/3.0 (https://github.com/autodj)' }
    });
    results.musicbrainz = r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
  } catch(e) { results.musicbrainz = { ok: false, error: e.message }; }

  // Test Discogs (free, limited)
  try {
    const r = await fetch('https://api.discogs.com/database/search?q=test&type=artist&per_page=1', {
      signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'AutoDJ/3.0' }
    });
    results.discogs = r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
  } catch(e) { results.discogs = { ok: false, error: e.message }; }

  // Test streaming instances (Monochrome + Piped + Invidious + DAB)
  results.sources = {};
  const sourceTests = [
    ...SOURCES.monochrome.slice(0,4).map(u => ({ url: u, type: 'monochrome', testUrl: `${u}/api/search?query=test&type=track&limit=1` })),
    ...SOURCES.piped.map(u => ({ url: u, type: 'piped', testUrl: `${u}/search?q=test&filter=videos` })),
    ...SOURCES.invidious.map(u => ({ url: u, type: 'invidious', testUrl: `${u}/api/v1/search?q=test&type=video` })),
    ...SOURCES.cobalt.map(u => ({ url: u, type: 'cobalt', testUrl: u })),
    ...SOURCES.dab.map(u => ({ url: u, type: 'dab', testUrl: `${u}/api/search?query=test&type=track&limit=1` })),
  ];
  for (const st of sourceTests) {
    try {
      const start = Date.now();
      const r = await fetch(st.testUrl, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'AutoDJ/4.0' } });
      const lat = Date.now() - start;
      markInstance(st.url, r.ok, lat);
      if (!results.sources[st.type]) results.sources[st.type] = [];
      results.sources[st.type].push({ url: st.url, ok: r.ok, latency: lat, status: r.ok ? 'up' : `http-${r.status}` });
    } catch(e) {
      markInstance(st.url, false);
      if (!results.sources[st.type]) results.sources[st.type] = [];
      results.sources[st.type].push({ url: st.url, ok: false, error: e.message, status: 'down' });
    }
  }

  // Count
  const services = ['lastfm','spotify','ai','musicbrainz','discogs'];
  const connected = services.filter(s => results[s]?.ok).length;
  const allSources = Object.values(results.sources).flat();
  const sourcesUp = allSources.filter(s => s.ok).length;
  results.summary = { connected, total: services.length, sourcesUp, sourcesTotal: allSources.length };

  res.json(results);
});

// ─── Playlists ───────────────────────────────────────────────────────────────
const PLAYLIST_DIR = path.join(__dirname, 'playlists');
if (!fs.existsSync(PLAYLIST_DIR)) fs.mkdirSync(PLAYLIST_DIR, { recursive: true });

app.get('/api/playlists', requireAuth, (req, res) => {
  try {
    const files = fs.readdirSync(PLAYLIST_DIR).filter(f => f.endsWith('.json'));
    const playlists = files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(PLAYLIST_DIR, f), 'utf8'));
        return { name: data.name || f.replace('.json',''), trackCount: (data.tracks||[]).length, createdAt: data.createdAt, filename: f };
      } catch(e) { return null; }
    }).filter(Boolean);
    res.json(playlists);
  } catch(e) { res.json([]); }
});

app.post('/api/playlists', requireAuth, (req, res) => {
  const { name, tracks } = req.body;
  if (!name || !tracks) return res.status(400).json({ error: 'name and tracks required' });
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const data = { name, tracks, createdAt: Date.now(), trackCount: tracks.length };
  fs.writeFileSync(path.join(PLAYLIST_DIR, `${safeName}.json`), JSON.stringify(data, null, 2));
  res.json({ ok: true, filename: `${safeName}.json` });
});

app.get('/api/playlists/:name', requireAuth, (req, res) => {
  const fp = path.join(PLAYLIST_DIR, `${req.params.name}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  try { res.json(JSON.parse(fs.readFileSync(fp, 'utf8'))); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/playlists/:name', requireAuth, (req, res) => {
  const fp = path.join(PLAYLIST_DIR, `${req.params.name}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(fp);
  res.json({ ok: true });
});

// ─── Song Requests (from display page listeners) ────────────────────────────
let songRequests = [];

app.post('/api/requests', (req, res) => {
  const { artist, title, message } = req.body;
  if (!artist && !title) return res.status(400).json({ error: 'Provide artist or title' });
  songRequests.push({ id: Date.now(), artist: artist||'', title: title||'', message: message||'', timestamp: Date.now() });
  if (songRequests.length > 50) songRequests = songRequests.slice(-50);
  // Broadcast to DJ page
  sharedState.requestCount = songRequests.length;
  broadcastState();
  res.json({ ok: true });
});

app.get('/api/requests', requireAuth, (req, res) => {
  res.json(songRequests);
});

app.delete('/api/requests/:id', requireAuth, (req, res) => {
  songRequests = songRequests.filter(r => r.id !== parseInt(req.params.id));
  sharedState.requestCount = songRequests.length;
  broadcastState();
  res.json({ ok: true });
});

// ─── Health Endpoint (public) ────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    listeners: sseClients.size,
    memory: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed },
    instanceHealth: Object.entries(instanceHealth).map(([url, h]) => ({
      url, ...h, age: Date.now() - (h.checkedAt || 0)
    })),
    pendingRequests: songRequests.length
  });
});

// ─── Piped stream URL resolver (gets direct audio stream) ─────────────────────
app.get('/api/piped/streams', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: 'Missing videoId' });
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`[Stream] Resolving audio for ${videoId}`);

  // 1. Try Piped instances
  for (const instance of getHealthyInstances(SOURCES.piped)) {
    try {
      const r = await fetch(`${instance}/streams/${videoId}`, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'AutoDJ/4.0' }
      });
      if (!r.ok) { markInstance(instance, false); continue; }
      const data = await r.json();
      markInstance(instance, true);
      if (data.audioStreams && data.audioStreams.length > 0) {
        const sorted = data.audioStreams.sort((a,b) => (b.bitrate||0)-(a.bitrate||0));
        console.log(`[Stream] Piped ${instance}: ${sorted.length} audio streams`);
        return res.json({
          title: data.title, uploader: data.uploader,
          duration: data.duration, thumbnail: data.thumbnailUrl,
          audioStreams: sorted.slice(0, 3).map(s => ({
            url: s.url, mimeType: s.mimeType, bitrate: s.bitrate, quality: s.quality
          }))
        });
      }
    } catch(e) { markInstance(instance, false); }
  }

  // 2. Try Cobalt API (https://cobalt.tools) — reliable audio extraction
  for (const inst of SOURCES.cobalt) {
    try {
      console.log(`[Stream] Trying Cobalt: ${inst}`);
      const r = await fetch(`${inst}/`, {
        method: 'POST',
        signal: AbortSignal.timeout(12000),
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: ytUrl, downloadMode: 'audio', audioFormat: 'mp3' })
      });
      if (!r.ok) { console.error(`[Stream] Cobalt HTTP ${r.status}`); continue; }
      const data = await r.json();
      if (data.url || data.audio) {
        const streamUrl = data.url || data.audio;
        console.log(`[Stream] Cobalt success`);
        return res.json({
          title: data.filename || videoId, uploader: '',
          duration: 0, thumbnail: '',
          audioStreams: [{ url: streamUrl, mimeType: 'audio/mpeg', bitrate: 128000, quality: 'cobalt' }]
        });
      }
    } catch(e) { console.error(`[Stream] Cobalt error: ${e.message}`); }
  }

  // 3. Try Invidious for direct audio link
  for (const inst of getHealthyInstances(SOURCES.invidious)) {
    try {
      console.log(`[Stream] Trying Invidious: ${inst}`);
      const r = await fetch(`${inst}/api/v1/videos/${videoId}`, {
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) { markInstance(inst, false); continue; }
      const data = await r.json();
      markInstance(inst, true);
      const audioFormats = (data.adaptiveFormats || [])
        .filter(f => f.type?.startsWith('audio/'))
        .sort((a,b) => (b.bitrate||0) - (a.bitrate||0));
      if (audioFormats.length > 0) {
        console.log(`[Stream] Invidious ${inst}: ${audioFormats.length} audio formats`);
        return res.json({
          title: data.title || videoId, uploader: data.author || '',
          duration: data.lengthSeconds || 0,
          thumbnail: (data.videoThumbnails||[])[0]?.url || '',
          audioStreams: audioFormats.slice(0, 3).map(f => ({
            url: f.url, mimeType: f.type?.split(';')[0] || 'audio/webm',
            bitrate: f.bitrate || 0, quality: f.audioQuality || 'invidious'
          }))
        });
      }
    } catch(e) { markInstance(inst, false); }
  }

  console.error(`[Stream] ALL sources failed for ${videoId}`);
  res.status(404).json({ error: 'No streams found from any source' });
});

// ─── Audio Stream Proxy (solves CORS for WebAudio) ────────────────────────
// Client requests /api/stream/proxy?url=<encoded_url> and the server pipes it through
app.get('/api/stream/proxy', async (req, res) => {
  const { url: streamUrl } = req.query;
  if (!streamUrl) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    const headers = { 'User-Agent': 'AutoDJ/4.0' };
    if (req.headers.range) headers['Range'] = req.headers.range;

    const upstream = await fetch(streamUrl, {
      signal: AbortSignal.timeout(30000),
      headers
    });

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).json({ error: `Upstream HTTP ${upstream.status}` });
    }

    // Forward content headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (upstream.headers.get('content-type')) res.setHeader('Content-Type', upstream.headers.get('content-type'));
    if (upstream.headers.get('content-length')) res.setHeader('Content-Length', upstream.headers.get('content-length'));
    if (upstream.headers.get('content-range')) res.setHeader('Content-Range', upstream.headers.get('content-range'));
    if (upstream.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges'));
    res.status(upstream.status);

    // Pipe the stream
    const reader = upstream.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        if (!res.write(value)) {
          await new Promise(resolve => res.once('drain', resolve));
        }
      }
    };
    pump().catch(() => res.end());

    req.on('close', () => { try { reader.cancel(); } catch(e) {} });
  } catch(e) {
    console.error(`[StreamProxy] Error: ${e.message}`);
    if (!res.headersSent) res.status(502).json({ error: e.message });
  }
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

// ─── Instance Health Check ──────────────────────────────────────────────────
app.get('/api/instances/test', async (req, res) => {
  const pipedInstances = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.tokhmi.xyz',
    'https://pipedapi.moomoo.me',
    'https://pipedapi.syncpundit.io',
  ];
  const invidiousInstances = [
    'https://inv.nadeko.net',
    'https://yewtu.be',
    'https://invidious.nerdvpn.de',
  ];

  const results = { piped: [], invidious: [] };

  for (const inst of pipedInstances) {
    try {
      const start = Date.now();
      const r = await fetch(`${inst}/search?q=test&filter=videos`, {
        signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'AutoDJ/2.0' }
      });
      results.piped.push({ url: inst, status: r.ok ? 'up' : `http-${r.status}`, latency: Date.now() - start });
    } catch(e) {
      results.piped.push({ url: inst, status: 'down', error: e.message });
    }
  }

  for (const inst of invidiousInstances) {
    try {
      const start = Date.now();
      const r = await fetch(`${inst}/api/v1/search?q=test&type=video`, {
        signal: AbortSignal.timeout(5000)
      });
      results.invidious.push({ url: inst, status: r.ok ? 'up' : `http-${r.status}`, latency: Date.now() - start });
    } catch(e) {
      results.invidious.push({ url: inst, status: 'down', error: e.message });
    }
  }

  res.json(results);
});

// ─── RSS Proxy ───────────────────────────────────────────────────────────────
let rssCache = { items: [], lastFetch: 0 };

async function fetchRSS(url) {
  if (!url) return [];
  try {
    console.log(`[RSS] Fetching: ${url}`);
    const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'AutoDJ/3.0' } });
    if (!r.ok) { console.error(`[RSS] HTTP ${r.status}`); return []; }
    const xml = await r.text();
    // Simple XML parsing for RSS items
    const items = [];
    const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < 30) {
      const block = match[1];
      const getTag = (tag) => { const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/${tag}>`, 'is')); return m ? m[1].trim() : ''; };
      const title = getTag('title');
      const link = getTag('link');
      if (title) items.push({ title, link });
    }
    console.log(`[RSS] Parsed ${items.length} items`);
    return items;
  } catch(e) { console.error(`[RSS] Error: ${e.message}`); return []; }
}

app.get('/api/rss/proxy', async (req, res) => {
  const url = req.query.url || config.rssUrl;
  if (!url) return res.json({ items: [] });
  // Cache for 5 minutes
  if (Date.now() - rssCache.lastFetch < 5 * 60 * 1000 && rssCache.url === url && rssCache.items.length) {
    return res.json({ items: rssCache.items });
  }
  const items = await fetchRSS(url);
  rssCache = { items, lastFetch: Date.now(), url };
  res.json({ items });
});

// Auto-refresh RSS every 5 min and broadcast if in RSS mode
setInterval(async () => {
  if (config.marqueeMode === 'rss' && config.rssUrl) {
    const items = await fetchRSS(config.rssUrl);
    if (items.length) {
      rssCache = { items, lastFetch: Date.now(), url: config.rssUrl };
      sharedState.messages = items.map(i => `📰 ${i.title}`);
      broadcastState();
    }
  }
}, 5 * 60 * 1000);

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
app.get('/api/listeners', (req, res) => res.json({ count: sseClients.size }));
app.post('/api/nowplaying/update', (req, res) => {
  const prev = sharedState.nowPlaying;
  Object.assign(sharedState, req.body);
  // Track recently played
  if (req.body.nowPlaying && prev && prev.title !== req.body.nowPlaying.title) {
    if (!sharedState.recentlyPlayed) sharedState.recentlyPlayed = [];
    sharedState.recentlyPlayed.unshift({ title: prev.title, artist: prev.artist, playedAt: Date.now() });
    if (sharedState.recentlyPlayed.length > 10) sharedState.recentlyPlayed = sharedState.recentlyPlayed.slice(0, 10);
  }
  broadcastState();
  res.json({ ok: true });
});
app.get('/api/nowplaying', (req, res) => res.json(sharedState));

// ─── Pages ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/dj');
  res.redirect('/login');
});
app.get('/dj', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'dj.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'display.html')));

// PWA manifest
app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'AutoDJ',
    short_name: 'AutoDJ',
    description: 'Web-based DJ console with live display',
    start_url: '/display',
    display: 'standalone',
    background_color: '#03050a',
    theme_color: '#00e5ff',
    icons: [
      { src: '/icon-192.svg', sizes: '192x192', type: 'image/svg+xml' },
      { src: '/icon-512.svg', sizes: '512x512', type: 'image/svg+xml' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
    ]
  });
});

// PWA icons — generate on the fly
function makeIconSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${Math.round(size*0.15)}" fill="#03050a"/>
  <circle cx="${size/2}" cy="${size/2}" r="${Math.round(size*0.35)}" fill="none" stroke="#00e5ff" stroke-width="${Math.max(2,Math.round(size*0.02))}"/>
  <circle cx="${size/2}" cy="${size/2}" r="${Math.round(size*0.22)}" fill="none" stroke="#00e5ff" stroke-width="${Math.max(1,Math.round(size*0.015))}" opacity="0.5"/>
  <circle cx="${size/2}" cy="${size/2}" r="${Math.round(size*0.06)}" fill="#00e5ff"/>
  <text x="${size/2}" y="${Math.round(size*0.88)}" text-anchor="middle" fill="#00e5ff" font-family="Arial,sans-serif" font-weight="bold" font-size="${Math.round(size*0.1)}">AutoDJ</text>
</svg>`;
}
app.get('/icon-192.svg', (req, res) => { res.setHeader('Content-Type','image/svg+xml'); res.send(makeIconSvg(192)); });
app.get('/icon-512.svg', (req, res) => { res.setHeader('Content-Type','image/svg+xml'); res.send(makeIconSvg(512)); });
app.get('/icon.svg', (req, res) => { res.setHeader('Content-Type','image/svg+xml'); res.send(makeIconSvg(512)); });
app.get('/icon-192.png', (req, res) => { res.setHeader('Content-Type','image/svg+xml'); res.send(makeIconSvg(192)); }); // fallback for apple-touch-icon

// PWA service worker
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(`
const CACHE = 'autodj-v4';
const PRECACHE = ['/display', '/css/shared.css', '/icon.svg', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Never cache API calls or SSE
  if (url.pathname.startsWith('/api/')) return;
  // Network-first for HTML pages, cache-first for assets
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(r => {
      const clone = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return r;
    }).catch(() => caches.match(e.request)));
  } else {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
      const clone = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return resp;
    })));
  }
});
  `.trim());
});

app.listen(PORT, () => {
  console.log(`\n🎧 AutoDJ running at http://localhost:${PORT}`);
  console.log(`   DJ Console  →  http://localhost:${PORT}/dj`);
  console.log(`   Now Playing →  http://localhost:${PORT}/display\n`);

  // Fetch RSS on startup if configured
  if (config.marqueeMode === 'rss' && config.rssUrl) {
    fetchRSS(config.rssUrl).then(items => {
      if (items.length) {
        rssCache = { items, lastFetch: Date.now(), url: config.rssUrl };
        sharedState.messages = items.map(i => `📰 ${i.title}`);
        broadcastState();
        console.log(`[RSS] Loaded ${items.length} items on startup`);
      }
    }).catch(()=>{});
  }
});
