const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cors = require('cors');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const multer = require('multer');
const { XMLParser } = require('fast-xml-parser');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_DEV = process.env.NODE_ENV !== 'production';

/** Structured log lines for operators / debugging. */
const logRing = [];
const MAX_LOG_ENTRIES = 500;
function log(tag, ...args) {
  console.log(`[AutoDJ][${tag}]`, ...args);
  const msg = args.map(a => String(a)).join(' ');
  logRing.push({ ts: Date.now(), tag, level: tag === 'Cache' ? 'info' : tag.toLowerCase().includes('err') ? 'error' : 'info', message: msg });
  if (logRing.length > MAX_LOG_ENTRIES) logRing.splice(0, logRing.length - MAX_LOG_ENTRIES);
}

const MAX_REASONABLE_TRACK_SEC = 6 * 3600;
/** Normalize a possibly-millisecond duration to seconds, clamped to MAX_REASONABLE_TRACK_SEC. */
function normalizeTrackDurationSeconds(duration, durationMs) {
  let sec = 0;
  if (durationMs != null && Number.isFinite(Number(durationMs)) && Number(durationMs) > 0) {
    sec = Number(durationMs) / 1000;
  } else if (duration != null && Number.isFinite(Number(duration))) {
    let d = Number(duration);
    if (d < 5) d = 0;
    else if (d > 120 && d < 1e12) d /= 1000;
    if (d < 10) d = 0;
    sec = d;
  }
  if (!Number.isFinite(sec) || sec < 1) return 0;
  return Math.min(Math.round(sec), MAX_REASONABLE_TRACK_SEC);
}

const METUBE_BASE = (process.env.METUBE_URL || '').replace(/\/+$/, '');
const METUBE_DOWNLOADS_DIR = process.env.METUBE_DOWNLOADS_DIR || '';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// ─── Rate Limiter ──────────────────────────────────────────────────────────────
const rateStore = new Map();
setInterval(() => { const now = Date.now(); for (const [k, timestamps] of rateStore) { const valid = timestamps.filter(t => now - t < 60000); if (valid.length) rateStore.set(k, valid); else rateStore.delete(k); } }, 60000);
function rateLimit(maxPerMinute = 60) {
  return (req, res, next) => {
    const key = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const timestamps = (rateStore.get(key) || []).filter(t => now - t < 60000);
    if (timestamps.length >= maxPerMinute) return res.status(429).json({ error: 'Too many requests, slow down' });
    timestamps.push(now);
    rateStore.set(key, timestamps);
    next();
  };
}

// ─── Temp Upload Storage ──────────────────────────────────────────────────────
const TEMP_DIR = path.join(os.tmpdir(), 'autodj-temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TEMP_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9.\-_ ]/g,'_')}`)
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['.mp3','.flac','.wav','.ogg','.m4a','.aac','.opus','.wma'].includes(path.extname(file.originalname).toLowerCase()))
});
let tempFiles = [];
function cleanExpiredTempFiles() {
  const retentionMs = (config.tempFileRetentionHours || 1) * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;
  tempFiles = tempFiles.filter(tf => { if (tf.uploadedAt < cutoff) { try { fs.unlinkSync(tf.filepath); } catch(e) {} return false; } return true; });
}

// ─── Download Cache ────────────────────────────────────────────────────────
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
let audioCache = [];
let downloadCounter = 0;
function cleanTempAfterDownloads() {
  downloadCounter++;
  if (downloadCounter >= 25) {
    downloadCounter = 0;
    cleanExpiredTempFiles();
    // Also remove oldest half of temp files
    const sorted = [...tempFiles].sort((a, b) => a.uploadedAt - b.uploadedAt);
    const toRemove = sorted.slice(0, Math.max(0, sorted.length - 5));
    for (const tf of toRemove) {
      try { if (tf.filepath) fs.unlinkSync(tf.filepath); } catch (e) {}
      tempFiles = tempFiles.filter(t => t !== tf);
    }
    log('Cache', `Auto-cleaned ${toRemove.length} old temp files (after ${downloadCounter} downloads)`);
  }
}
function cleanCache() {
  const played = audioCache.filter(e => e.playedAt).sort((a,b) => a.playedAt - b.playedAt);
  while (played.length > 4) {
    const old = played.shift();
    try { if (old.filepath && fs.existsSync(old.filepath)) fs.unlinkSync(old.filepath); } catch(e) {}
    audioCache = audioCache.filter(e => e.id !== old.id);
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = {
  lastfmKey: process.env.LASTFM_API_KEY || '',
  jamendoClientId: process.env.JAMENDO_CLIENT_ID || '',
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID || '',
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
  openaiKey: process.env.OPENAI_API_KEY || '',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  opencodeKey: process.env.OPENCODE_API_KEY || '',
  opencodeBaseUrl: process.env.OPENCODE_BASE_URL || '',
  opencodeModel: 'opencode-model',
  aiProvider: 'anthropic',
  musicDirs: process.env.MUSIC_DIR ? [process.env.MUSIC_DIR] : [path.join(__dirname, 'music')],
  messages: ["🎵 Vibes are immaculate tonight","🔊 AutoDJ is live","🎧 Peak vibes engaged","💿 Hand-selected by algorithms","🕺 You should be dancing right now","🎶 This song is better loud","🌊 Riding the wave"],
  /** Optional: [{ name, searchUrlTemplate, streamUrlTemplate }] — operators must configure URLs they are entitled to use. */
  squidProxies: [],
  invidiousRedirector: '',
  metubeFirst: true,
  preDownloadCount: 5,
  maxConcurrentDownloads: 3,
  maxTrackMinutes: 0,
  fadeAtPercent: 80,
  sourcePriority: [],
  tempFileRetentionHours: 1,
  rssFeedUrl: '',
  marqueeMode: 'rss',
  filterTopicChannels: true,
  sessionDuration: 0,
  queueLimit: 0
};
if (fs.existsSync(CONFIG_FILE)) { try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8'))); } catch(e) { log('Config', `WARNING: Failed to parse config.json — ${e.message}. Using defaults.`); } }
if (!Array.isArray(config.squidProxies)) config.squidProxies = [];
function saveConfig() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }

/** Safe on-disk filename for cache entries (preserves logical id in audioCache[].id). */
function safeCacheBasename(id) { return String(id).replace(/[^a-zA-Z0-9._-]/g, '_'); }
function cachePathForId(id, ext) { return path.join(CACHE_DIR, safeCacheBasename(id) + ext); }

// ─── Shared State (SSE) ──────────────────────────────────────────────────────
let sharedState = {
  nowPlaying: null, nextUp: null, primaryDeck: 'a',
  decks: { a: null, b: null },
  genre: '', messages: config.messages, queue: [], isPlaying: false, isFading: false,
  trackIndex: -1, sessionActive: false, playerMode: 'idle',
  sessionStart: null,
  playedIds: [],
  config: { rssFeedUrl: config.rssFeedUrl || '', marqueeMode: config.marqueeMode || 'rss', filterTopicChannels: config.filterTopicChannels !== false, sessionDuration: config.sessionDuration || 0, queueLimit: config.queueLimit || 0 }
};
const sseClients = new Map();
let sseIdCounter = 0;
function broadcastState() { const d = JSON.stringify(sharedState); for (const [id, c] of sseClients) { try { c.res.write(`data: ${d}\n\n`); } catch(e) { sseClients.delete(id); } } }
function broadcastCommand(cmd, extra = {}) { const d = JSON.stringify({ ...sharedState, command: cmd, ...extra }); for (const [id, c] of sseClients) { try { c.res.write(`data: ${d}\n\n`); } catch(e) { sseClients.delete(id); } } }

let playbackTimer = null;
function clearPlaybackTimer() { if (playbackTimer) { clearTimeout(playbackTimer); playbackTimer = null; } }

async function preCacheNextTrack() {
  const nextIdx = sharedState.trackIndex + 1;
  if (nextIdx < 0 || nextIdx >= sharedState.queue.length) return null;
  const next = sharedState.queue[nextIdx];
  if (!next || !next.youtubeId) return next;
  try {
    const existing = audioCache.find(e => e.id === next.youtubeId);
    if (existing?.filepath && fs.existsSync(existing.filepath)) return next;
    const host = `http://127.0.0.1:${PORT}`;
    const r = await fetch(`${host}/api/cache/download`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: next.youtubeId, title: next.title, artist: next.artist, _source: next._source || '', _instance: next._instance || '' })
    });
    if (r.ok) log('Playback', `Pre-cached next: ${next.title}`);
  } catch (e) { log('Playback', `Pre-cache failed: ${e.message}`); }
  return next;
}

async function advanceTrack() {
  // Check session expiry
  if (config.sessionDuration > 0 && sharedState.sessionStart) {
    const elapsed = (Date.now() - sharedState.sessionStart) / 3600000;
    if (elapsed >= config.sessionDuration) {
      log('Playback', `Session expired (${elapsed.toFixed(1)}h > ${config.sessionDuration}h)`);
      stopPlayback();
      return;
    }
  }
  if (sharedState.queue.length === 0) { stopPlayback(); return; }
  sharedState.trackIndex++;
  if (sharedState.trackIndex >= sharedState.queue.length) {
    log('Playback', 'Queue exhausted');
    stopPlayback();
    return;
  }

  const track = sharedState.queue[sharedState.trackIndex];
  sharedState.nowPlaying = { title: track.title || '', artist: track.artist || '', duration: track.duration || 0, elapsed: 0, youtubeId: track.youtubeId || null, artwork: track.artwork || '', album: track.album || '', tags: track.tags || [] };
  sharedState.nextUp = sharedState.queue[sharedState.trackIndex + 1] || null;
  sharedState.isPlaying = true;

  // Build stream URL
  let streamUrl = '';
  if (track.type === 'local' || track.type === 'temp') {
    streamUrl = track.url || '';
  } else if (track.youtubeId) {
    const cached = audioCache.find(e => e.id === track.youtubeId);
    if (cached?.filepath) streamUrl = `/api/cache/stream/${encodeURIComponent(track.youtubeId)}`;
  }

  log('Playback', `▶ ${track.title} (track ${sharedState.trackIndex + 1}/${sharedState.queue.length})`);

  // Broadcast play command
  broadcastCommand('play', { url: streamUrl });

  // Auto-advance timer (headless fallback only — display clients use relay ended-event)
  if (sseClients.size === 0) {
    const dur = (track.duration && Number.isFinite(track.duration) && track.duration > 0) ? track.duration : 0;
    if (dur > 5) {
      const fadeSec = 8;
      const advIn = Math.max(1, dur - fadeSec) * 1000;
      playbackTimer = setTimeout(async () => {
        await preCacheNextTrack();
        advanceTrack();
      }, advIn);
    }
  }

  // Pre-cache next track
  preCacheNextTrack();
}

