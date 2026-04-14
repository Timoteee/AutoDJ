const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const cors = require('cors');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
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
    filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9.\-_ ]/g,'_')}`)
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['.mp3','.flac','.wav','.ogg','.m4a','.aac','.opus','.wma'].includes(path.extname(file.originalname).toLowerCase()))
});
let tempFiles = [];
function cleanExpiredTempFiles() {
  const cutoff = Date.now() - 24*60*60*1000;
  tempFiles = tempFiles.filter(tf => { if (tf.uploadedAt < cutoff) { try { fs.unlinkSync(tf.filepath); } catch(e) {} return false; } return true; });
}

// ─── Download Cache ────────────────────────────────────────────────────────
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
let audioCache = [];
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
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID || '',
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
  openaiKey: process.env.OPENAI_API_KEY || '',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  aiProvider: 'anthropic',
  musicDirs: process.env.MUSIC_DIR ? [process.env.MUSIC_DIR] : [path.join(__dirname, 'music')],
  messages: ["🎵 Vibes are immaculate tonight","🔊 AutoDJ is live","🎧 Peak vibes engaged","💿 Hand-selected by algorithms","🕺 You should be dancing right now","🎶 This song is better loud","🌊 Riding the wave"]
};
if (fs.existsSync(CONFIG_FILE)) { try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8'))); } catch(e) {} }
function saveConfig() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }

// ─── Shared State (SSE) ──────────────────────────────────────────────────────
let sharedState = { nowPlaying: null, nextUp: null, genre: '', messages: config.messages, queue: [], isPlaying: false, isFading: false };
const sseClients = new Set();
function broadcastState() { const d = JSON.stringify(sharedState); for (const c of sseClients) { try { c.write(`data: ${d}\n\n`); } catch(e) { sseClients.delete(c); } } }

// ─── Music Sources (SpotiFLAC ecosystem — confirmed April 2026) ──────────
const SOURCES = {
  dab: ['https://dabmusic.xyz/api', 'https://dab.yeet.su/api'],
  hifi: ['https://wolf.qqdl.site','https://maus.qqdl.site','https://katze.qqdl.site','https://hund.qqdl.site','https://vogel.qqdl.site','https://triton.squid.wtf','https://tidal-api.binimum.org','https://tidal.kinoplus.online'],
  piped: ['https://pipedapi.kavin.rocks','https://pipedapi.adminforge.de','https://api.piped.yt','https://pipedapi.leptons.xyz','https://piped-api.privacy.com.de'],
  invidious: ['https://inv.nadeko.net','https://yewtu.be','https://invidious.nerdvpn.de','https://inv.thepixora.com'],
};
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
  lastfmKey: config.lastfmKey ? '●●●set●●●' : '', spotifyClientId: config.spotifyClientId || '',
  openaiKey: config.openaiKey ? '●●●set●●●' : '', anthropicKey: config.anthropicKey ? '●●●set●●●' : '',
  aiProvider: config.aiProvider, musicDirs: config.musicDirs, messages: config.messages,
  hasLastfm: !!config.lastfmKey, hasSpotify: !!(config.spotifyClientId && config.spotifyClientSecret), hasAI: !!(config.anthropicKey || config.openaiKey)
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
  saveConfig(); res.json({ ok: true });
});

// ─── Local Music ──────────────────────────────────────────────────────────────
const AUDIO_EXTS = ['.mp3','.flac','.wav','.ogg','.m4a','.aac','.opus','.wma'];
function scanDir(dir) { const r=[]; if (!fs.existsSync(dir)) return r; const walk=(d)=>{try{for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.isDirectory())walk(f);else if(AUDIO_EXTS.includes(path.extname(e.name).toLowerCase()))r.push(f);}}catch(e){}}; walk(dir); return r; }
app.get('/api/local/scan', (req, res) => {
  const all = []; for (const dir of config.musicDirs) all.push(...scanDir(dir));
  res.json(all.map(fp => { const n=path.basename(fp,path.extname(fp)),p=n.split(' - '); return { type:'local',filepath:fp,filename:path.basename(fp),size:fs.statSync(fp).size, title:p.length>=2?p.slice(1).join(' - '):n, artist:p.length>=2?p[0]:'Unknown', album:'',duration:0 }; }));
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
  const fp=req.query.path; if(!fp||!fs.existsSync(fp)) return res.status(404).send('Not found');
  if(!config.musicDirs.some(d=>fp.startsWith(d))&&!fp.startsWith(path.join(__dirname,'music'))) return res.status(403).send('Forbidden');
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
app.post('/api/ai/recommend', async (req, res) => {
  const{history,currentTrack,tags,mood}=req.body;
  const prompt=`You are an expert DJ AI. Recommend 5 songs for the best mix flow.\nCurrent: ${JSON.stringify(currentTrack)}\nHistory: ${JSON.stringify((history||[]).slice(-5))}\nTags: ${(tags||[]).join(', ')}\nMood: ${mood||'any'}\nRespond ONLY with JSON array: [{"title":string,"artist":string,"reason":string}]`;
  try {
    if(config.aiProvider==='anthropic'&&config.anthropicKey){const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':config.anthropicKey,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:1024,messages:[{role:'user',content:prompt}]})}); const d=await r.json(); res.json(JSON.parse((d.content?.[0]?.text||'[]').replace(/```json|```/g,'').trim()));}
    else if(config.aiProvider==='openai'&&config.openaiKey){const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':`Bearer ${config.openaiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-4o-mini',messages:[{role:'user',content:prompt}]})}); const d=await r.json(); res.json(JSON.parse((d.choices?.[0]?.message?.content||'[]').replace(/```json|```/g,'').trim()));}
    else res.status(400).json({error:'No AI configured'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  UNIFIED SEARCH — DAB → HiFi → Piped → Invidious
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/youtube/search', async (req, res) => {
  const{q}=req.query; if(!q) return res.json([]);
  console.log(`[Search] "${q}"`);

  // 1. DAB Music API (from SpotiFLAC — primary, free, no auth)
  for (const inst of getHealthy(SOURCES.dab)) {
    try { const s=Date.now(), r=await fetch(`${inst}/search?q=${encodeURIComponent(q)}&type=track&limit=5`,{signal:AbortSignal.timeout(8000),headers:{'User-Agent':'AutoDJ/4.1'}}); if(!r.ok){markInst(inst,false);continue;} const d=await r.json(); markInst(inst,true,Date.now()-s);
      const tracks=d.tracks||d.results||(Array.isArray(d)?d:[]); if(tracks.length>0){console.log(`[Search] DAB ${inst}: ${tracks.length}`); return res.json(tracks.slice(0,5).map(t=>({videoId:t.id||t.trackId||'',title:t.title||t.name||'Unknown',author:(typeof t.artist==='object'?t.artist?.name:t.artist)||t.artistName||'Unknown',lengthSeconds:t.duration||0,artwork:(typeof t.album==='object'?t.album?.cover:null)||t.albumCover||t.cover||'',_source:'dab',_instance:inst})));}
    } catch(e){markInst(inst,false);}
  }

  // 2. HiFi-API (Tidal frontend from SpotiFLAC)
  for (const inst of getHealthy(SOURCES.hifi).slice(0,3)) {
    try { const r=await fetch(`${inst}/search/?query=${encodeURIComponent(q)}&type=track&limit=5`,{signal:AbortSignal.timeout(6000),headers:{'User-Agent':'AutoDJ/4.1'}}); if(!r.ok){markInst(inst,false);continue;} const d=await r.json(); markInst(inst,true);
      const tracks=d.tracks||d.items||(Array.isArray(d)?d:[]); if(tracks.length>0){console.log(`[Search] HiFi ${inst}: ${tracks.length}`); return res.json(tracks.slice(0,5).map(t=>({videoId:t.id||t.trackId||'',title:t.title||'Unknown',author:(typeof t.artist==='object'?t.artist?.name:t.artist)||t.artists?.[0]?.name||'Unknown',lengthSeconds:t.duration||0,_source:'hifi',_instance:inst})));}
    } catch(e){markInst(inst,false);}
  }

  // 3. Piped (YouTube frontend — confirmed instances)
  for (const inst of getHealthy(SOURCES.piped)) {
    try { const r=await fetch(`${inst}/search?q=${encodeURIComponent(q)}&filter=videos`,{signal:AbortSignal.timeout(6000),headers:{'User-Agent':'AutoDJ/4.1'}}); if(!r.ok){markInst(inst,false);continue;} const d=await r.json(); markInst(inst,true);
      const items=(d.items||[]).filter(i=>i.type==='stream'||i.url).slice(0,5); if(items.length>0){console.log(`[Search] Piped: ${items.length}`); return res.json(items.map(i=>({videoId:(i.url||'').replace('/watch?v=','')||i.videoId||'',title:i.title||'Unknown',author:i.uploaderName||i.author||'Unknown',lengthSeconds:i.duration||0,_source:'piped'})));}
    } catch(e){markInst(inst,false);}
  }

  // 4. Invidious
  for (const inst of getHealthy(SOURCES.invidious)) {
    try { const r=await fetch(`${inst}/api/v1/search?q=${encodeURIComponent(q)}&type=video`,{signal:AbortSignal.timeout(6000)}); if(!r.ok){markInst(inst,false);continue;} const d=await r.json(); markInst(inst,true);
      if(Array.isArray(d)&&d.length>0){console.log(`[Search] Invidious: ${d.length}`); return res.json(d.slice(0,5).map(i=>({videoId:i.videoId||'',title:i.title||'Unknown',author:i.author||'Unknown',lengthSeconds:i.lengthSeconds||0,_source:'invidious'})));}
    } catch(e){markInst(inst,false);}
  }

  console.warn(`[Search] No results for "${q}"`); res.json([]);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  STREAM RESOLUTION + DOWNLOAD CACHE
// ═══════════════════════════════════════════════════════════════════════════════

// Piped/Invidious stream resolver (for YouTube video IDs)
app.get('/api/piped/streams', async (req, res) => {
  const{videoId}=req.query; if(!videoId) return res.status(400).json({error:'Missing videoId'});
  for (const inst of getHealthy(SOURCES.piped)) {
    try { const r=await fetch(`${inst}/streams/${videoId}`,{signal:AbortSignal.timeout(8000),headers:{'User-Agent':'AutoDJ/4.1'}}); if(!r.ok){markInst(inst,false);continue;} const d=await r.json(); markInst(inst,true);
      if(d.audioStreams?.length>0){const sorted=d.audioStreams.sort((a,b)=>(b.bitrate||0)-(a.bitrate||0)); return res.json({title:d.title,uploader:d.uploader,duration:d.duration,thumbnail:d.thumbnailUrl,audioStreams:sorted.slice(0,3).map(s=>({url:s.url,mimeType:s.mimeType,bitrate:s.bitrate,quality:s.quality}))});}
    } catch(e){markInst(inst,false);}
  }
  for (const inst of getHealthy(SOURCES.invidious)) {
    try { const r=await fetch(`${inst}/api/v1/videos/${videoId}`,{signal:AbortSignal.timeout(8000)}); if(!r.ok){markInst(inst,false);continue;} const d=await r.json(); markInst(inst,true);
      const audio=(d.adaptiveFormats||[]).filter(f=>f.type?.startsWith('audio/')).sort((a,b)=>(b.bitrate||0)-(a.bitrate||0));
      if(audio.length>0) return res.json({title:d.title,uploader:d.author,duration:d.lengthSeconds,thumbnail:(d.videoThumbnails||[])[0]?.url,audioStreams:audio.slice(0,3).map(f=>({url:f.url,mimeType:f.type?.split(';')[0]||'audio/webm',bitrate:f.bitrate||0,quality:'invidious'}))});
    } catch(e){markInst(inst,false);}
  }
  res.status(404).json({error:'No streams found'});
});

// Download + cache a track for reliable playback
app.post('/api/cache/download', async (req, res) => {
  const{videoId,title,artist,_source,_instance}=req.body;
  if(!videoId) return res.status(400).json({error:'Missing track ID'});

  // Check cache
  const existing=audioCache.find(e=>e.id===videoId);
  if(existing?.filepath&&fs.existsSync(existing.filepath)) return res.json({ok:true,cached:true,url:`/api/cache/stream/${videoId}`,title:existing.title,source:'cache'});
  if(existing) audioCache=audioCache.filter(e=>e.id!==videoId);

  console.log(`[Cache] Downloading: ${title||videoId} (${_source||'auto'})`);
  try {
    let streamUrl=null, src=_source||'unknown';

    // DAB direct download
    if(_source==='dab'&&_instance) {
      try { const r=await fetch(`${_instance}/stream?trackId=${videoId}&quality=5`,{signal:AbortSignal.timeout(15000),headers:{'User-Agent':'AutoDJ/4.1'},redirect:'follow'});
        if(r.ok){const ct=r.headers.get('content-type')||'';
          if(ct.includes('audio')||ct.includes('octet')){const fp=path.join(CACHE_DIR,`${videoId}.mp3`); await pipeline(Readable.fromWeb(r.body),fs.createWriteStream(fp)); const sz=fs.statSync(fp).size; if(sz<1000){fs.unlinkSync(fp);throw new Error('too small');} audioCache.push({id:videoId,filepath:fp,title:title||videoId,artist:artist||'',downloadedAt:Date.now(),playedAt:null,size:sz,source:'dab'}); console.log(`[Cache] DAB OK: ${title} (${(sz/1048576).toFixed(1)}MB)`); return res.json({ok:true,url:`/api/cache/stream/${videoId}`,title:title||videoId,source:'dab',size:sz});}
          if(ct.includes('json')){const d=await r.json(); streamUrl=d.streamUrl||d.url; src='dab';}
        }
      } catch(e){console.log(`[Cache] DAB stream: ${e.message}`);}
    }

    // HiFi direct download
    if(!streamUrl&&_source==='hifi'&&_instance) {
      try { const r=await fetch(`${_instance}/track/?id=${videoId}&quality=LOSSLESS`,{signal:AbortSignal.timeout(10000),headers:{'User-Agent':'AutoDJ/4.1'}}); if(r.ok){const d=await r.json(); streamUrl=d.url||d.download_url; src='hifi';} } catch(e){}
    }

    // Piped stream URL
    if(!streamUrl) { for(const inst of getHealthy(SOURCES.piped)){try{const r=await fetch(`${inst}/streams/${videoId}`,{signal:AbortSignal.timeout(8000),headers:{'User-Agent':'AutoDJ/4.1'}}); if(!r.ok){markInst(inst,false);continue;} const d=await r.json(); markInst(inst,true); if(d.audioStreams?.length>0){streamUrl=d.audioStreams.sort((a,b)=>(b.bitrate||0)-(a.bitrate||0))[0].url; src='piped'; break;}}catch(e){markInst(inst,false);}}}

    // Invidious stream URL
    if(!streamUrl) { for(const inst of getHealthy(SOURCES.invidious)){try{const r=await fetch(`${inst}/api/v1/videos/${videoId}`,{signal:AbortSignal.timeout(8000)}); if(!r.ok){markInst(inst,false);continue;} const d=await r.json(); markInst(inst,true); const a=(d.adaptiveFormats||[]).filter(f=>f.type?.startsWith('audio/')).sort((a,b)=>(b.bitrate||0)-(a.bitrate||0)); if(a.length>0){streamUrl=a[0].url; src='invidious'; break;}}catch(e){markInst(inst,false);}}}

    if(!streamUrl) return res.status(404).json({error:'No stream from any source (DAB/HiFi/Piped/Invidious)'});

    // Download using pipeline (safe, no memory leaks)
    console.log(`[Cache] Fetching from ${src}: ${streamUrl.slice(0,80)}...`);
    const ctrl=new AbortController(), to=setTimeout(()=>ctrl.abort(),90000);
    try {
      const ar=await fetch(streamUrl,{signal:ctrl.signal,headers:{'User-Agent':'AutoDJ/4.1'}}); clearTimeout(to);
      if(!ar.ok){await ar.body?.cancel(); return res.status(502).json({error:`HTTP ${ar.status}`});}
      const ct=ar.headers.get('content-type')||'', ext=ct.includes('mpeg')||ct.includes('mp3')?'.mp3':ct.includes('mp4')?'.m4a':'.webm';
      const fp=path.join(CACHE_DIR,`${videoId}${ext}`);
      await pipeline(Readable.fromWeb(ar.body),fs.createWriteStream(fp));
      const sz=fs.statSync(fp).size;
      if(sz<1000){fs.unlinkSync(fp); return res.status(502).json({error:`File too small (${sz}B)`});}
      audioCache.push({id:videoId,filepath:fp,title:title||videoId,artist:artist||'',downloadedAt:Date.now(),playedAt:null,size:sz,source:src});
      console.log(`[Cache] OK: ${title} (${(sz/1048576).toFixed(1)}MB via ${src})`);
      res.json({ok:true,url:`/api/cache/stream/${videoId}`,title:title||videoId,source:src,size:sz});
    } catch(e) { clearTimeout(to); throw e; }
  } catch(e) { console.error(`[Cache] ${e.message}`); res.status(500).json({error:e.message}); }
});

app.get('/api/cache/stream/:id', (req, res) => {
  const e=audioCache.find(x=>x.id===req.params.id);
  if(!e?.filepath||!fs.existsSync(e.filepath)) return res.status(404).json({error:'Not cached'});
  streamFile(e.filepath, req, res);
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
    ...SOURCES.hifi.slice(0,4).map(u=>({url:u,type:'hifi',testUrl:`${u}/search/?query=test&type=track&limit=1`})),
    ...SOURCES.piped.map(u=>({url:u,type:'piped',testUrl:`${u}/search?q=test&filter=videos`})),
    ...SOURCES.invidious.map(u=>({url:u,type:'invidious',testUrl:`${u}/api/v1/search?q=test&type=video`})),
  ];
  for(const t of tests){try{const s=Date.now(),r=await fetch(t.testUrl,{signal:AbortSignal.timeout(6000),headers:{'User-Agent':'AutoDJ/4.1'}}); const l=Date.now()-s; markInst(t.url,r.ok,l); if(!results[t.type])results[t.type]=[]; results[t.type].push({url:t.url,ok:r.ok,latency:l,status:r.ok?'up':`http-${r.status}`});}catch(e){markInst(t.url,false); if(!results[t.type])results[t.type]=[]; results[t.type].push({url:t.url,ok:false,status:'down'});}}
  const all=Object.values(results).flat(); res.json({results,summary:{up:all.filter(s=>s.ok).length,total:all.length}});
});

// ─── Temp Upload ──────────────────────────────────────────────────────────────
app.post('/api/temp/upload', upload.array('files',100), (req, res) => {
  if(!req.files?.length) return res.status(400).json({error:'No files'});
  const added=req.files.map(f=>{tempFiles.push({filepath:f.path,filename:f.originalname,storedName:f.filename,size:f.size,uploadedAt:Date.now()}); const n=path.basename(f.originalname,path.extname(f.originalname)),p=n.split(' - '); return {filepath:f.path,filename:f.originalname,size:f.size,title:p.length>=2?p.slice(1).join(' - '):n,artist:p.length>=2?p[0]:'Unknown',storedName:f.filename,url:`/api/temp/stream?file=${encodeURIComponent(f.filename)}`};});
  res.json({ok:true,files:added,count:added.length});
});
app.get('/api/temp/stream', (req, res) => { const fn=req.query.file; if(!fn) return res.status(400).send('Missing'); const fp=path.resolve(TEMP_DIR,fn); if(!fp.startsWith(TEMP_DIR)||!fs.existsSync(fp)) return res.status(404).send('Not found'); streamFile(fp,req,res); });
app.get('/api/temp/list', (req, res) => { cleanExpiredTempFiles(); res.json(tempFiles.map(tf=>({filename:tf.filename,storedName:tf.storedName,size:tf.size,uploadedAt:tf.uploadedAt,url:`/api/temp/stream?file=${encodeURIComponent(tf.storedName)}`}))); });
app.delete('/api/temp/clear', (req, res) => { let d=0; for(const tf of tempFiles){try{fs.unlinkSync(tf.filepath);d++;}catch(e){}} tempFiles=[]; res.json({ok:true,deleted:d}); });

// ─── Piped relay (CORS proxy for display page audio) ────────────────────────
app.get('/api/piped/relay', async (req, res) => {
  const{url}=req.query; if(!url) return res.status(400).send('Missing url');
  try { const up=await fetch(decodeURIComponent(url),{signal:AbortSignal.timeout(15000),headers:{'User-Agent':'AutoDJ/4.1','Range':req.headers.range||'bytes=0-'}}); res.status(up.status); ['content-type','content-length','content-range','accept-ranges'].forEach(h=>{const v=up.headers.get(h);if(v)res.setHeader(h,v);}); res.setHeader('Access-Control-Allow-Origin','*'); Readable.fromWeb(up.body).pipe(res); }
  catch(e) { if(!res.headersSent) res.status(502).send('Relay error'); }
});

// ─── System Stats ─────────────────────────────────────────────────────────────
app.get('/api/system/stats', (req, res) => { const t=os.totalmem(),f=os.freemem(); res.json({cpu:{cores:os.cpus().length},ram:{total:t,free:f,percent:Math.round((t-f)/t*100)},uptime:process.uptime()}); });

// ─── SSE / Now Playing ────────────────────────────────────────────────────────
app.get('/api/nowplaying/stream', (req, res) => { res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-cache'); res.setHeader('Connection','keep-alive'); res.flushHeaders(); sseClients.add(res); res.write(`data: ${JSON.stringify(sharedState)}\n\n`); req.on('close',()=>sseClients.delete(res)); });
app.get('/api/listeners', (req, res) => res.json({count:sseClients.size}));
app.post('/api/nowplaying/update', (req, res) => { Object.assign(sharedState, req.body); broadcastState(); res.json({ok:true}); });
app.get('/api/nowplaying', (req, res) => res.json(sharedState));

// ─── Pages ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/dj'));
app.get('/dj', (req, res) => res.sendFile(path.join(__dirname, 'dj.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'display.html')));

app.listen(PORT, () => {
  console.log(`\n🎧 AutoDJ v4.1 MVP — http://localhost:${PORT}`);
  console.log(`   DJ Console  → /dj`);
  console.log(`   Now Playing → /display`);
  console.log(`   Sources: DAB(${SOURCES.dab.length}) HiFi(${SOURCES.hifi.length}) Piped(${SOURCES.piped.length}) Invidious(${SOURCES.invidious.length})\n`);
});