async function startPlayback() {
  if (sharedState.queue.length === 0) return { error: 'Queue empty' };
  if (sharedState.trackIndex < 0 || sharedState.trackIndex >= sharedState.queue.length) {
    sharedState.trackIndex = -1; // advanceTrack() will increment to 0
  } else {
    sharedState.trackIndex--; // counteract advanceTrack()'s ++
  }
  sharedState.sessionActive = true;
  sharedState.sessionStart = Date.now();
  sharedState.playerMode = sseClients.size > 0 ? 'display' : 'headless';
  log('Playback', `Session started (${sseClients.size} listener(s), trackIndex will be ${sharedState.trackIndex + 1})`);
  saveQueueToDisk(sharedState.queue);
  await advanceTrack();
  return { ok: true };
}

function stopPlayback() {
  clearPlaybackTimer();
  sharedState.isPlaying = false;
  sharedState.sessionActive = false;
  sharedState.sessionStart = null;
  sharedState.playerMode = 'idle';
  broadcastCommand('stop');
  log('Playback', 'Stopped');
}

// Browser-like UA: many CDNs / Invidious / Piped block datacenter defaults; DAB sits behind Cloudflare.
const MUSIC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
function musicHeaders(more = {}) {
  return { 'User-Agent': MUSIC_UA, Accept: 'application/json, */*', ...more };
}

// ─── Music Sources (live-tested May 2026; rotate via getHealthy) ──────────
const SOURCES = {
  dab: ['https://dabmusic.xyz/api', 'https://dab.yeet.su/api'],
  hifi: ['https://wolf.qqdl.site','https://maus.qqdl.site','https://katze.qqdl.site','https://hund.qqdl.site','https://vogel.qqdl.site','https://triton.squid.wtf','https://tidal-api.binimum.org','https://tidal.kinoplus.online'],
  piped: [
    'https://api.piped.private.coffee',
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.adminforge.de',
    'https://api.piped.yt',
    'https://pipedapi.leptons.xyz',
    'https://piped-api.privacy.com.de',
  ],
  invidious: [
    'https://inv.thepixora.com',
    'https://yt.chocolatemoo53.com',
    'https://yewtu.be',
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
  ],
};
/** User-configured Invidious base URL is tried first (e.g. self-hosted or redirector you trust). */
function invidiousInstances() {
  const u = config.invidiousRedirector && String(config.invidiousRedirector).trim();
  const extra = u ? [u] : [];
  return [...extra, ...SOURCES.invidious];
}

// Source ordering helpers
const SOURCE_KEYS = ['metube', 'invidious', 'piped', 'dab', 'hifi', 'jamendo', 'squid'];

function sourcePriority() {
  if (Array.isArray(config.sourcePriority) && config.sourcePriority.length > 0) {
    const valid = config.sourcePriority.filter(s => SOURCE_KEYS.includes(s));
    const missing = SOURCE_KEYS.filter(s => !config.sourcePriority.includes(s));
    return [...valid, ...missing];
  }
  return SOURCE_KEYS;
}
let instanceHealth = {};
function markInst(url, ok, lat) { instanceHealth[url] = { ok, latency: lat||0, at: Date.now() }; }
function getHealthy(list) {
  return [...list].sort((a,b) => {
    const ha = instanceHealth[a], hb = instanceHealth[b];
    if (ha?.ok && !hb?.ok) return -1; if (!ha?.ok && hb?.ok) return 1;
    if (ha?.ok && hb?.ok) return (ha.latency||9999) - (hb.latency||9999); return 0;
  });
}

// ─── Config API ──────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => res.json({
  lastfmKey: config.lastfmKey ? '●●●set●●●' : '', jamendoClientId: config.jamendoClientId ? '●●●set●●●' : '',
  spotifyClientId: config.spotifyClientId || '',
  openaiKey: config.openaiKey ? '●●●set●●●' : '', anthropicKey: config.anthropicKey ? '●●●set●●●' : '', opencodeKey: config.opencodeKey ? '●●●set●●●' : '',
  opencodeBaseUrl: config.opencodeBaseUrl || '',
  opencodeModel: config.opencodeModel || 'opencode-model',
  aiProvider: config.aiProvider, musicDirs: config.musicDirs, messages: config.messages,
  invidiousRedirector: config.invidiousRedirector || '',
  squidProxies: Array.isArray(config.squidProxies) ? config.squidProxies : [],
  hasLastfm: !!config.lastfmKey, hasJamendo: !!config.jamendoClientId, hasSpotify: !!(config.spotifyClientId && config.spotifyClientSecret), hasAI: !!(config.anthropicKey || config.openaiKey || config.opencodeKey),
  hasMetube: !!(METUBE_BASE && METUBE_DOWNLOADS_DIR), hasSquid: !!(Array.isArray(config.squidProxies) && config.squidProxies.length),
  metubeFirst: config.metubeFirst !== false,
  preDownloadCount: config.preDownloadCount || 5,
  maxConcurrentDownloads: config.maxConcurrentDownloads || 3,
  maxTrackMinutes: config.maxTrackMinutes || 0,
  fadeAtPercent: config.fadeAtPercent || 80,
  sourcePriority: Array.isArray(config.sourcePriority) ? config.sourcePriority : [],
  tempFileRetentionHours: config.tempFileRetentionHours || 1,
  rssFeedUrl: config.rssFeedUrl || '',
  marqueeMode: config.marqueeMode || 'rss',
  filterTopicChannels: config.filterTopicChannels !== false
}));
app.post('/api/config', (req, res) => {
  const b = req.body;
  if (b.lastfmKey && !b.lastfmKey.includes('●')) config.lastfmKey = b.lastfmKey;
  if (b.jamendoClientId !== undefined && !String(b.jamendoClientId).includes('●')) config.jamendoClientId = String(b.jamendoClientId).trim();
  if (b.spotifyClientId) config.spotifyClientId = b.spotifyClientId;
  if (b.spotifyClientSecret) config.spotifyClientSecret = b.spotifyClientSecret;
  if (b.openaiKey && !b.openaiKey.includes('●')) config.openaiKey = b.openaiKey;
  if (b.anthropicKey && !b.anthropicKey.includes('●')) config.anthropicKey = b.anthropicKey;
  if (b.opencodeKey && !b.opencodeKey.includes('●')) config.opencodeKey = b.opencodeKey;
  if (b.opencodeBaseUrl !== undefined) config.opencodeBaseUrl = String(b.opencodeBaseUrl || '').trim();
  if (b.opencodeModel !== undefined) config.opencodeModel = String(b.opencodeModel || 'opencode-model').trim();
  if (b.aiProvider) config.aiProvider = b.aiProvider;
  if (b.musicDirs) config.musicDirs = b.musicDirs;
  if (b.messages) { config.messages = b.messages; sharedState.messages = b.messages; }
  if (b.invidiousRedirector !== undefined) config.invidiousRedirector = String(b.invidiousRedirector || '').trim();
  if (b.squidProxies !== undefined) {
    if (Array.isArray(b.squidProxies)) config.squidProxies = b.squidProxies;
    else if (typeof b.squidProxies === 'string') {
      try { const p = JSON.parse(b.squidProxies); if (Array.isArray(p)) config.squidProxies = p; } catch (_) {}
    }
  }
  if (b.metubeFirst !== undefined) config.metubeFirst = !!b.metubeFirst;
  if (b.preDownloadCount !== undefined) config.preDownloadCount = Math.max(1, Math.min(20, parseInt(b.preDownloadCount) || 5));
  if (b.maxConcurrentDownloads !== undefined) config.maxConcurrentDownloads = Math.max(1, Math.min(10, parseInt(b.maxConcurrentDownloads) || 3));
  if (b.maxTrackMinutes !== undefined) config.maxTrackMinutes = Math.max(0, parseInt(b.maxTrackMinutes) || 0);
  if (b.fadeAtPercent !== undefined) config.fadeAtPercent = Math.max(10, Math.min(100, parseInt(b.fadeAtPercent) || 80));
  if (b.sourcePriority !== undefined && Array.isArray(b.sourcePriority)) config.sourcePriority = b.sourcePriority;
  if (b.tempFileRetentionHours !== undefined) config.tempFileRetentionHours = Math.max(1, parseInt(b.tempFileRetentionHours) || 1);
  if (b.rssFeedUrl !== undefined) { config.rssFeedUrl = String(b.rssFeedUrl || '').trim(); sharedState.config.rssFeedUrl = config.rssFeedUrl; }
  if (b.marqueeMode !== undefined) { config.marqueeMode = ['rss','messages','both'].includes(b.marqueeMode) ? b.marqueeMode : 'rss'; sharedState.config.marqueeMode = config.marqueeMode; }
  if (b.filterTopicChannels !== undefined) { config.filterTopicChannels = !!b.filterTopicChannels; sharedState.config.filterTopicChannels = config.filterTopicChannels; }
  if (b.sessionDuration !== undefined) { config.sessionDuration = Math.max(0, parseInt(b.sessionDuration) || 0); sharedState.config.sessionDuration = config.sessionDuration; }
  if (b.queueLimit !== undefined) { config.queueLimit = Math.max(0, parseInt(b.queueLimit) || 0); sharedState.config.queueLimit = config.queueLimit; }
  saveConfig(); res.json({ ok: true });
});

// ─── Local Music ──────────────────────────────────────────────────────────────
const AUDIO_EXTS = ['.mp3','.flac','.wav','.ogg','.m4a','.aac','.opus','.wma'];
function scanDir(dir) { const r=[]; if (!fs.existsSync(dir)) return r; const walk=(d)=>{try{for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.isDirectory())walk(f);else if(AUDIO_EXTS.includes(path.extname(e.name).toLowerCase()))r.push(f);}}catch(e){}}; walk(dir); return r; }
app.get('/api/local/scan', (req, res) => {
  const all = []; for (const dir of config.musicDirs) all.push(...scanDir(dir));
  res.json(all.map(fp => {
    const rel = (config.musicDirs||[]).reduce((acc, d) => {
      const resolved = path.resolve(d);
      return acc.startsWith(resolved) ? acc.slice(resolved.length).replace(/^[\\/]/, '') : acc;
    }, fp);
    const n=path.basename(fp,path.extname(fp)),p=n.split(' - ');
    try { const size = fs.statSync(fp).size; return { type:'local', path:rel, filename:path.basename(fp), size, title:p.length>=2?p.slice(1).join(' - '):n, artist:p.length>=2?p[0]:'Unknown', album:'',duration:0 }; }
    catch { return null; }
  }).filter(Boolean));
});
function streamFile(fp, req, res) {
  const stat=fs.statSync(fp), ext=path.extname(fp).toLowerCase();
  const mimeMap={'.mp3':'audio/mpeg','.flac':'audio/flac','.wav':'audio/wav','.ogg':'audio/ogg','.m4a':'audio/mp4','.aac':'audio/aac','.opus':'audio/ogg','.webm':'audio/webm'};
  const mime=mimeMap[ext]||'audio/mpeg', range=req.headers.range;
  if (range) { const[s,e]=range.replace(/bytes=/,'').split('-'); const start=parseInt(s,10),end=e?parseInt(e,10):stat.size-1;
    res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${stat.size}`,'Accept-Ranges':'bytes','Content-Length':end-start+1,'Content-Type':mime}); fs.createReadStream(fp,{start,end}).pipe(res);
  } else { res.writeHead(200,{'Content-Length':stat.size,'Content-Type':mime,'Accept-Ranges':'bytes'}); fs.createReadStream(fp).pipe(res); }
}
app.get('/api/local/stream', (req, res) => {
  const raw=req.query.path; if(!raw) return res.status(400).send('Missing path');
  const fp=path.resolve(raw);
  const allowed=[...(config.musicDirs||[]),path.join(__dirname,'music')].some(d=>fp.startsWith(path.resolve(d)));
  if(!allowed||!fs.existsSync(fp)) return res.status(404).send('Not found');
  streamFile(fp, req, res);
});

// ─── Last.fm ──────────────────────────────────────────────────────────────────
app.get('/api/lastfm', async (req, res) => {
  if (!config.lastfmKey) return res.status(400).json({ error: 'No Last.fm API key' });
  try { const url=new URL('https://ws.audioscrobbler.com/2.0/'); Object.entries({...req.query,api_key:config.lastfmKey,format:'json'}).forEach(([k,v])=>url.searchParams.set(k,v)); const r=await fetch(url.toString()); res.json(await r.json()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Spotify ──────────────────────────────────────────────────────────────────
let spotifyToken=null, spotifyTokenExpiry=0;
async function getSpotifyToken() {
  if(spotifyToken&&Date.now()<spotifyTokenExpiry) return spotifyToken;
  if(!config.spotifyClientId||!config.spotifyClientSecret) return null;
  const r=await fetch('https://accounts.spotify.com/api/token',{method:'POST',headers:{'Authorization':`Basic ${Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'});
  const d=await r.json(); spotifyToken=d.access_token; spotifyTokenExpiry=Date.now()+(d.expires_in*1000)-60000; return spotifyToken;
}
app.get('/api/spotify/:endpoint(*)', async (req, res) => {
  try { const t=await getSpotifyToken(); if(!t) return res.status(400).json({error:'No Spotify creds'}); const r=await fetch(`https://api.spotify.com/v1/${req.params.endpoint}?${new URLSearchParams(req.query)}`,{headers:{'Authorization':`Bearer ${t}`}}); res.json(await r.json()); }
  catch(e) { res.status(500).json({error:e.message}); }
});

// ─── AI ───────────────────────────────────────────────────────────────────────
app.post('/api/ai/recommend', rateLimit(20), async (req, res) => {
  const{history,currentTrack,tags,mood}=req.body;
  const prompt=`You are an expert DJ AI. Recommend 5 songs for the best mix flow.\nCurrent: ${JSON.stringify(currentTrack)}\nHistory: ${JSON.stringify((history||[]).slice(-5))}\nTags: ${(tags||[]).join(', ')}\nMood: ${mood||'any'}\nRespond ONLY with JSON array: [{"title":string,"artist":string,"reason":string}]`;
  try {
    if(config.aiProvider==='anthropic'&&config.anthropicKey){const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':config.anthropicKey,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:1024,messages:[{role:'user',content:prompt}]})}); const d=await r.json(); res.json(JSON.parse((d.content?.[0]?.text||'[]').replace(/```json|```/g,'').trim()));}
    else if(config.aiProvider==='openai'&&config.openaiKey){const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':`Bearer ${config.openaiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-4o-mini',messages:[{role:'user',content:prompt}]})}); const d=await r.json(); res.json(JSON.parse((d.choices?.[0]?.message?.content||'[]').replace(/```json|```/g,'').trim()));}
    else if(config.aiProvider==='opencode'&&config.opencodeKey){
      const base=(config.opencodeBaseUrl||'https://api.opencode.ai/v1').replace(/\/+$/,'');
      const model=config.opencodeModel||'opencode-model';
      const r=await fetch(`${base}/chat/completions`,{method:'POST',headers:{'Authorization':`Bearer ${config.opencodeKey}`,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:prompt}]})});
      if(!r.ok){const errBody=await r.text().catch(()=>''); throw new Error(`OpenCode HTTP ${r.status}: ${errBody.slice(0,200)}`);}
      const d=await r.json();
      if(!d.choices?.[0]?.message?.content) throw new Error('OpenCode: empty response');
      res.json(JSON.parse((d.choices[0].message.content||'[]').replace(/```json|```/g,'').trim()));
    }
    else res.status(400).json({error:'No AI configured'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Operator-configured JSON search → unified track shape. Compliance is the operator's responsibility. */
async function squidUnifiedSearch(q) {
  const list = Array.isArray(config.squidProxies) ? config.squidProxies : [];
  for (const px of list) {
    if (!px || !px.name || !px.searchUrlTemplate || !px.streamUrlTemplate) continue;
    try {
      const url = px.searchUrlTemplate.split('{query}').join(encodeURIComponent(q));
      const hdr = { ...musicHeaders(), Accept: 'application/json, */*' };
      if (px.headers && typeof px.headers === 'object') Object.assign(hdr, px.headers);
      const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: hdr });
      if (!r.ok) continue;
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('json')) continue;
      const raw = await r.json();
      const arr = Array.isArray(raw) ? raw : (raw.results || raw.tracks || raw.items || raw.data?.tracks || raw.data || []);
      if (!Array.isArray(arr) || !arr.length) continue;
      const rows = [];
      for (const t of arr.slice(0, 8)) {
        const id = t.id ?? t.trackId ?? t.track_id ?? t.uri;
        if (id == null || id === '') continue;
        const encId = encodeURIComponent(String(id));
        rows.push({
          videoId: `squid:${px.name}:${encId}`,
          title: t.title || t.name || 'Unknown',
          author: (typeof t.artist === 'object' ? (t.artist?.name || '') : t.artist) || t.artistName || t.uploader || 'Unknown',
          lengthSeconds: normalizeTrackDurationSeconds(t.duration, t.duration_ms || t.durationMs),
          artwork: (typeof t.album === 'object' ? t.album?.cover : null) || t.albumCover || t.cover || '',
          _source: 'squid',
          _instance: px.baseUrl || (() => { try { return new URL(px.searchUrlTemplate).origin; } catch (_) { return ''; } })()
        });
        if (rows.length >= 5) break;
      }
      if (rows.length) { log('Search', `squid/${px.name} → ${rows.length}`); return rows; }
    } catch (e) { log('Search', `squid/${px.name} err: ${e.message}`); }
  }
  return null;
}

function resolveSquidStreamTemplate(videoId) {
  if (!String(videoId).startsWith('squid:')) return null;
  const rest = String(videoId).slice(6);
  const i = rest.indexOf(':');
  if (i < 1) return null;
  const name = rest.slice(0, i);
  const encJoined = rest.slice(i + 1);
  const px = (config.squidProxies || []).find(p => p && p.name === name);
  if (!px?.streamUrlTemplate) return null;
  let id;
  try { id = decodeURIComponent(encJoined); } catch (_) { return null; }
  return { px, streamUrl: px.streamUrlTemplate.split('{id}').join(encodeURIComponent(id)) };
}

function walkMetubeCandidates(dir, prefix, minMtime, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  const exts = ['.mp3', '.m4a', '.opus', '.webm', '.aac', '.flac', '.ogg'];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMetubeCandidates(p, prefix, minMtime, out);
    else if (e.name.startsWith(prefix) && exts.includes(path.extname(e.name).toLowerCase())) {
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (st.size < 4000) continue;
      if (st.mtimeMs < minMtime - 10000) continue;
      out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
}

async function metubeAddAndWaitFile(videoId) {
  if (!METUBE_BASE || !METUBE_DOWNLOADS_DIR || !fs.existsSync(METUBE_DOWNLOADS_DIR)) return null;
  const cleanId = String(videoId).replace(/^yt:/, '');
  if (!/^[\w-]{11}$/.test(cleanId)) return null;
  const ytUrl = `https://www.youtube.com/watch?v=${cleanId}`;
  const prefix = `autodj_${safeCacheBasename(cleanId)}_`;
  const started = Date.now();
  const addUrl = `${METUBE_BASE}/add`;
  const body = { url: ytUrl, download_type: 'audio', format: 'mp3', quality: 'best', custom_name_prefix: prefix, auto_start: true };
  const ar = await fetch(addUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...musicHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  if (!ar.ok) {
    const tx = await ar.text().catch(() => '');
    log('Cache', `MeTube /add HTTP ${ar.status}`, tx.slice(0, 160));
    return null;
  }
  const deadline = Date.now() + 200000;
  while (Date.now() < deadline) {
    const candidates = [];
    walkMetubeCandidates(METUBE_DOWNLOADS_DIR, prefix, started - 5000, candidates);
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const pick = candidates[0];
      if (pick && pick.size > 50000) {
      let last = pick.size;
      let stable = 0;
      for (let i = 0; i < 4; i++) {
        await sleep(900);
        let sz = 0;
        try { sz = fs.statSync(pick.path).size; } catch (_) { break; }
        if (sz === last) stable++;
        else { stable = 0; last = sz; }
      }
      if (stable >= 2) {
        // Quick content check: skip if file starts with an HTML doctype (error page)
        try {
          const head = fs.readFileSync(pick.path, { encoding: 'utf8', flag: 'r' }).slice(0, 200);
          if (/^\s*</.test(head) && /<(!doctype|html|head|body)/i.test(head)) {
            log('Cache', `MeTube file is HTML (error page), skipping: ${pick.path}`);
            fs.unlinkSync(pick.path);
            return null;
          }
        } catch (_) {}
        return pick.path;
      }
    }
    await sleep(2000);
  }
  log('Cache', 'MeTube wait timeout');
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UNIFIED SEARCH — ordered by sourcePriority config
// ═══════════════════════════════════════════════════════════════════════════════

const SEARCH_HANDLERS = {
  invidious: async (q) => { for (const inst of getHealthy(invidiousInstances())) { try { const s=Date.now(), r=await fetch(`${inst}/api/v1/search?q=${encodeURIComponent(q)}&type=video`,{signal:AbortSignal.timeout(9000),headers:musicHeaders()}); if(!r.ok){markInst(inst,false);continue;} const d=await r.json(); markInst(inst,true,Date.now()-s); if(Array.isArray(d)&&d.length>0){ const vids = d.filter(i => (i.type === 'video' || i.lengthSeconds) && (i.videoId || i.video_id)); const rows = (vids.length ? vids : d).slice(0, 8); if(rows.length>0){log('Search', `Invidious ${inst}: ${rows.length}`); return rows.slice(0,5).map(i=>({videoId:i.videoId||i.video_id||'',title:i.title||i.videoId||'Unknown',author:i.author||i.authorName||i.uploaderName||i.authorId||'Unknown',lengthSeconds:normalizeTrackDurationSeconds(i.lengthSeconds, null),_source:'invidious'}));}} } catch(e){markInst(inst,false);} } return null; },
  piped: async (q) => { for (const inst of getHealthy(SOURCES.piped)) { try { const r=await fetch(`${inst}/search?q=${encodeURIComponent(q)}&filter=videos`,{signal:AbortSignal.timeout(9000),headers:musicHeaders()}); if(!r.ok){markInst(inst,false);continue;} const d=await r.json(); markInst(inst,true); const raw = d.items || []; const items = raw.filter(i => { const ty = (i.type || '').toLowerCase(); return ty === 'stream' || ty === 'video' || (!!i.url && (ty === '' || ty === 'scheduledstream')); }).slice(0, 8); const mapped = items.map(i => { let vid = i.videoId || ''; if (!vid && i.url) { const m = String(i.url).match(/[?&]v=([^&]+)/); if (m) vid = m[1]; else if (String(i.url).startsWith('/watch?v=')) vid = i.url.replace('/watch?v=', '').split('&')[0]; } return { ...i, _vid: vid }; }).filter(i => i._vid); if (mapped.length > 0) { log('Search', `Piped ${inst}: ${mapped.length}`); return mapped.slice(0, 5).map(i => ({ videoId: i._vid, title: i.title || 'Unknown', author: i.uploaderName || i.uploader || i.author || 'Unknown', lengthSeconds: normalizeTrackDurationSeconds(i.duration, null), _source: 'piped' })); } } catch(e){markInst(inst,false);} } return null; },
  dab: async (q) => { for (const inst of getHealthy(SOURCES.dab)) { for (const qp of ['q', 'query']) { try { const s = Date.now(); const r = await fetch(`${inst}/search?${qp}=${encodeURIComponent(q)}&type=track&limit=5`, { signal: AbortSignal.timeout(8000), headers: musicHeaders() }); if (!r.ok) continue; const ct = r.headers.get('content-type') || ''; if (!ct.includes('json')) continue; const d = await r.json(); const tracks = d.tracks || d.results || (Array.isArray(d) ? d : []); if (tracks.length > 0) { markInst(inst, true, Date.now() - s); const mapped = tracks.slice(0, 5).map(t => ({ videoId: t.id || t.trackId || '', title: t.title || t.name || 'Unknown', author: (typeof t.artist === 'object' ? t.artist?.name : t.artist) || t.artistName || 'Unknown', lengthSeconds: normalizeTrackDurationSeconds(t.duration, t.duration_ms || t.durationMs), artwork: (typeof t.album === 'object' ? t.album?.cover : null) || t.albumCover || t.cover || '', _source: 'dab', _instance: inst })); log('Search', `DAB ${inst} (${qp}=): ${tracks.length}`); return mapped; } markInst(inst, true, Date.now() - s); } catch (e) { markInst(inst, false); } } } return null; },
  jamendo: async (q) => { if (config.jamendoClientId) { try { const r = await fetch(`https://api.jamendo.com/v3.1/tracks/?client_id=${encodeURIComponent(config.jamendoClientId)}&format=json&limit=8&search=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(8000), headers: musicHeaders() }); if (r.ok) { const d = await r.json(); const results = d.results || []; if (results.length > 0) { log('Search', `Jamendo: ${results.length}`); return results.slice(0, 5).map(t => ({ videoId: `jamendo:${t.id}`, title: t.name || 'Unknown', author: t.artist_name || 'Unknown', lengthSeconds: normalizeTrackDurationSeconds(parseFloat(t.duration), null) || 0, artwork: t.image || t.album_image || '', _source: 'jamendo', _instance: 'https://api.jamendo.com/v3.1' })); } } } catch(e) {} } return null; },
  hifi: async (q) => { for (const inst of getHealthy(SOURCES.hifi)) { try { const s = Date.now(); const r = await fetch(`${inst}/search?q=${encodeURIComponent(q)}&type=track&limit=5`, { signal: AbortSignal.timeout(10000), headers: musicHeaders() }); if (!r.ok) { markInst(inst, false); continue; } const d = await r.json(); markInst(inst, true, Date.now() - s); const tracks=d.tracks||d.items||d.data?.tracks||(Array.isArray(d)?d:[]); if(tracks.length>0){log('Search', `HiFi ${inst}: ${tracks.length}`); return tracks.slice(0,5).map(t=>({videoId:t.id||t.trackId||t.track_id||'',title:t.title||t.name||'Unknown',author:(typeof t.artist==='object'?t.artist?.name:t.artist)||t.artists?.[0]?.name||t.artistName||'Unknown',lengthSeconds:normalizeTrackDurationSeconds(t.duration, t.duration_ms||t.durationMs),_source:'hifi',_instance:inst}));} } catch(e){markInst(inst,false);} } return null; }
};

/** Filter out YouTube -Topic channels from search results */
function filterTopicResults(results) {
  if (!config.filterTopicChannels) return results;
  return results.filter(r => {
    const author = (r.author || '').replace(/\s*-\s*Topic\s*$/i, '').trim();
    const wasTopic = author.length < (r.author || '').length;
    if (wasTopic) log('Search', `Filtered -Topic: "${r.author}" — "${r.title}"`);
    return !wasTopic;
  });
}

app.get('/api/youtube/search', rateLimit(30), async (req, res) => {
  const{q}=req.query; if(!q) return res.json([]);
  log('Search', `"${q}"`);

  const order = sourcePriority().filter(s => s !== 'metube' && s !== 'squid');
  for (const key of order) {
    if (SEARCH_HANDLERS[key]) {
      const result = await SEARCH_HANDLERS[key](q);
      if (result) {
        const filtered = filterTopicResults(result);
        if (filtered.length > 0) return res.json(filtered);
        // If all results were filtered, continue to next source
      }
    }
  }

  log('Search', 'No results from any source');
  return res.json([]);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  STREAM RESOLUTION + DOWNLOAD CACHE
// ═══════════════════════════════════════════════════════════════════════════════

// Piped/Invidious stream resolver (for YouTube video IDs) — Invidious first (more reliable than many Piped /streams backends)
app.get('/api/piped/streams', async (req, res) => {
  const{videoId}=req.query; if(!videoId) return res.status(400).json({error:'Missing videoId'});
  for (const inst of getHealthy(invidiousInstances())) {
    try { const r=await fetch(`${inst}/api/v1/videos/${encodeURIComponent(videoId)}`,{signal:AbortSignal.timeout(10000),headers:musicHeaders()}); if(!r.ok){markInst(inst,false);continue;} const d=await r.json(); markInst(inst,true);
      const audio=(d.adaptiveFormats||[]).filter(f=>f.type?.startsWith('audio/')).sort((a,b)=>(b.bitrate||0)-(a.bitrate||0));
      if(audio.length>0) return res.json({title:d.title,uploader:d.author,duration:d.lengthSeconds,thumbnail:(d.videoThumbnails||[])[0]?.url,audioStreams:audio.slice(0,3).map(f=>({url:f.url,mimeType:f.type?.split(';')[0]||'audio/webm',bitrate:f.bitrate||0,quality:'invidious'}))});
    } catch(e){markInst(inst,false);}
  }
  for (const inst of getHealthy(SOURCES.piped)) {
    try { const r=await fetch(`${inst}/streams/${encodeURIComponent(videoId)}`,{signal:AbortSignal.timeout(10000),headers:musicHeaders()}); if(!r.ok){markInst(inst,false);continue;} const d=await r.json(); markInst(inst,true);
      if(d.audioStreams?.length>0){const sorted=d.audioStreams.sort((a,b)=>(b.bitrate||0)-(a.bitrate||0)); return res.json({title:d.title,uploader:d.uploader,duration:d.duration,thumbnail:d.thumbnailUrl,audioStreams:sorted.slice(0,3).map(s=>({url:s.url,mimeType:s.mimeType,bitrate:s.bitrate,quality:s.quality}))});}
    } catch(e){markInst(inst,false);}
  }
  res.status(404).json({error:'No streams found'});
});

/** Try to download via MeTube and return result json if successful, null if not available/failed. */
async function tryMetubeDownload(videoId, title, artist) {
  if (!METUBE_BASE || !METUBE_DOWNLOADS_DIR || !fs.existsSync(METUBE_DOWNLOADS_DIR)) return null;
  if (String(videoId).startsWith('jamendo:') || String(videoId).startsWith('squid:')) return null;
  log('Cache', 'MeTube for', videoId);
  try {
    const mf = await metubeAddAndWaitFile(videoId);
    if (mf) {
      // Double-check file exists before copy (filesystem race)
      if (!fs.existsSync(mf)) { log('Cache', `MeTube file vanished: ${mf}`); return null; }
      const ext = path.extname(mf) || '.mp3';
      const fp = cachePathForId(videoId, ext);
      try { await fs.promises.copyFile(mf, fp); } catch (copyErr) {
        log('Cache', `MeTube copy failed (${mf}): ${copyErr.message}`);
        // Try once more after a short wait
        await sleep(2000);
        if (fs.existsSync(mf)) await fs.promises.copyFile(mf, fp);
        else return null;
      }
      const sz = fs.statSync(fp).size;
      if (sz > 1000) {
        audioCache.push({ id: videoId, filepath: fp, title: title || videoId, artist: artist || '', downloadedAt: Date.now(), playedAt: null, size: sz, source: 'metube' });
        log('Cache', `MeTube OK: ${title} (${(sz / 1048576).toFixed(1)}MB)`);
        return { ok: true, url: `/api/cache/stream/${encodeURIComponent(videoId)}`, title: title || videoId, source: 'metube', size: sz };
      }
    }
  } catch (e) { log('Cache', `MeTube ${videoId}: ${e.message}`); }
  return null;
}

// Download dedup set — prevent concurrent downloads of the same videoId
const downloadingIds = new Set();

// Download + cache a track for reliable playback
app.post('/api/cache/download', rateLimit(20), async (req, res) => {
  const{videoId,title,artist,_source,_instance}=req.body;
  if(!videoId) return res.status(400).json({error:'Missing track ID'});

  // Dedup: reject if already downloading
  if (downloadingIds.has(videoId)) {
    log('Cache', `Dedup: ${videoId} already downloading, returning cached if available`);
    // Poll for completion up to 60s
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const existing = audioCache.find(e => e.id === videoId);
      if (existing?.filepath && fs.existsSync(existing.filepath)) {
        return res.json({ok:true,cached:true,url:`/api/cache/stream/${encodeURIComponent(videoId)}`,title:existing.title,source:'cache'});
      }
      if (!downloadingIds.has(videoId)) break; // download finished or failed
    }
    return res.status(429).json({error:'Download already in progress'});
  }

  // Check cache
  const existing=audioCache.find(e=>e.id===videoId);
  if(existing?.filepath&&fs.existsSync(existing.filepath)) return res.json({ok:true,cached:true,url:`/api/cache/stream/${encodeURIComponent(videoId)}`,title:existing.title,source:'cache'});
  if(existing) audioCache=audioCache.filter(e=>e.id!==videoId);

  downloadingIds.add(videoId);
  log('Cache', `Downloading: ${title || videoId} (src=${_source || 'auto'}, id=${videoId})`);

  try {
    // Try MeTube first if configured
    if (config.metubeFirst !== false) {
      const metubeResult = await tryMetubeDownload(videoId, title, artist);
      if (metubeResult) { downloadingIds.delete(videoId); return res.json(metubeResult); }
    }

    let streamUrl=null, src=_source||'unknown';

    if (_source === 'squid') {
      const sq = resolveSquidStreamTemplate(videoId);
      if (sq) {
        try {
          const hdr = { ...musicHeaders() };
          if (sq.px.headers && typeof sq.px.headers === 'object') Object.assign(hdr, sq.px.headers);
          const probe = await fetch(sq.streamUrl, { method: 'GET', signal: AbortSignal.timeout(25000), headers: hdr, redirect: 'follow' });
          const ct = (probe.headers.get('content-type') || '').toLowerCase();
          if (ct.includes('application/json')) {
            const j = await probe.json();
            streamUrl = j.url || j.streamUrl || j.download_url || j.download;
          } else if (probe.ok && probe.body) {
            await probe.body.cancel().catch(() => {});
            streamUrl = probe.url || sq.streamUrl;
          }
          src = 'squid';
        } catch (e) { log('Cache', `Squid ${sq.streamUrl?.slice(0,80)}: ${e.message}`); }
      }
    }

    // DAB direct download
    if(_source==='dab'&&_instance) {
      try { const r=await fetch(`${_instance}/stream?trackId=${encodeURIComponent(videoId)}&quality=5`,{signal:AbortSignal.timeout(15000),headers:musicHeaders(),redirect:'follow'});
        if(r.ok){const ct=r.headers.get('content-type')||'';
          if(ct.includes('audio')||ct.includes('octet')){const fp=cachePathForId(videoId,'.mp3'); await pipeline(Readable.fromWeb(r.body),fs.createWriteStream(fp)); const sz=fs.statSync(fp).size; if(sz<1000){fs.unlinkSync(fp);throw new Error('too small');}       audioCache.push({id:videoId,filepath:fp,title:title||videoId,artist:artist||'',downloadedAt:Date.now(),playedAt:null,size:sz,source:'dab'}); log('Cache', `DAB OK: ${title} (${(sz/1048576).toFixed(1)}MB)`); cleanTempAfterDownloads(); return res.json({ok:true,url:`/api/cache/stream/${encodeURIComponent(videoId)}`,title:title||videoId,source:'dab',size:sz});}
          if(ct.includes('json')){const d=await r.json(); streamUrl=d.streamUrl||d.url; src='dab';}
        }
      } catch(e){log('Cache', `DAB ${_instance}: ${e.message}`);}
    }

    // HiFi direct download
    if(!streamUrl&&_source==='hifi'&&_instance) {
      try { const r=await fetch(`${_instance}/track/?id=${encodeURIComponent(videoId)}&quality=LOSSLESS`,{signal:AbortSignal.timeout(10000),headers:musicHeaders()}); if(r.ok){const d=await r.json(); streamUrl=d.url||d.download_url; src='hifi';} } catch(e){}
    }

    // Jamendo (namespaced id jamendo:TRACKID)
    if(!streamUrl&&(_source==='jamendo'||String(videoId).startsWith('jamendo:'))){
      const jid=String(videoId).replace(/^jamendo:/,'');
      if(config.jamendoClientId&&jid){
        try{
          const jr=await fetch(`https://api.jamendo.com/v3.1/tracks/?client_id=${encodeURIComponent(config.jamendoClientId)}&format=json&id=${encodeURIComponent(jid)}`,{signal:AbortSignal.timeout(12000),headers:musicHeaders()});
          if(jr.ok){const jd=await jr.json(); const tr=(jd.results||[])[0]; streamUrl=tr?.audiodownload||tr?.audio||null; src='jamendo';}
        }catch(e){log('Cache', `Jamendo: ${e.message} (track=${jid})`);}
      }
    }

    // Invidious stream URL (before Piped — many Piped /streams endpoints error while search still works)
    if(!streamUrl&&!String(videoId).startsWith('jamendo:')) { for(const inst of getHealthy(invidiousInstances())){try{const r=await fetch(`${inst}/api/v1/videos/${encodeURIComponent(videoId)}`,{signal:AbortSignal.timeout(12000),headers:musicHeaders()}); if(!r.ok){markInst(inst,false);continue;} const d=await r.json(); markInst(inst,true); if(config.filterTopicChannels && (d.author||'').match(/\s*-\s*Topic\s*$/i)){log('Cache',`Skipped -Topic: ${d.author} — ${videoId}`); continue;} const a=(d.adaptiveFormats||[]).filter(f=>f.type?.startsWith('audio/')).sort((a,b)=>(b.bitrate||0)-(a.bitrate||0)); if(a.length>0){streamUrl=a[0].url; src='invidious'; break;}}catch(e){markInst(inst,false);}}}

    // Piped stream URL (skip namespaced non-YouTube ids)
    if(!streamUrl&&!String(videoId).startsWith('jamendo:')) { for(const inst of getHealthy(SOURCES.piped)){try{const r=await fetch(`${inst}/streams/${encodeURIComponent(videoId)}`,{signal:AbortSignal.timeout(12000),headers:musicHeaders()}); if(!r.ok){markInst(inst,false);continue;} const d=await r.json(); markInst(inst,true); if(config.filterTopicChannels && (d.uploader||'').match(/\s*-\s*Topic\s*$/i)){log('Cache',`Skipped -Topic: ${d.uploader} — ${videoId}`); continue;} if(d.audioStreams?.length>0){streamUrl=d.audioStreams.sort((a,b)=>(b.bitrate||0)-(a.bitrate||0))[0].url; src='piped'; break;}}catch(e){markInst(inst,false);}}}

    // MeTube as fallback (only if metubeFirst is false, otherwise already tried above)
    if(!streamUrl && config.metubeFirst === false) {
      const metubeResult = await tryMetubeDownload(videoId, title, artist);
      if (metubeResult) return res.json(metubeResult);
    }

    if(!streamUrl) { downloadingIds.delete(videoId); return res.status(404).json({error:'No stream from any source (DAB/Jamendo/HiFi/Piped/Invidious/MeTube/Squid)'}); }

    // Download using pipeline (safe, no memory leaks)
    log('Cache', `Fetching from ${src}: ${streamUrl.slice(0, 80)}...`);
    const ctrl=new AbortController(), to=setTimeout(()=>ctrl.abort(),90000);
    try {
      const ar=await fetch(streamUrl,{signal:ctrl.signal,headers:musicHeaders()}); clearTimeout(to);
      if(!ar.ok){await ar.body?.cancel(); downloadingIds.delete(videoId); return res.status(502).json({error:`HTTP ${ar.status}`});}
      const ct=ar.headers.get('content-type')||'', ext=ct.includes('mpeg')||ct.includes('mp3')?'.mp3':ct.includes('mp4')?'.m4a':ct.includes('ogg')||ct.includes('opus')?'.ogg':ct.includes('flac')?'.flac':ct.includes('wav')||ct.includes('wave')?'.wav':ct.includes('aac')?'.aac':'.webm';
      const fp=cachePathForId(videoId,ext);
      await pipeline(Readable.fromWeb(ar.body),fs.createWriteStream(fp));
      const sz=fs.statSync(fp).size;
      if(sz<1000){fs.unlinkSync(fp); downloadingIds.delete(videoId); return res.status(502).json({error:`File too small (${sz}B)`});}
      audioCache.push({id:videoId,filepath:fp,title:title||videoId,artist:artist||'',downloadedAt:Date.now(),playedAt:null,size:sz,source:src});
      cleanTempAfterDownloads();
      log('Cache', `OK: ${title} (${(sz/1048576).toFixed(1)}MB via ${src})`);
      // Asynchronous ID3 verification
      setImmediate(() => {
        const id3 = extractID3Sync(fp);
        const titleSim = similarity(id3.title, title || videoId);
        const artistSim = similarity(id3.artist, artist || '');
        if (titleSim < 0.7 || artistSim < 0.7) {
          log('Verify', `Weak match for "${title}" — ID3 title="${id3.title}" (${(titleSim*100).toFixed(0)}%) artist="${id3.artist}" (${(artistSim*100).toFixed(0)}%)`);
        } else {
          log('Verify', `ID3 match OK for "${title}" — title=${(titleSim*100).toFixed(0)}% artist=${(artistSim*100).toFixed(0)}%`);
        }
      });
      downloadingIds.delete(videoId); res.json({ok:true,url:`/api/cache/stream/${encodeURIComponent(videoId)}`,title:title||videoId,source:src,size:sz});
    } catch(e) { clearTimeout(to); downloadingIds.delete(videoId); throw e; }
  } catch(e) { downloadingIds.delete(videoId); log('Cache', e.message); if (IS_DEV) console.error(e); res.status(500).json({error:e.message}); }
});

app.get('/api/cache/stream/:id', (req, res) => {
  const id = req.params.id;
  const e=audioCache.find(x=>x.id===id);
  if(!e?.filepath||!fs.existsSync(e.filepath)) return res.status(404).json({error:'Not cached'});
  streamFile(e.filepath, req, res);
});

/** Batch download — downloads multiple tracks concurrently (respects maxConcurrentDownloads). */
app.post('/api/cache/downloadBatch', rateLimit(10), async (req, res) => {
  const { tracks } = req.body;
  if (!Array.isArray(tracks) || !tracks.length) return res.status(400).json({ error: 'No tracks' });
  const maxConcurrent = config.maxConcurrentDownloads || 3;
  const results = [];
  for (let i = 0; i < tracks.length; i += maxConcurrent) {
    const batch = tracks.slice(i, i + maxConcurrent);
    const batchResults = await Promise.allSettled(batch.map(async (t) => {
      try {
        const resp = await fetch(`http://127.0.0.1:${PORT}/api/cache/download`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: t.videoId, title: t.title, artist: t.artist, _source: t._source || '', _instance: t._instance || '' })
        });
        const data = await resp.json();
        return { videoId: t.videoId, ok: resp.ok, ...data };
      } catch (e) { return { videoId: t.videoId, ok: false, error: e.message }; }
    }));
    for (const r of batchResults) {
      if (r.status === 'fulfilled') results.push(r.value);
      else results.push({ videoId: 'unknown', ok: false, error: r.reason?.message });
    }
  }
  res.json({ results });
});
app.post('/api/cache/played', (req, res) => { const e=audioCache.find(x=>x.id===req.body.videoId); if(e){e.playedAt=Date.now();cleanCache();} res.json({ok:true}); });

// ═══════════════════════════════════════════════════════════════════════════════
//  LYRICS — LRCLIB (no auth, synced + plain)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/lyrics', async (req, res) => {
  const{artist,title,duration}=req.query; if(!title) return res.json({synced:null,plain:null});
  const ua='AutoDJ/4.1 (https://github.com/autodj)';
  try {
    let url=`https://lrclib.net/api/get?track_name=${encodeURIComponent(title)}`; if(artist) url+=`&artist_name=${encodeURIComponent(artist)}`; if(duration) url+=`&duration=${Math.round(parseFloat(duration))}`;
    const r=await fetch(url,{signal:AbortSignal.timeout(5000),headers:{'User-Agent':ua}}); if(r.ok){const d=await r.json(); if(d.syncedLyrics||d.plainLyrics) return res.json({synced:d.syncedLyrics||null,plain:d.plainLyrics||null,source:'lrclib'});}
    const sr=await fetch(`https://lrclib.net/api/search?track_name=${encodeURIComponent(title)}${artist?'&artist_name='+encodeURIComponent(artist):''}`,{signal:AbortSignal.timeout(5000),headers:{'User-Agent':ua}});
    if(sr.ok){const rs=await sr.json(); if(Array.isArray(rs)&&rs.length>0) return res.json({synced:rs[0].syncedLyrics||null,plain:rs[0].plainLyrics||null,source:'lrclib-search'});}
  } catch(e){}
  res.json({synced:null,plain:null,source:'none'});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  SOURCE HEALTH TEST
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/test/sources', async (req, res) => {
  const results={};
  const tests=[
    ...SOURCES.dab.map(u=>({url:u,type:'dab',testUrl:`${u}/search?q=test&type=track&limit=1`})),
    ...(config.jamendoClientId ? [{ url: 'https://api.jamendo.com/v3.1', type: 'jamendo', testUrl: `https://api.jamendo.com/v3.1/tracks/?client_id=${encodeURIComponent(config.jamendoClientId)}&format=json&limit=1&search=test` }] : []),
    ...SOURCES.hifi.slice(0,4).map(u=>({url:u,type:'hifi',testUrl:`${u}/search/?query=test&type=track&limit=1`})),
    ...SOURCES.piped.map(u=>({url:u,type:'piped',testUrl:`${u}/search?q=test&filter=videos`})),
    ...invidiousInstances().map(u=>({url:u,type:'invidious',testUrl:`${u}/api/v1/search?q=test&type=video`})),
  ];
  for(const t of tests){try{const s=Date.now(),r=await fetch(t.testUrl,{signal:AbortSignal.timeout(9000),headers:musicHeaders()}); const l=Date.now()-s; markInst(t.url,r.ok,l); if(!results[t.type])results[t.type]=[]; results[t.type].push({url:t.url,ok:r.ok,latency:l,status:r.ok?'up':`http-${r.status}`});}catch(e){markInst(t.url,false); if(!results[t.type])results[t.type]=[]; results[t.type].push({url:t.url,ok:false,status:'down'});}}
  const all=Object.values(results).flat(); res.json({results,summary:{up:all.filter(s=>s.ok).length,total:all.length}});
});

// ─── Temp Upload ──────────────────────────────────────────────────────────────
app.post('/api/temp/upload', rateLimit(10), upload.array('files',100), (req, res) => {
  if(!req.files?.length) return res.status(400).json({error:'No files'});
  const added=req.files.map(f=>{tempFiles.push({filepath:f.path,filename:f.originalname,storedName:f.filename,size:f.size,uploadedAt:Date.now()}); const n=path.basename(f.originalname,path.extname(f.originalname)),p=n.split(' - '); return {filepath:f.path,filename:f.originalname,size:f.size,title:p.length>=2?p.slice(1).join(' - '):n,artist:p.length>=2?p[0]:'Unknown',storedName:f.filename,url:`/api/temp/stream?file=${encodeURIComponent(f.filename)}`};});
  res.json({ok:true,files:added,count:added.length});
});
app.get('/api/temp/stream', (req, res) => { const fn=req.query.file; if(!fn) return res.status(400).send('Missing'); const base=path.basename(String(fn)); const fp=path.join(TEMP_DIR, base); if(!fp.startsWith(path.resolve(TEMP_DIR))||!fs.existsSync(fp)) return res.status(404).send('Not found'); streamFile(fp,req,res); });
app.get('/api/temp/list', (req, res) => { cleanExpiredTempFiles(); res.json(tempFiles.map(tf=>({filename:tf.filename,storedName:tf.storedName,size:tf.size,uploadedAt:tf.uploadedAt,url:`/api/temp/stream?file=${encodeURIComponent(tf.storedName)}`}))); });
app.delete('/api/temp/file', (req, res) => {
  const fn = req.query.file;
  if (!fn) return res.status(400).json({ error: 'Missing file' });
  const base = path.basename(String(fn));
  if (!base || base === '.' || base === '..') return res.status(400).json({ error: 'Invalid file' });
  const fp = path.join(TEMP_DIR, base);
  if (!fp.startsWith(path.resolve(TEMP_DIR))) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(fp); } catch (e) { return res.status(500).json({ error: e.message }); }
  const idx = tempFiles.findIndex(tf => tf.storedName === base);
  if (idx >= 0) tempFiles.splice(idx, 1);
  res.json({ ok: true });
});
app.delete('/api/temp/clear', (req, res) => { let d=0; for(const tf of tempFiles){try{fs.unlinkSync(tf.filepath);d++;}catch(e){}} tempFiles=[]; res.json({ok:true,deleted:d}); });

// ─── Piped relay (CORS proxy for display page audio) ────────────────────────
app.get('/api/piped/relay', async (req, res) => {
  const{url}=req.query; if(!url) return res.status(400).send('Missing url');
  try {
    const decoded = decodeURIComponent(url);
    if (decoded.startsWith('//')) return res.status(400).send('Bad url');
    const parsed = new URL(decoded);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return res.status(400).send('Bad url');
    const hn = parsed.hostname.toLowerCase();
    if (hn === 'localhost' || hn === '127.0.0.1' || hn === '::1' || hn === '0.0.0.0' || hn.startsWith('10.') || hn.startsWith('192.168.') || hn.startsWith('172.16.') || hn.endsWith('.local')) return res.status(400).send('Blocked');
    const up=await fetch(decoded,{signal:AbortSignal.timeout(15000),headers:{...musicHeaders(),'Range':req.headers.range||'bytes=0-'}}); res.status(up.status); ['content-type','content-length','content-range','accept-ranges'].forEach(h=>{const v=up.headers.get(h);if(v)res.setHeader(h,v);}); res.setHeader('Access-Control-Allow-Origin','*'); Readable.fromWeb(up.body).pipe(res); }
  catch(e) { if(!res.headersSent) res.status(502).send('Relay error'); }
});

// ─── System Stats ─────────────────────────────────────────────────────────────
app.get('/api/system/stats', (req, res) => {
  const t = os.totalmem(), f = os.freemem();
  const cpus = os.cpus() || [];
  const model = cpus[0]?.model || 'CPU';
  const load = os.loadavg()[0];
  let cpuPercent = null;
  if (load > 0 && cpus.length) cpuPercent = Math.min(100, Math.round((load / cpus.length) * 100));

  let disk = { total: 0, free: 0, used: 0, percent: 0 };
  try {
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(process.cwd());
      const bsize = st.bsize || 4096;
      const total = st.blocks * bsize;
      const free = st.bavail * bsize;
      const used = Math.max(0, total - free);
      disk = { total, free, used, percent: total ? Math.round((used / total) * 100) : 0 };
    }
  } catch (_) {}

  let tempSize = 0;
  for (const tf of tempFiles) {
    try { tempSize += fs.statSync(tf.filepath).size; } catch (_) {}
  }
  const ramUsed = t - f;
  res.json({
    cpu: { cores: cpus.length, model, percent: cpuPercent },
    ram: { total: t, free: f, used: ramUsed, percent: Math.round((ramUsed / t) * 100) },
    disk,
    temp: { files: tempFiles.length, size: tempSize },
    uptime: process.uptime(),
    sessionActive: sharedState.sessionActive,
    sessionStart: sharedState.sessionStart,
    queueLength: sharedState.queue.length,
    queueLimit: config.queueLimit || 0,
    sessionDuration: config.sessionDuration || 0
  });
});

// ─── Logs API ───────────────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  const level = req.query.level || '';
  const tag = req.query.tag || '';
  let entries = logRing;
  if (level) entries = entries.filter(e => e.level === level);
  if (tag) entries = entries.filter(e => e.tag === tag);
  res.json({ entries: entries.slice(-200) });
});
app.delete('/api/logs', (req, res) => { logRing.length = 0; res.json({ ok: true }); });

// ─── RSS Feed for Marquee ───────────────────────────────────────────────────────
let rssLastLog = 0;
const _xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['item', 'entry', 'channel'].includes(name),
});
function parseRSSItems(xml) {
  try {
    const doc = _xmlParser.parse(xml);
    let rawItems = [];
    // RSS 2.0: rss.channel[].item[]
    if (doc.rss) {
      const channels = Array.isArray(doc.rss.channel) ? doc.rss.channel : [doc.rss.channel];
      for (const ch of channels) {
        if (Array.isArray(ch.item)) rawItems.push(...ch.item);
        else if (ch.item) rawItems.push(ch.item);
      }
    }
    // Atom: feed.entry[]
    if (doc.feed) {
      if (Array.isArray(doc.feed.entry)) rawItems.push(...doc.feed.entry);
      else if (doc.feed.entry) rawItems.push(doc.feed.entry);
    }
    return rawItems.slice(0, 20).map(it => {
      let title = '';
      if (typeof it.title === 'string') title = it.title;
      else if (it.title && typeof it.title === 'object' && it.title['#text']) title = it.title['#text'];
      let link = '';
      if (typeof it.link === 'string') link = it.link;
      else if (it.link && typeof it.link === 'object') link = it.link['@_href'] || it.link.href || '';
      else if (Array.isArray(it.link)) {
        for (const l of it.link) {
          const href = (typeof l === 'object' ? l['@_href'] || l.href : l) || '';
          if (href) { link = href; break; }
        }
      }
      return { title: String(title).trim(), link: String(link).trim() };
    }).filter(it => it.title);
  } catch (e) {
    return null;
  }
}
app.get('/api/rss', async (req, res) => {
  const raw = req.query.url || '';
  if (!raw) return res.json({ items: [] });
  let feedUrl;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return res.json({ items: [] });
    const hn = parsed.hostname.toLowerCase();
    if (hn === 'localhost' || hn === '127.0.0.1' || hn === '::1' || hn === '0.0.0.0' || hn.startsWith('10.') || hn.startsWith('192.168.') || hn.startsWith('172.16.') || hn.endsWith('.local')) return res.json({ items: [] });
    if (parsed.username || parsed.password) return res.json({ items: [] });
    feedUrl = parsed.href;
  } catch { return res.json({ items: [] }); }
  try {
    const r = await fetch(feedUrl, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': MUSIC_UA } });
    if (!r.ok) {
      log('RSS', `HTTP ${r.status} fetching ${feedUrl}`);
      return res.json({ items: [] });
    }
    const xml = await r.text();
    const items = parseRSSItems(xml);
    if (items) {
      const now = Date.now();
      if (now - rssLastLog > 300000) { rssLastLog = now; log('RSS', `${items.length} items from ${feedUrl}`); }
      res.json({ items, feedUrl });
    } else {
      log('RSS', `Parse failed for ${feedUrl}`);
      res.json({ items: [] });
    }
  } catch (e) {
    log('RSS', `Error: ${e.message} — ${feedUrl}`);
    res.json({ items: [] });
  }
});

// ─── Song Verification ──────────────────────────────────────────────────────────
const LYRICS_SIMILARITY_THRESHOLD = 0.7;

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const la = a.toLowerCase().replace(/[^a-z0-9]/g, ''), lb = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!la || !lb) return 0;
  return 1 - levenshtein(la, lb) / Math.max(la.length, lb.length);
}

function extractID3Sync(filepath) {
  try {
    const buf = fs.readFileSync(filepath).slice(0, 16384);
    let offset = 0;
    let title = '', artist = '';
    // Find ID3v2 header
    if (buf.slice(0, 3).toString() === 'ID3') {
      const size = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
      offset = 10;
      while (offset < 10 + size && offset < buf.length - 8) {
        const frameId = buf.slice(offset, offset + 4).toString();
        const frameSize = (buf[offset + 4] << 24) | (buf[offset + 5] << 16) | (buf[offset + 6] << 8) | buf[offset + 7];
        if (frameId === 'TIT2') title = buf.slice(offset + 10, offset + 10 + frameSize - 1).toString('utf8').replace(/\0+$/, '');
        else if (frameId === 'TPE1') artist = buf.slice(offset + 10, offset + 10 + frameSize - 1).toString('utf8').replace(/\0+$/, '');
        offset += 10 + frameSize;
        if (frameSize === 0) break;
      }
    }
    return { title, artist };
  } catch (e) { return { title: '', artist: '' }; }
}

app.post('/api/cache/verify', (req, res) => {
  const { videoId, expectedTitle, expectedArtist } = req.body;
  if (!videoId) return res.json({ ok: false, error: 'No track ID' });
  const entry = audioCache.find(e => e.id === videoId);
  if (!entry || !entry.filepath || !fs.existsSync(entry.filepath)) return res.json({ ok: false, error: 'Not in cache' });
  const id3 = extractID3Sync(entry.filepath);
  const titleSim = similarity(id3.title, expectedTitle || entry.title);
  const artistSim = similarity(id3.artist, expectedArtist || entry.artist);
  const passed = titleSim >= LYRICS_SIMILARITY_THRESHOLD && artistSim >= LYRICS_SIMILARITY_THRESHOLD;
  res.json({ ok: passed, id3, titleSim, artistSim, passed });
});

// ─── Keepalive / Ping ───────────────────────────────────────────────────────────
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ─── WebRTC Signaling (same-origin only) ────────────────────────────────────────
function webrtcAuth(req, res, next) {
  const origin = req.headers.origin || req.headers.referer || '';
  if (!origin) return res.status(403).json({ error: 'Forbidden' });
  try {
    const o = new URL(origin);
    const serverHost = `localhost:${PORT}`;
    if (o.host === serverHost || o.host === `127.0.0.1:${PORT}`) return next();
    if (o.host === `[::1]:${PORT}`) return next();
    if (o.hostname === req.hostname || o.host === req.get('host')) return next();
  } catch {}
  return res.status(403).json({ error: 'Forbidden' });
}
let webrtcState = { offer: null, answer: null, candidates: [] };
app.post('/api/webrtc/offer', webrtcAuth, (req, res) => {
  webrtcState.offer = req.body;
  webrtcState.answer = null;
  webrtcState.candidates = [];
  res.json({ ok: true });
});
app.get('/api/webrtc/offer', webrtcAuth, (req, res) => res.json(webrtcState.offer || {}));
app.post('/api/webrtc/answer', webrtcAuth, (req, res) => {
  webrtcState.answer = req.body;
  res.json({ ok: true });
});
app.get('/api/webrtc/answer', webrtcAuth, (req, res) => res.json(webrtcState.answer || {}));
app.post('/api/webrtc/ice', webrtcAuth, (req, res) => {
  webrtcState.candidates.push(req.body);
  res.json({ ok: true });
});
app.get('/api/webrtc/ice', webrtcAuth, (req, res) => res.json(webrtcState.candidates));
app.delete('/api/webrtc', webrtcAuth, (req, res) => {
  webrtcState = { offer: null, answer: null, candidates: [] };
  res.json({ ok: true });
});

// ─── Persistent Queue ──────────────────────────────────────────────────────────
const QUEUE_FILE = path.join(__dirname, 'queue.json');
function saveQueueToDisk(queue) {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify({ queue, trackIndex: sharedState.trackIndex }, null, 2));
  } catch (e) { log('Queue', 'Save error: ' + e.message); }
}
function loadQueueFromDisk() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
      if (Array.isArray(raw)) return { queue: raw, trackIndex: -1 }; // legacy format
      if (Array.isArray(raw.queue)) return { queue: raw.queue, trackIndex: typeof raw.trackIndex === 'number' ? raw.trackIndex : -1 };
    }
  } catch (e) { log('Queue', 'Load error: ' + e.message); }
  return { queue: [], trackIndex: -1 };
}
// Initialize sharedState from disk on startup
const loaded = loadQueueFromDisk();
sharedState.queue = loaded.queue;
sharedState.trackIndex = loaded.trackIndex;

app.get('/api/queue', (req, res) => res.json({ queue: sharedState.queue, trackIndex: sharedState.trackIndex }));

app.post('/api/queue', (req, res) => {
  const { queue, trackIndex } = req.body;
  if (Array.isArray(queue)) {
    let safe = queue.map(t => {
      if (t.type === 'local') return { ...t, filepath: undefined };
      return t;
    });
    if (config.queueLimit > 0 && safe.length > config.queueLimit) {
      safe = safe.slice(0, config.queueLimit);
    }
    sharedState.queue = safe;
    if (typeof trackIndex === 'number') sharedState.trackIndex = trackIndex;
    saveQueueToDisk(safe);
    broadcastState();
    res.json({ ok: true, count: safe.length });
  } else {
    res.status(400).json({ error: 'Invalid queue' });
  }
});

app.post('/api/queue/remove/:index', (req, res) => {
  const idx = parseInt(req.params.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= sharedState.queue.length) return res.status(400).json({ error: 'Invalid index' });
  const removed = sharedState.queue.splice(idx, 1)[0];
  if (idx <= sharedState.trackIndex) sharedState.trackIndex = Math.max(-1, sharedState.trackIndex - 1);
  saveQueueToDisk(sharedState.queue);
  broadcastState();
  log('Queue', `Removed: ${removed.title} (idx=${idx})`);
  res.json({ ok: true });
});

app.post('/api/queue/clear', (req, res) => {
  stopPlayback();
  sharedState.queue = [];
  sharedState.playedIds = [];
  sharedState.trackIndex = -1;
  saveQueueToDisk([]);
  broadcastState();
  res.json({ ok: true });
});

// ─── Playback Control ─────────────────────────────────────────────────────────
app.post('/api/playback/start', async (req, res) => {
  const result = await startPlayback();
  res.json(result);
});
app.post('/api/playback/stop', (req, res) => {
  stopPlayback();
  res.json({ ok: true });
});
app.post('/api/playback/next', async (req, res) => {
  clearPlaybackTimer();
  const { trackIndex } = req.body || {};
  if (typeof trackIndex === 'number' && trackIndex >= 0 && trackIndex < sharedState.queue.length) {
    // Client is driving advancement — use its trackIndex (prevents desync)
    sharedState.trackIndex = trackIndex;
    if (sharedState.queue[trackIndex]) {
      const track = sharedState.queue[trackIndex];
      sharedState.nowPlaying = {
        title: track.title || '', artist: track.artist || '',
        duration: track.duration || 0, elapsed: 0, youtubeId: track.youtubeId || null,
        artwork: track.artwork || '', album: track.album || '', tags: track.tags || []
      };
      sharedState.nextUp = sharedState.queue[trackIndex + 1] || null;
      sharedState.isPlaying = true;
      // Build stream URL
      let streamUrl = '';
      if (track.type === 'local' || track.type === 'temp') streamUrl = track.url || '';
      else if (track.youtubeId) {
        const cached = audioCache.find(e => e.id === track.youtubeId);
        if (cached?.filepath) streamUrl = `/api/cache/stream/${encodeURIComponent(track.youtubeId)}`;
      }
      log('Playback', `Client sync: track ${trackIndex + 1}/${sharedState.queue.length}: ${track.title}`);
      broadcastCommand('play', { url: streamUrl });
    }
  } else {
    // Fallback: server-driven advance
    await advanceTrack();
  }
  res.json({ ok: true });
});
app.post('/api/playback/event', async (req, res) => {
  const { type } = req.body || {};
  if (type === 'ended') {
    clearPlaybackTimer();
    await preCacheNextTrack();
    await advanceTrack();
  }
  res.json({ ok: true });
});
const MAX_PLAYED_IDS = 2000;
function prunePlayedIds() {
  if (sharedState.playedIds.length > MAX_PLAYED_IDS) {
    sharedState.playedIds = sharedState.playedIds.slice(-MAX_PLAYED_IDS);
  }
}
app.post('/api/playback/played', (req, res) => {
  const { videoId } = req.body || {};
  if (videoId && !sharedState.playedIds.includes(videoId)) {
    sharedState.playedIds.push(videoId);
    prunePlayedIds();
  }
  res.json({ ok: true, playedCount: sharedState.playedIds.length });
});

// ─── SSE / Now Playing ────────────────────────────────────────────────────────
app.get('/api/nowplaying/stream', (req, res) => {
  res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-cache'); res.setHeader('Connection','keep-alive'); res.flushHeaders();
  const id = ++sseIdCounter;
  const info = {
    id,
    ip: req.ip || req.connection?.remoteAddress || 'unknown',
    ua: req.headers['user-agent'] || 'unknown',
    page: req.query.page || 'display',
    connectedAt: Date.now()
  };
  sseClients.set(id, { res, info });
  sharedState.playerMode = 'display';
  log('SSE', `Listener #${id} connected (${info.ip})`);
  res.write(`data: ${JSON.stringify(sharedState)}\n\n`);
  req.on('close', () => {
    sseClients.delete(id);
    log('SSE', `Listener #${id} disconnected`);
    if (sseClients.size === 0 && sharedState.sessionActive) {
      sharedState.playerMode = 'headless';
    }
  });
});
app.get('/api/listeners', (req, res) => {
  const listeners = [];
  for (const [id, c] of sseClients) {
    const ua = c.info.ua;
    const isMobile = /mobile|android|iphone|ipad|ipod/i.test(ua);
    const isTablet = /tablet|ipad/i.test(ua);
    const browser = ua.includes('Chrome') ? 'Chrome' : ua.includes('Firefox') ? 'Firefox' : ua.includes('Safari') ? 'Safari' : ua.includes('Edge') ? 'Edge' : 'Other';
    const os = ua.includes('Windows') ? 'Windows' : ua.includes('Mac') ? 'macOS' : ua.includes('Linux') ? 'Linux' : ua.includes('Android') ? 'Android' : ua.includes('iPhone') ? 'iOS' : 'Other';
    listeners.push({
      id, ip: c.info.ip, browser, os, page: c.info.page,
      isMobile, isTablet,
      connectedAgo: Date.now() - c.info.connectedAt
    });
  }
  res.json({ count: sseClients.size, listeners });
});
app.post('/api/nowplaying/update', (req, res) => {
  const b = req.body || {};
  if (b.nowPlaying) {
    const el = Math.round(b.nowPlaying.elapsed || 0);
    const dur = Math.round(b.nowPlaying.duration || 0);
    if (el < 2) log('NP', b.primaryDeck || '—', `▶ ${b.nowPlaying.title || ''}`);
    else if (dur > 0 && dur - el < 3) log('NP', b.primaryDeck || '—', `■ ${b.nowPlaying.title || ''}`);
  }
  Object.assign(sharedState, b);
  broadcastState();
  res.json({ok:true});
});
app.get('/api/nowplaying', (req, res) => res.json(sharedState));
app.post('/api/nowplaying/clear', (req, res) => {
  stopPlayback();
  sharedState.nowPlaying = null;
  sharedState.nextUp = null;
  sharedState.isPlaying = false;
  sharedState.isFading = false;
  sharedState.playedIds = [];
  broadcastState();
  res.json({ ok: true });
});

// ─── Pages ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/dj'));
app.get('/dj', (req, res) => res.sendFile(path.join(__dirname, 'dj.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'display.html')));

app.listen(PORT, () => {
  console.log(`\n🎧 AutoDJ v4.1 MVP — http://localhost:${PORT}`);
  console.log(`   DJ Console  → /dj`);
  console.log(`   Now Playing → /display`);
  console.log(`   Sources: DAB(${SOURCES.dab.length}) Jamendo(${config.jamendoClientId ? 'on' : 'off'}) HiFi(${SOURCES.hifi.length}) Piped(${SOURCES.piped.length}) Invidious(${invidiousInstances().length}) Metube(${METUBE_BASE ? 'on' : 'off'})\n`);
});
