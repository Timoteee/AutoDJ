/**
 * AutoDJ DJ Console v3.0
 * Fixes: AudioContext user-gesture, Piped audio streams, waveform, ID3 metadata,
 *        artwork, auto-discover, auto-mix trigger bug, temp file playback,
 *        AI button greying, now-playing sync, display page audio relay
 */

const DJ = {
  queue: [],
  history: [],
  trackIndex: -1,
  currentDeck: 'a',
  usedTracks: new Set(),
  seedTags: [],
  knownArtists: [],
  localFiles: [],
  messages: [],
  hasLastfm: false,
  hasJamendo: false,
  hasSpotify: false,
  hasAI: false,
  started: false,        // has user clicked play at least once
  discovering: false,    // prevent concurrent discovery runs
  fadeLock: false,       // prevent double-trigger of auto-mix
  lastNpBroadcast: 0,
  recentlyPlayed: [],    // sliding window of last 20 played tracks (dedup)
};

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  setupAudioElements();
  await loadConfig();
  await loadPersistentQueue();
  startClock();
  setupDropZone();
  registerServiceWorker();
  setupSourcePriorityDrag();
  setStatus('Ready — add local files or set a seed artist in Discover tab');
  // Start render loop after a brief paint delay
  setTimeout(startRenderLoop, 200);
});

/** Initialize theme from localStorage or system preference, attach toggle. */
function initTheme() {
  const saved = localStorage.getItem('autodj-theme');
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  const theme = saved || (prefersLight ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.textContent = theme === 'light' ? 'DARK' : 'LIGHT';
    btn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('autodj-theme', next);
      btn.textContent = next === 'light' ? 'DARK' : 'LIGHT';
    });
  }
}

/** Save the current queue + trackIndex to the server (fire-and-forget). */
let _persistTimer = null;
function persistQueue() {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    fetch('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queue: DJ.queue, trackIndex: DJ.trackIndex })
    }).catch(() => {});
  }, 300);
}

/** Load the queue and played IDs from the server (persisted from a previous session). */
async function loadPersistentQueue() {
  try {
    const [qRes, npRes] = await Promise.all([
      fetch('/api/queue'),
      fetch('/api/nowplaying')
    ]);
    const qd = await qRes.json();
    if (Array.isArray(qd.queue) && qd.queue.length > 0) {
      DJ.queue = qd.queue;
      DJ.trackIndex = typeof qd.trackIndex === 'number' ? qd.trackIndex : 0;
      renderQueue();
      setStatus(`Restored ${qd.queue.length} tracks`);
    }
    const np = await npRes.json();
    if (Array.isArray(np.playedIds)) {
      np.playedIds.forEach(id => DJ.usedTracks.add(`yt:${id}`));
    }
    // If server has an active session, sync the now-playing state
    if (np.sessionActive && np.nowPlaying) {
      DJ.started = true;
      const track = np.nowPlaying;
      // Load track onto current deck for display (no audio playback)
      const deck = DJ.currentDeck || 'a';
      const audio = getDeckAudio(deck);
      const cachedUrl = track.youtubeId ? `/api/cache/stream/${encodeURIComponent(track.youtubeId)}` : '';
      if (cachedUrl) {
        audio.src = cachedUrl;
        audio.load();
      }
      document.getElementById(`title-${deck}`).textContent = track.title || '—';
      document.getElementById(`artist-${deck}`).textContent = track.artist || '—';
      document.getElementById(`album-${deck}`).textContent = track.album || '';
      if (np.isPlaying) {
        audio.play().catch(() => {});
      }
    }
  } catch (e) { /* first visit or server error */ }
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(() => {
      // Periodic keepalive pings to keep the SW active
      setInterval(() => fetch('/api/ping').catch(() => {}), 25000);
    }).catch(() => {});
  }
}

function setupAudioElements() {
  // Just register audio elements — don't connect to WebAudio yet (needs user gesture)
  Engine.setupDeckAudio('a', document.getElementById('audio-a'));
  Engine.setupDeckAudio('b', document.getElementById('audio-b'));

  const aa = document.getElementById('audio-a');
  const ab = document.getElementById('audio-b');

  aa.addEventListener('ended', () => onTrackEnded('a'));
  ab.addEventListener('ended', () => onTrackEnded('b'));
  aa.addEventListener('timeupdate', () => updateDeckUI('a'));
  ab.addEventListener('timeupdate', () => updateDeckUI('b'));
  aa.addEventListener('loadedmetadata', () => onMetaLoaded('a'));
  ab.addEventListener('loadedmetadata', () => onMetaLoaded('b'));
  aa.addEventListener('error', (e) => { console.error('Deck A error', e); onPlayError('a'); });
  ab.addEventListener('error', (e) => { console.error('Deck B error', e); onPlayError('b'); });
}

// ─── Clock ────────────────────────────────────────────────────────────────────
function startClock() {
  const el = document.getElementById('clock');
  const tick = () => el && (el.textContent = new Date().toLocaleTimeString('en-US',{hour12:false}));
  setInterval(tick, 1000); tick();
}

// ─── Config + UI State ────────────────────────────────────────────────────────
async function loadConfig() {
  try {
    const r = await fetch('/api/config');
    const cfg = await r.json();
    DJ.hasLastfm = cfg.hasLastfm;
    DJ.hasJamendo = cfg.hasJamendo;
    DJ.hasSpotify = cfg.hasSpotify;
    DJ.hasAI = cfg.hasAI;

    if (cfg.lastfmKey) document.getElementById('cfg-lastfm').placeholder = '●●● configured ●●●';
    const jm = document.getElementById('cfg-jamendo');
    if (jm) {
      if (cfg.hasJamendo) { jm.placeholder = '●●● configured ●●●'; jm.value = ''; }
      else { jm.placeholder = 'Jamendo client_id (developer.jamendo.com)…'; }
    }
    if (cfg.spotifyClientId) document.getElementById('cfg-sp-id').value = cfg.spotifyClientId;
    if (cfg.anthropicKey) document.getElementById('cfg-anthropic').placeholder = '●●● configured ●●●';
    if (cfg.openaiKey) document.getElementById('cfg-openai').placeholder = '●●● configured ●●●';
    if (cfg.opencodeKey) document.getElementById('cfg-opencode').placeholder = '●●● configured ●●●';
    const ocUrl = document.getElementById('cfg-opencode-url');
    if (ocUrl && cfg.opencodeBaseUrl) ocUrl.value = cfg.opencodeBaseUrl;
    const ocModel = document.getElementById('cfg-opencode-model');
    if (ocModel && cfg.opencodeModel) ocModel.value = cfg.opencodeModel;
    document.getElementById('cfg-ai-provider').value = cfg.aiProvider || 'anthropic';
    const orKey = document.getElementById('cfg-openrouter');
    if (orKey && (cfg.openrouterKey || cfg.hasOpenrouter)) orKey.placeholder = '●●● configured ●●●';
    const orUrl = document.getElementById('cfg-openrouter-url');
    if (orUrl && cfg.openrouterBaseUrl) orUrl.value = cfg.openrouterBaseUrl;
    const orModel = document.getElementById('cfg-openrouter-model');
    if (orModel && cfg.openrouterModel) orModel.value = cfg.openrouterModel;
    if (cfg.musicDirs) document.getElementById('cfg-dirs').value = cfg.musicDirs.join('\n');
    if (cfg.messages) { DJ.messages = cfg.messages; renderMessages(); }
    const ir = document.getElementById('cfg-invidious-redirect');
    if (ir) ir.value = cfg.invidiousRedirector || '';
    const sq = document.getElementById('cfg-squid-proxies');
    if (sq) sq.value = Array.isArray(cfg.squidProxies) && cfg.squidProxies.length ? JSON.stringify(cfg.squidProxies, null, 2) : '';

    // New playback settings
    const setVal = (id, val) => { const e = document.getElementById(id); if (e) e.value = val; };
    setVal('cfg-predownload', cfg.preDownloadCount || 5);
    setVal('cfg-max-concurrent', cfg.maxConcurrentDownloads || 3);
    setVal('cfg-fade-pct', cfg.fadeAtPercent || 80);
    setVal('cfg-max-track', cfg.maxTrackMinutes || 0);
    const mf = document.getElementById('cfg-metube-first');
    if (mf) mf.checked = cfg.metubeFirst !== false;
    const ft = document.getElementById('cfg-filter-topic');
    if (ft) ft.checked = cfg.filterTopicChannels !== false;

    if (Array.isArray(cfg.sourcePriority)) renderSourcePriority(cfg.sourcePriority);
    const rss = document.getElementById('cfg-rss-feed');
    if (rss) rss.value = cfg.rssFeedUrl || '';
    const mMode = document.getElementById('cfg-marquee-mode');
    if (mMode) mMode.value = cfg.marqueeMode || 'rss';
    setVal('cfg-session-duration', cfg.sessionDuration || 0);
    setVal('cfg-queue-limit', cfg.queueLimit || 0);

    // Store config for indicator display
    DJ.config = DJ.config || {};
    DJ.config.sessionDuration = cfg.sessionDuration || 0;
    DJ.config.queueLimit = cfg.queueLimit || 0;

    updateServiceIndicators();
  } catch(e) {}
}

function updateServiceIndicators() {
  // Grey out AI buttons if not configured
  const aiButtons = document.querySelectorAll('.ai-btn');
  aiButtons.forEach(btn => {
    btn.disabled = !DJ.hasAI;
    btn.title = DJ.hasAI ? '' : 'Configure an AI API key in Settings first';
    btn.style.opacity = DJ.hasAI ? '1' : '0.4';
  });

  // Grey out Spotify if not configured
  const spBtn = document.getElementById('spotify-search-btn');
  if (spBtn) { spBtn.disabled = !DJ.hasSpotify; spBtn.style.opacity = DJ.hasSpotify ? '1' : '0.4'; }

  // Grey out Last.fm discovery if not configured
  const lfmBtn = document.getElementById('start-discover-btn');
  if (lfmBtn) { lfmBtn.disabled = !DJ.hasLastfm; lfmBtn.style.opacity = DJ.hasLastfm ? '1' : '0.4'; }

  // Status indicators
  setIndicator('ind-lastfm', DJ.hasLastfm);
  setIndicator('ind-jamendo', DJ.hasJamendo);
  setIndicator('ind-spotify', DJ.hasSpotify);
  setIndicator('ind-ai', DJ.hasAI);
}

function setIndicator(id, on) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.color = on ? 'var(--green)' : 'var(--muted)';
  el.textContent = on ? '●' : '○';
}

async function saveConfig() {
  const body = {
    lastfmKey: document.getElementById('cfg-lastfm').value,
    jamendoClientId: document.getElementById('cfg-jamendo')?.value || '',
    spotifyClientId: document.getElementById('cfg-sp-id').value,
    spotifyClientSecret: document.getElementById('cfg-sp-secret').value,
    anthropicKey: document.getElementById('cfg-anthropic').value,
    openaiKey: document.getElementById('cfg-openai').value,
    opencodeKey: document.getElementById('cfg-opencode')?.value || '',
    opencodeBaseUrl: document.getElementById('cfg-opencode-url')?.value?.trim() || '',
    opencodeModel: document.getElementById('cfg-opencode-model')?.value?.trim() || '',
    openrouterKey: document.getElementById('cfg-openrouter')?.value || '',
    openrouterBaseUrl: document.getElementById('cfg-openrouter-url')?.value?.trim() || '',
    openrouterModel: document.getElementById('cfg-openrouter-model')?.value?.trim() || '',
    aiProvider: document.getElementById('cfg-ai-provider').value,
    musicDirs: document.getElementById('cfg-dirs').value.split('\n').map(s=>s.trim()).filter(Boolean),
    messages: DJ.messages,
    invidiousRedirector: document.getElementById('cfg-invidious-redirect')?.value?.trim() || '',
    squidProxies: (() => {
      const raw = document.getElementById('cfg-squid-proxies')?.value?.trim();
      if (!raw) return [];
      try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch (_) { return []; }
    })(),
    preDownloadCount: parseInt(document.getElementById('cfg-predownload')?.value) || 5,
    maxConcurrentDownloads: parseInt(document.getElementById('cfg-max-concurrent')?.value) || 3,
    fadeAtPercent: parseInt(document.getElementById('cfg-fade-pct')?.value) || 80,
    maxTrackMinutes: parseInt(document.getElementById('cfg-max-track')?.value) || 0,
    metubeFirst: !!document.getElementById('cfg-metube-first')?.checked,
    filterTopicChannels: !!document.getElementById('cfg-filter-topic')?.checked,
    sourcePriority: readSourcePriority(),
    rssFeedUrl: document.getElementById('cfg-rss-feed')?.value?.trim() || '',
    marqueeMode: document.getElementById('cfg-marquee-mode')?.value || 'rss',
    sessionDuration: parseInt(document.getElementById('cfg-session-duration')?.value) || 0,
    queueLimit: parseInt(document.getElementById('cfg-queue-limit')?.value) || 0
  };
  const r = await fetch('/api/config', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if (r.ok) {
    DJ.config = DJ.config || {};
    DJ.config.sessionDuration = body.sessionDuration;
    DJ.config.queueLimit = body.queueLimit;
    await loadConfig();
  }
  setStatus('Configuration saved ✓');
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function queueFocusSearch() {
  showTab('queue');
  const el = document.getElementById('unified-search-q');
  if (el) {
    el.focus();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${name}`));
}

// ─── Local Files + ID3 Metadata ───────────────────────────────────────────────
async function addLocalFiles(fileList) {
  let added = 0;
  for (const file of fileList) {
    if (!file.type.startsWith('audio/') && !file.name.match(/\.(mp3|flac|wav|ogg|m4a|aac|opus|wma)$/i)) continue;
    const url = URL.createObjectURL(file);

    // Parse filename as fallback
    const nameParts = file.name.replace(/\.[^.]+$/, '').split(' - ');
    const fallbackTitle = nameParts.length >= 2 ? nameParts.slice(1).join(' - ') : nameParts[0];
    const fallbackArtist = nameParts.length >= 2 ? nameParts[0] : 'Unknown';

    const track = {
      type: 'local', file, url,
      title: fallbackTitle, artist: fallbackArtist, album: '', year: '',
      duration: 0, tags: [], artwork: null, youtubeId: null
    };

    // Read ID3 tags asynchronously
    Engine.readFileMetadata(file).then(meta => {
      if (meta.title) track.title = meta.title;
      if (meta.artist) track.artist = meta.artist;
      if (meta.album) track.album = meta.album;
      if (meta.artwork) track.artwork = meta.artwork;
      renderLocalFiles();
      // Update deck display if this track is currently playing
      const d = Engine.decks[DJ.currentDeck];
      if (d.track === track) updateDeckArtwork(DJ.currentDeck, track);
    });

    DJ.localFiles.push(track);
    added++;
  }
  renderLocalFiles();
  setStatus(`Added ${added} file${added !== 1 ? 's' : ''} to library`);

  // Auto-start if nothing is playing
  if (!DJ.started && added > 0) {
    for (const f of DJ.localFiles.slice(-added)) DJ.queue.push({...f});
    renderQueue();
  }
}

function renderLocalFiles() {
  const list = document.getElementById('local-file-list');
  if (!list) return;
  if (DJ.localFiles.length === 0) {
    list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted);font-size:11px">Drop files or click to browse</div>';
    return;
  }
  list.innerHTML = DJ.localFiles.map((f, i) => `
    <div class="local-file">
      ${f.artwork ? `<img src="${f.artwork}" style="width:32px;height:32px;border-radius:2px;object-fit:cover;flex-shrink:0">` :
        '<div style="width:32px;height:32px;background:var(--border);border-radius:2px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:14px">♪</div>'}
      <div style="flex:1;overflow:hidden;margin:0 8px">
        <div class="local-file-name">${f.title}</div>
        <div style="font-size:9px;color:var(--muted)">${f.artist}${f.album?' · '+f.album:''}</div>
      </div>
      <div class="local-file-meta">${f.duration ? fmt(f.duration) : '—'}</div>
      <button type="button" class="btn" style="padding:3px 6px;font-size:9px;margin-left:2px" onclick="loadLibraryToDeck('a',${i})">A</button>
      <button type="button" class="btn" style="padding:3px 6px;font-size:9px;margin-left:2px" onclick="loadLibraryToDeck('b',${i})">B</button>
      <button class="btn" style="padding:3px 8px;font-size:9px;margin-left:4px" onclick="addSingleToQueue(${i})">Queue</button>
      <button class="ctrl-btn" style="padding:3px 7px;font-size:10px;margin-left:2px" onclick="playLocalNow(${i})">▶</button>
    </div>`).join('');
}

function addSingleToQueue(i) {
  DJ.queue.push({...DJ.localFiles[i]});
  renderQueue();
  setStatus(`Queued: ${DJ.localFiles[i].title}`);
}

function playLocalNow(i) {
  const t = {...DJ.localFiles[i]};
  DJ.queue.splice(DJ.trackIndex + 1, 0, t);
  if (!DJ.started) { startPlayback(); } else { triggerCrossfade(); }
}

async function loadLibraryToDeck(deck, libIdx) {
  const t = DJ.localFiles[libIdx];
  if (!t) return;
  Engine.initAudioCtx();
  DJ.started = true;
  await loadTrackOnDeck(deck, t);
  setStatus(`Cue Deck ${deck.toUpperCase()}: ${t.title}`);
}

async function cueQueueTrack(deck, queueIdx) {
  const t = DJ.queue[queueIdx];
  if (!t) return;
  Engine.initAudioCtx();
  DJ.started = true;
  await loadTrackOnDeck(deck, t, { prepareOnly: true });
  setStatus(`Cue Deck ${deck.toUpperCase()} from queue #${queueIdx + 1}: ${t.title}`);
}

function addAllToQueue() {
  const mode = document.getElementById('queue-mode')?.value || 'local-first';
  let toAdd = DJ.localFiles.map(f => ({...f}));
  if (mode === 'shuffle-mix') toAdd = toAdd.sort(() => Math.random() - 0.5);
  DJ.queue.push(...toAdd);
  renderQueue();
  setStatus(`Added ${toAdd.length} tracks to queue`);
}

async function scanLibrary() {
  setStatus('Scanning server music folders...');
  try {
    const r = await fetch('/api/local/scan');
    const files = await r.json();
    for (const f of files) {
      f.url = `/api/local/stream?path=${encodeURIComponent(f.filepath)}`;
      DJ.localFiles.push(f);
    }
    renderLocalFiles();
    setStatus(`Found ${files.length} tracks`);
  } catch(e) { setStatus('Scan failed: ' + e.message); }
}

// ─── Deck Artwork ────────────────────────────────────────────────────────────
function updateDeckArtwork(deck, track) {
  const el = document.getElementById(`artwork-${deck}`);
  if (!el) return;
  if (track.artwork || track.image) {
    el.src = track.artwork || track.image;
    el.style.display = 'block';
    el.parentElement?.classList.add('has-art');
  } else {
    el.style.display = 'none';
    el.parentElement?.classList.remove('has-art');
  }
}

// ─── Playback — the core flow ─────────────────────────────────────────────────
function getDeckAudio(deck) { return document.getElementById(`audio-${deck}`); }
function getNextDeck() { return DJ.currentDeck === 'a' ? 'b' : 'a'; }

/** Treat API durations that look like ms stored as seconds. */
function normalizeClientDuration(raw) {
  let s = Number(raw);
  if (!Number.isFinite(s) || s <= 0) return 0;
  if (s < 5) return 0;
  else if (s > 120 && s < 1e12) s /= 1000;
  if (s < 10) return 0;
  return Math.min(Math.round(s), 6 * 3600);
}

function getCrossfaderValue() {
  const el = document.getElementById('crossfader');
  return el ? parseFloat(el.value) || 0 : 0;
}

/** Which deck is "up" for now-playing / display (follows crossfader). */
function getAudibleDeck() {
  const v = getCrossfaderValue();
  if (v <= 0.45) return 'a';
  if (v >= 0.55) return 'b';
  return DJ.currentDeck;
}

function buildStreamUrlForTrack(track) {
  if (!track) return '';
  if (track.type === 'local' || track.type === 'temp') return track.url || '';
  if (track._streamUrl) {
    const u = track._streamUrl;
    if (u.startsWith('/') || u.startsWith('./')) return u;
    if (/^https?:\/\//i.test(u)) return '/api/piped/relay?url=' + encodeURIComponent(u);
    return u;
  }
  return '';
}

function buildDeckPayload(deck) {
  const track = Engine.decks[deck]?.track;
  const audio = getDeckAudio(deck);
  const cur = audio?.currentTime || 0;
  const rawDur = (audio && audio.duration && Number.isFinite(audio.duration)) ? audio.duration : (track?.duration || 0);
  const dur = Number.isFinite(rawDur) && rawDur > 0 ? rawDur : 0;
  const audible = getAudibleDeck();
  if (!track) {
    return { title: '', artist: '', album: '', artwork: '', elapsed: 0, duration: 0, streamUrl: '', youtubeId: null, fadePoint: null, tags: [], isAudible: false };
  }
  return {
    title: track.title, artist: track.artist, album: track.album || '', artwork: track.artwork || track.image || '',
    elapsed: cur, duration: dur, fadePoint: Engine.decks[deck]?.fadePoint ?? null,
    tags: track.tags, streamUrl: buildStreamUrlForTrack(track), youtubeId: track.youtubeId || null,
    isAudible: audible === deck
  };
}

let xfBroadcastRaf = null;
function scheduleDeckStateBroadcast() {
  if (xfBroadcastRaf) return;
  xfBroadcastRaf = requestAnimationFrame(async () => {
    xfBroadcastRaf = null;
    await broadcastDeckState();
  });
}

function isAnyDeckPlaying() {
  const a = getDeckAudio('a'), b = getDeckAudio('b');
  return !!(a && !a.paused) || !!(b && !b.paused);
}

/** Keep hardware crossfader aligned with the deck that owns the queue position (audible output). */
function syncCrossfaderToDeck(deck) {
  const xf = document.getElementById('crossfader');
  if (!xf) return;
  xf.value = deck === 'b' ? 1 : 0;
  applyXfaderGains();
}

async function broadcastDeckState(extra = {}) {
  const audible = getAudibleDeck();
  const t = Engine.decks[audible]?.track;
  const audio = getDeckAudio(audible);
  const next = DJ.queue[DJ.trackIndex + 1];
  const genre = t?.tags?.[0] || DJ.seedTags[0] || '';
  const dur = t ? (t.duration || audio?.duration || 0) : 0;
  const elapsed = audio?.currentTime || 0;
  const playing = DJ.started && isAnyDeckPlaying();
  const payload = {
    nowPlaying: t ? {
      title: t.title, artist: t.artist, album: t.album,
      duration: dur, elapsed,
      fadePoint: Engine.decks[audible]?.fadePoint,
      tags: t.tags, artwork: t.artwork || t.image || '',
      streamUrl: buildStreamUrlForTrack(t),
      youtubeId: t.youtubeId || null
    } : null,
    primaryDeck: audible,
    decks: { a: buildDeckPayload('a'), b: buildDeckPayload('b') },
    nextUp: next ? { title: next.title || '—', artist: next.artist || '—', artwork: next.artwork || next.image || '' } : null,
    genre: genre ? genre.charAt(0).toUpperCase() + genre.slice(1) : '',
    isPlaying: playing,
    isFading: !!Engine.isFading,
    messages: DJ.messages,
    ...extra
  };
  console.debug('[AutoDJ][NP]', payload.primaryDeck, payload.nowPlaying?.title, `${Math.round(elapsed)}s`);
  await Engine.broadcastNowPlaying(payload);
}

// Called on first user interaction to unlock AudioContext
async function startPlayback() {
  Engine.initAudioCtx();
  Engine.ensureDeckConnected('a');
  Engine.ensureDeckConnected('b');
  DJ.started = true;

  if (DJ.queue.length === 0) { setStatus('Add some tracks first!'); return; }
  // Notify server to start session (syncs trackIndex so server matches DJ console)
  if (DJ.trackIndex < 0) {
    DJ.trackIndex = 0;
    syncCrossfaderToDeck(DJ.currentDeck);
    await loadTrackOnDeck(DJ.currentDeck, DJ.queue[0]);
    // After loading first track, sync state to server (server starts at track -1, advanceTrack increments to 0)
    fetch('/api/playback/start', { method: 'POST' }).catch(() => {});
  } else {
    getDeckAudio(DJ.currentDeck).play().catch(()=>{});
    void broadcastDeckState();
  }
}

/** Wait until enough media is buffered to play (avoids silent crossfades). */
function waitForAudioReady(audio, timeoutMs = 30000) {
  if (!audio) return Promise.resolve();
  if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { cleanup(); resolve(); };
    const t = setTimeout(done, timeoutMs);
    const cleanup = () => {
      clearTimeout(t);
      audio.removeEventListener('canplaythrough', done);
      audio.removeEventListener('canplay', done);
      audio.removeEventListener('error', done);
    };
    audio.addEventListener('canplaythrough', done, { once: true });
    audio.addEventListener('canplay', done, { once: true });
    audio.addEventListener('error', done, { once: true });
  });
}

async function loadTrackOnDeck(deck, track, opts = {}) {
  if (!track) return;
  Engine.decks[deck].track = track;
  Engine.decks[deck].cuePoint = 0;
  Engine.decks[deck].fadePoint = null;
  Engine.decks[deck].bpm = null;

  const audio = getDeckAudio(deck);
  let streamUrl = null;

  if (track.type === 'local' || track.type === 'temp') {
    streamUrl = track.url;
    audio.src = streamUrl;
    audio.load();

  } else if (track.youtubeId) {
    // Download track to server cache, then play from local cached file
    setStatus(`⬇ Downloading: ${track.artist} — ${track.title}...`);
    try {
      const r = await fetch('/api/cache/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: track.youtubeId, title: track.title, artist: track.artist, _source: track._source || '', _instance: track._instance || '' })
      });
      const data = await r.json();
      if (r.ok && data.url) {
        streamUrl = data.url;
        track._streamUrl = data.url;
        if (data.title && (!track.title || track.title === '?')) track.title = data.title;
        setStatus(`▶ Playing: ${track.title} (${data.cached ? 'cached' : 'via ' + (data.source||'download')})`);
        audio.src = streamUrl;
        audio.load();
        // Batch pre-download upcoming tracks
        if (deck === DJ.currentDeck) preDownloadAhead();
      } else {
        setStatus(`⚠ ${data.error || 'Download failed'}. Removing "${track.title}"...`);
        console.error('[LoadDeck] Download failed:', data.error);
        removeFailedTrack(DJ.queue.indexOf(track));
        setTimeout(() => advanceQueue(), 2000);
        return;
      }
    } catch(e) {
      setStatus(`⚠ Error: ${e.message}. Removing "${track.title}"...`);
      removeFailedTrack(DJ.queue.indexOf(track));
      setTimeout(() => advanceQueue(), 2000);
      return;
    }
  } else {
    setStatus(`No source for: ${track.title} — removing`);
    removeFailedTrack(DJ.queue.indexOf(track));
    setTimeout(() => advanceQueue(), 1500);
    return;
  }

  // Update UI
  document.getElementById(`title-${deck}`).textContent = track.title || '—';
  document.getElementById(`artist-${deck}`).textContent = track.artist || '—';
  document.getElementById(`album-${deck}`).textContent = track.album || '';
  document.getElementById(`tags-${deck}`).textContent = track.tags?.slice(0,4).join(' · ') || '';
  updateDeckArtwork(deck, track);

  if (deck === DJ.currentDeck) {
    document.getElementById('deck-a').classList.toggle('live', deck==='a');
    document.getElementById('deck-b').classList.toggle('live', deck==='b');
  }

  // Connect to WebAudio if needed
  Engine.ensureDeckConnected(deck);
  applyXfaderGains();

  await waitForAudioReady(audio);

  if (!opts.prepareOnly) {
    const playPromise = audio.play();
    if (playPromise) playPromise.then(() => updateMediaSession(track)).catch(e => {
      setStatus(`Play blocked (${deck.toUpperCase()}): click ▶ to start`);
    });
  }

  console.debug('[AutoDJ][loadTrack]', deck, track?.title, track?.youtubeId, opts.prepareOnly ? '(prepare)' : '');
  void broadcastDeckState();
}

async function onMetaLoaded(deck) {
  const audio = getDeckAudio(deck);
  const dur = audio.duration;
  const track = Engine.decks[deck].track;
  if (!Number.isFinite(dur) || dur <= 0) {
    document.getElementById(`dur-${deck}`).textContent = '—';
    return;
  }
  if (track && dur && Number.isFinite(dur)) {
    if (track.duration && dur > 1 && track.duration > dur * 2) {
      console.debug('[AutoDJ][duration]', 'search metadata', track.duration, '→ audio', dur);
    }
    if (dur < 21600) track.duration = dur;
  }

  // Update duration display
  document.getElementById(`dur-${deck}`).textContent = fmt(dur);

  // Smart fade analysis
  if (document.getElementById('smart-fade')?.checked && audio.src && Number.isFinite(dur)) {
    Engine.detectFadePoint(audio.src, dur).then(fp => {
      if (fp != null && Number.isFinite(fp)) Engine.decks[deck].fadePoint = fp;
    });
  }

  // BPM
  if (audio.src) {
    Engine.analyzeBPM(audio.src).then(bpm => {
      if (bpm) {
        Engine.decks[deck].bpm = bpm;
        document.getElementById(`bpm-${deck}`).textContent = bpm;
      }
    });
  }
}

function onPlayError(deck) {
  const audible = getAudibleDeck();
  if (deck === audible || deck === DJ.currentDeck) {
    setStatus(`⚠ Stream error on ${deck.toUpperCase()} — skipping`);
    void broadcastDeckState({ streamError: true, errorDeck: deck });
    setTimeout(() => void advanceQueue(), 1000);
  }
}

function playQueueTrack(idx) {
  if (idx < 0 || idx >= DJ.queue.length) return;
  Engine.initAudioCtx();
  DJ.started = true;
  // Stop current playback on current deck
  const audio = getDeckAudio(DJ.currentDeck);
  if (audio) { audio.pause(); audio.src = ''; }
  DJ.trackIndex = idx;
  Engine.isFading = false;
  syncCrossfaderToDeck(DJ.currentDeck);
  loadTrackOnDeck(DJ.currentDeck, DJ.queue[idx]);
  renderQueue();
  // Sync server state: update queue + notify server of new trackIndex
  fetch('/api/queue', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queue: DJ.queue, trackIndex: DJ.trackIndex })
  }).catch(() => {});
  fetch('/api/playback/next', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackIndex: DJ.trackIndex })
  }).catch(() => {});
}

function onTrackEnded(deck) {
  if (deck !== DJ.currentDeck) return;
  void advanceQueue();
}

function removeFailedTrack(idx) {
  if (idx < 0 || idx >= DJ.queue.length) return;
  const t = DJ.queue[idx];
  DJ.queue.splice(idx, 1);
  if (idx <= DJ.trackIndex) DJ.trackIndex = Math.max(-1, DJ.trackIndex - 1);
  fetch('/api/queue/remove/' + idx, { method: 'POST' }).catch(() => {});
  renderQueue();
  log(`Removed failed: ${t?.title || '?'}`);
}

async function advanceQueue() {
  DJ.fadeLock = false;
  const justPlayed = DJ.queue[DJ.trackIndex];
  if (justPlayed) {
    DJ.history.push(justPlayed);
    addToRecentlyPlayed(justPlayed.artist, justPlayed.title);
    if (justPlayed.youtubeId) DJ.usedTracks.add(`yt:${justPlayed.youtubeId}`);
  }
  DJ.trackIndex++;
  pruneUsedTracks();

  // Mark as played in cache (triggers auto-cleanup of old cached files)
  if (justPlayed?.youtubeId) {
    fetch('/api/cache/played', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: justPlayed.youtubeId }) }).catch(() => {});
    fetch('/api/playback/played', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: justPlayed.youtubeId }) }).catch(() => {});
  }
  // Notify server of advancement (syncs trackIndex for persistence)
  fetch('/api/playback/next', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackIndex: DJ.trackIndex }) }).catch(() => {});

  if (DJ.trackIndex >= DJ.queue.length) {
    setStatus('Queue ended — fetching more tracks...');
    fetchMoreOnline().then(async () => {
      if (DJ.queue.length > DJ.trackIndex) {
        const nd = getNextDeck();
        DJ.currentDeck = nd;
        syncCrossfaderToDeck(nd);
        await loadTrackOnDeck(nd, DJ.queue[DJ.trackIndex]);
        preDownloadAhead();
        renderQueue();
      }
    });
    return;
  }

  const track = DJ.queue[DJ.trackIndex];
  const nextDeck = getNextDeck();
  DJ.currentDeck = nextDeck;
  syncCrossfaderToDeck(nextDeck);
  await loadTrackOnDeck(nextDeck, track);
  document.getElementById('deck-a').classList.toggle('live', nextDeck==='a');
  document.getElementById('deck-b').classList.toggle('live', nextDeck==='b');
  renderQueue();
  void broadcastDeckState();

  // Keep queue topped up
  if (DJ.queue.length - DJ.trackIndex < 3) fetchMoreOnline();
  preDownloadAhead();
  checkAutoCleanTemp();
}

// ─── Deck Controls ────────────────────────────────────────────────────────────
function deckPlay(deck) {
  if (!DJ.started) { startPlayback(); return; }
  Engine.initAudioCtx();
  Engine.ensureDeckConnected(deck);
  const audio = getDeckAudio(deck);
  if (!audio.src) { setStatus(`No track on Deck ${deck.toUpperCase()} — queue something first`); return; }
  audio.play().then(() => { setStatus(`▶ Playing Deck ${deck.toUpperCase()}`); void broadcastDeckState(); })
    .catch(e => setStatus(`Play error: ${e.message} — click again`));
}
function deckPause(deck) {
  getDeckAudio(deck).pause();
  void broadcastDeckState();
}
function deckStop(deck) { const a = getDeckAudio(deck); a.pause(); a.currentTime = 0; void broadcastDeckState(); }
function deckSkip(deck, ev) {
  if (ev && ev.shiftKey) { forceSkipNext(); return; }
  if (deck === DJ.currentDeck) { triggerCrossfade(); return; }
  setStatus(`Skip: Shift+⏭ forces next — live deck is ${DJ.currentDeck.toUpperCase()}`);
}

function forceSkipNext() {
  const a = getDeckAudio(DJ.currentDeck);
  a.pause();
  void advanceQueue();
}
function setCue(deck) {
  Engine.decks[deck].cuePoint = getDeckAudio(deck).currentTime;
  setStatus(`Cue set @ ${fmt(Engine.decks[deck].cuePoint)}`);
}
function seekDeck(deck, event) {
  const audio = getDeckAudio(deck);
  if (!audio.duration) return;
  const rect = document.getElementById(`prog-wrap-${deck}`).getBoundingClientRect();
  audio.currentTime = ((event.clientX - rect.left) / rect.width) * audio.duration;
}
function setVol(deck, val) {
  if (Engine.decks[deck].gain) Engine.decks[deck].gain.gain.value = parseFloat(val);
  document.getElementById(`vol-val-${deck}`).textContent = Math.round(val*100)+'%';
}
function setXfaderGains(val) {
  const v = parseFloat(val);
  if (Engine.decks.a.gain) Engine.decks.a.gain.gain.value = 1 - v;
  if (Engine.decks.b.gain) Engine.decks.b.gain.gain.value = v;
}
function onXfader(val) {
  setXfaderGains(val);
  scheduleDeckStateBroadcast();
}

function applyXfaderGains() {
  setXfaderGains(getCrossfaderValue());
}

// ─── Auto-mix trigger (fixed — no re-entrant firing) ─────────────────────────
function updateDeckUI(deck) {
  const audio = getDeckAudio(deck);
  const cur = audio.currentTime || 0;
  const rawDur = audio.duration || 0;
  const dur = Number.isFinite(rawDur) && rawDur > 0 ? rawDur : 0;
  const remain = dur > 0 ? dur - cur : 0;
  const pct = dur > 0 ? (cur / dur * 100) : 0;

  document.getElementById(`prog-${deck}`).style.width = pct + '%';
  document.getElementById(`time-${deck}`).textContent = fmt(cur);
  document.getElementById(`remain-${deck}`).textContent = (Number.isFinite(remain) && remain > 0) ? '-' + fmt(remain) : '0:00';
  document.getElementById(`dur-${deck}`).textContent = dur > 0 ? fmt(dur) : '—';

  // Throttled full state for display (crossfader + both decks)
  const audible = getAudibleDeck();
  if (deck === audible && Date.now() - DJ.lastNpBroadcast > 350) {
    DJ.lastNpBroadcast = Date.now();
    void broadcastDeckState();
  }

  // Auto-mix: fire when percentage-based threshold reached or time-based fade window
  if (!document.getElementById('automix')?.checked) return;
  if (deck !== DJ.currentDeck) return;
  if (Engine.isFading || DJ.fadeLock) return;
  if (!Number.isFinite(dur) || dur < 5 || !Number.isFinite(remain) || remain <= 0) return;

  const otherDeck = getNextDeck();
  const otherTrack = Engine.decks[otherDeck]?.track;
  if (!otherTrack) return;

  // Percentage-based trigger (default 80%)
  const fadePct = parseInt(document.getElementById('cfg-fade-pct')?.value) || 80;
  const pctPlayed = cur / dur * 100;
  if (pctPlayed >= fadePct && document.getElementById('smart-fade')?.checked) {
    DJ.fadeLock = true;
    void triggerCrossfade();
    return;
  }

  // Legacy time-based fallback
  if (!document.getElementById('smart-fade')?.checked) {
    const fadeSec = parseInt(document.getElementById('fade-dur')?.value) || 8;
    const fp = Engine.decks[deck].fadePoint;
    const triggerRemain = fp && Number.isFinite(fp) ? (dur - fp) : fadeSec;
    if (remain <= triggerRemain + 0.5 && remain > 0.5) {
      DJ.fadeLock = true;
      void triggerCrossfade();
    }
  }
}

// ─── Crossfade ────────────────────────────────────────────────────────────────
async function triggerCrossfade() {
  if (Engine.isFading) return;

  const fromDeck = DJ.currentDeck;
  const toDeck = getNextDeck();
  const dur = parseInt(document.getElementById('fade-dur')?.value) || 8;
  const nextTrack = DJ.queue[DJ.trackIndex + 1];

  if (!nextTrack) {
    setStatus('Fetching next track...');
    fetchMoreOnline().then(async () => {
      if (DJ.queue[DJ.trackIndex + 1]) await triggerCrossfade();
    });
    return;
  }

  DJ.trackIndex++;

  await loadTrackOnDeck(toDeck, nextTrack, { prepareOnly: true });

  document.getElementById('fade-btn').classList.add('fading');
  setStatus(`⇄ Crossfading → ${nextTrack.title}`);
  console.debug('[AutoDJ][xfade] start', fromDeck, '→', toDeck);
  Engine.broadcastNowPlaying({ isFading: true });

  Engine.crossfade(fromDeck, toDeck, dur, () => {
    DJ.currentDeck = toDeck;
    DJ.fadeLock = false;
    document.getElementById('deck-a').classList.toggle('live', toDeck==='a');
    document.getElementById('deck-b').classList.toggle('live', toDeck==='b');
    document.getElementById('fade-btn').classList.remove('fading');
    setStatus(`▶ ${nextTrack.title} — ${nextTrack.artist}`);
    applyXfaderGains();
    void broadcastDeckState();
    renderQueue();
    Engine.broadcastNowPlaying({ isFading: false });
    if (DJ.queue.length - DJ.trackIndex < 3) fetchMoreOnline();
  });
}

// ─── Render Loop (waveform + VU) ──────────────────────────────────────────────
function startRenderLoop() {
  const canvases = {
    a: document.getElementById('wave-a'),
    b: document.getElementById('wave-b')
  };
  let lastNp = 0;

  // Set canvas dimensions on first frame
  Object.entries(canvases).forEach(([k, c]) => {
    if (c) c.width = c.offsetWidth || 400;
  });
  window.addEventListener('resize', () => {
    Object.values(canvases).forEach(c => { if (c) c.width = c.offsetWidth; });
  });

  const loop = () => {
    ['a','b'].forEach(deck => {
      const audio = getDeckAudio(deck);
      const raw = audio?.duration;
      const dur = Number.isFinite(raw) && raw > 0 ? raw : 1;
      const cur = audio?.currentTime || 0;
      if (canvases[deck]) Engine.drawWaveform(deck, canvases[deck], cur / dur);

      const levels = Engine.getVULevel(deck);
      const bars = document.getElementById(`vu-${deck}`)?.children || [];
      levels.forEach((lv, i) => { if (bars[i]) bars[i].style.height = Math.max(2, lv*30)+'px'; });
    });
    // Broadcast state every 8s during playback to keep display in sync
    const now = Date.now();
    if (DJ.started && now - lastNp > 8000) {
      lastNp = now;
      broadcastDeckState();
    }
    // Update now-playing card in Mix tab
    updateNowPlayingCard();
    requestAnimationFrame(loop);
  };
  loop();
}

function updateNowPlayingCard() {
  const card = document.getElementById('mix-now-playing');
  if (!card) return;
  const track = DJ.queue[DJ.trackIndex];
  if (!track || DJ.trackIndex < 0) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const audio = getDeckAudio(DJ.currentDeck);
  const cur = audio?.currentTime || 0;
  const dur = audio?.duration || track.duration || 0;
  const titleEl = document.getElementById('np-title-display');
  const artistEl = document.getElementById('np-artist-display');
  if (titleEl) titleEl.textContent = track.title || '—';
  if (artistEl) artistEl.textContent = track.artist || '—';
  const elEl = document.getElementById('np-elapsed-display');
  const durEl = document.getElementById('np-duration-display');
  if (elEl) elEl.textContent = fmt(cur);
  if (durEl) durEl.textContent = fmt(dur);
  const artImg = document.getElementById('np-art-thumb');
  if (artImg) {
    if (track.artwork) { artImg.src = track.artwork; artImg.style.display = 'block'; }
    else artImg.style.display = 'none';
  }
}

function renderMixUpNext() {
  const box = document.getElementById('mix-up-next');
  if (!box) return;
  const start = DJ.trackIndex + 1;
  const slice = DJ.queue.slice(start, start + 8);
  if (!slice.length) {
    box.innerHTML = '<div style="padding:10px 12px;font-size:10px;color:var(--muted)">Up next — add more tracks to the queue</div>';
    return;
  }

  // Build a prominent "Next Up" card for the immediate next track
  const nextTrack = slice[0];
  let nextCardHtml = '';
  if (nextTrack) {
  nextCardHtml = `
    <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;margin:0 0 10px;background:var(--surface);border:1px solid var(--accent);border-radius:var(--radius-md)">
      ${nextTrack.artwork || nextTrack.image ? `<img src="${escHtml(nextTrack.artwork || nextTrack.image)}" style="width:44px;height:44px;border-radius:4px;object-fit:cover;flex-shrink:0" alt="">` : '<div style="width:44px;height:44px;border-radius:4px;background:var(--surface2);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:18px;color:var(--muted)">♪</div>'}
      <div style="font-size:9px;letter-spacing:3px;color:var(--accent);text-transform:uppercase;white-space:nowrap;flex-shrink:0">NEXT UP</div>
      <div style="flex:1;min-width:0;overflow:hidden">
        <div style="color:var(--bright);font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(nextTrack.title || '—')}</div>
        <div style="color:var(--text);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(nextTrack.artist || '—')}</div>
      </div>
      <button type="button" class="btn accent" style="padding:4px 10px;font-size:9px;flex-shrink:0" onclick="playQueueTrack(${start})">▶ Play Now</button>
      <button type="button" class="btn" style="padding:4px 8px;font-size:9px;flex-shrink:0" onclick="cueQueueTrack('b',${start})">Cue B</button>
    </div>`;
  }

  box.innerHTML = nextCardHtml + `
    <div style="padding:6px 12px 4px;font-size:9px;letter-spacing:2px;color:var(--muted);text-transform:uppercase">Queue upcoming</div>
    <div style="display:flex;flex-direction:column;gap:4px;padding:0 8px 10px;max-height:200px;overflow-y:auto">
      ${slice.map((t, i) => {
        const qi = start + i;
        return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--surface2);border-radius:2px;font-size:11px;border:1px solid var(--border)">
          <span style="color:var(--muted);width:20px">${qi + 1}</span>
          <div style="flex:1;min-width:0;overflow:hidden"><div style="color:var(--bright);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:${i===0?'600':'400'}">${escHtml(t.title || '—')}</div>
          <div style="color:var(--muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(t.artist || '—')}</div></div>
          <button type="button" class="btn" style="padding:2px 6px;font-size:9px" onclick="cueQueueTrack('a',${qi})">A</button>
          <button type="button" class="btn" style="padding:2px 6px;font-size:9px" onclick="cueQueueTrack('b',${qi})">B</button>
        </div>`;
      }).join('')}
    </div>`;
}

// ─── Queue ────────────────────────────────────────────────────────────────────
function renderQueue() {
  const list = document.getElementById('queue-list');
  document.getElementById('q-count').textContent = DJ.queue.length;
  if (!DJ.queue.length) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:11px">Queue empty</div>';
    return;
  }
  list.innerHTML = DJ.queue.map((t, i) => {
    const isPlay = i === DJ.trackIndex;
    const isNext = i === DJ.trackIndex + 1;
    const isPast = i < DJ.trackIndex;
    const src = t.type === 'temp' ? 'TEMP' : t.type === 'local' ? 'LOCAL' : 'ONLINE';
    const badgeClass = isPlay ? 'badge-play' : isNext ? 'badge-next' : t.type==='local' ? 'badge-loc' : 'badge-q';
    const badgeText = isPlay ? '▶ NOW' : isNext ? 'NEXT' : t.type==='temp' ? 'TEMP' : src;
    const badgeStyle = t.type==='temp' ? 'style="background:rgba(255,204,0,0.15);color:#ffcc00"' : '';
    return `<div class="qitem${isPlay?' playing':''}${isNext?' next':''}${isPast?' past':''} ${t.type}"
      draggable="${!isPlay}" data-idx="${i}"
      ondragstart="onDragStart(event,${i})" ondragover="onDragOver(event)"
      ondrop="onDrop(event,${i})" ondragleave="onDragLeave(event)">
      <div class="q-num">${i+1}</div>
      <div class="q-src">${src}</div>
      <div class="q-info">
        <div class="q-title">${escHtml(t.title || '—')}</div>
        <div class="q-artist">${escHtml(t.artist || '—')}${t.album ? ' · ' + escHtml(t.album) : ''}</div>
        ${t.tags?.length ? `<div class="q-tags">${t.tags.slice(0,3).join(' · ')}</div>` : ''}
      </div>
      <span class="q-badge ${badgeClass}" ${badgeStyle}>${badgeText}</span>
      <div class="q-dur">${t.duration ? fmt(t.duration) : '—'}</div>
      ${!isPast && !isPlay ? `<button class="q-play-now" onclick="playQueueTrack(${i})" title="Play now">▶</button>` : ''}
      <button class="q-remove" onclick="removeFromQueue(${i})">×</button>
    </div>`;
  }).join('');
  list.querySelector('.playing')?.scrollIntoView({ block:'nearest', behavior:'smooth' });

  // Sidebar
  const np = DJ.queue[DJ.trackIndex];
  if (np) {
    const el = document.getElementById('np-sidebar-title'); if (el) el.textContent = np.title;
    const ea = document.getElementById('np-sidebar-artist'); if (ea) ea.textContent = np.artist;
    const eg = document.getElementById('np-sidebar-genre'); if (eg) eg.textContent = np.tags?.slice(0,2).join(', ')||'—';
  }
  renderMixUpNext();
  persistQueue();
}

let dragIdx = null;
function onDragStart(e,i) { dragIdx=i; e.currentTarget.classList.add('dragging'); }
function onDragOver(e) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function onDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function onDrop(e,target) {
  e.preventDefault(); e.currentTarget.classList.remove('drag-over');
  if (dragIdx===null||dragIdx===target) return;
  const item = DJ.queue.splice(dragIdx,1)[0];
  DJ.queue.splice(target,0,item);
  if (dragIdx < DJ.trackIndex) DJ.trackIndex--;
  else if (target <= DJ.trackIndex) DJ.trackIndex++;
  dragIdx = null; renderQueue();
}
function removeFromQueue(i) {
  if (i===DJ.trackIndex) return;
  DJ.queue.splice(i,1);
  if (i < DJ.trackIndex) DJ.trackIndex--;
  renderQueue();
}
function shuffleQueue() {
  const past = DJ.queue.slice(0, DJ.trackIndex+1);
  const future = DJ.queue.slice(DJ.trackIndex+1).sort(()=>Math.random()-0.5);
  DJ.queue = [...past, ...future];
  renderQueue();
  setStatus('Queue shuffled');
}
function clearQueue() {
  const hasTemp = DJ.queue.slice(DJ.trackIndex+1).some(t=>t.type==='temp');
  DJ.queue = DJ.queue.slice(0, DJ.trackIndex+1);
  if (hasTemp) { fetch('/api/temp/clear',{method:'DELETE'}).catch(()=>{}); tempFileRegistry=[]; renderTempFiles(); }
  renderQueue();
  setStatus('Queue cleared');
}
function clearAllAndReset() {
  if (!confirm('Reset everything? This will clear the queue, stop playback, and reset the session.')) return;
  deckPause('a'); deckPause('b');
  DJ.queue = [];
  DJ.trackIndex = -1;
  DJ.history = [];
  DJ.usedTracks = new Set();
  DJ.started = false;
  DJ.currentDeck = 'a';
  fetch('/api/queue/clear', { method: 'POST' }).catch(() => {});
  renderQueue();
  updateDeckUI('a'); updateDeckUI('b');
  document.getElementById('queue-controls')?.classList.remove('has-queue');
  setStatus('Session reset — everything cleared');
}

// ─── Discovery ────────────────────────────────────────────────────────────────
async function startAutoDiscover() {
  const artist = document.getElementById('seed-artist')?.value.trim();
  const track = document.getElementById('seed-track')?.value.trim();
  if (!artist) { setStatus('Enter a seed artist'); return; }
  if (!DJ.hasLastfm) { setStatus('Add a Last.fm API key in Settings first'); return; }

  setStatus('Starting discovery...');
  DJ.knownArtists = [artist];
  DJ.usedTracks.clear();
  DJ.seedTags = [];

  try {
    const info = track ? await Engine.getTrackInfo(artist, track) : await Engine.getArtistInfo(artist);
    DJ.seedTags = info.tags || [];
    setStatus(`Tags: ${DJ.seedTags.slice(0,4).join(', ') || 'none found'}`);

    let seeds = track ? [{title:track,artist}] : [];
    const tops = await Engine.getTopTracks(artist, 4);
    seeds.push(...tops);

    for (const t of seeds.slice(0, 3)) await enqueueOnlineTrack(t);

    if (DJ.trackIndex < 0 && DJ.queue.length > 0) {
      DJ.trackIndex = 0;
      startPlayback();
      renderQueue();
    }

    // Keep filling
    setTimeout(() => fetchMoreOnline(), 2000);
  } catch(e) { setStatus('Discovery error: ' + e.message); }
}

async function fetchMoreOnline() {
  if (DJ.discovering || !DJ.hasLastfm) return;
  DJ.discovering = true;
  const mode = document.getElementById('discovery-mode')?.value || 'both';
  let candidates = [];

  try {
    if ((mode === 'similar' || mode === 'both') && DJ.knownArtists.length) {
      const base = DJ.knownArtists[Math.floor(Math.random() * Math.min(DJ.knownArtists.length, 5))];
      const similar = await Engine.getSimilarArtists(base, 6);
      for (const a of similar.slice(0, 3)) {
        const tracks = await Engine.getTopTracks(a, 2);
        candidates.push(...tracks);
      }
    }
    if ((mode === 'tag' || mode === 'both') && DJ.seedTags.length) {
      const tag = DJ.seedTags[Math.floor(Math.random() * DJ.seedTags.length)];
      const tagTracks = await Engine.getTagTracks(tag, 5);
      candidates.push(...tagTracks);
    }
    const cur = DJ.queue[DJ.trackIndex];
    if (cur && cur.type === 'online') {
      const sim = await Engine.getSimilarTracks(cur.artist, cur.title, 5);
      candidates.push(...sim);
    }

    candidates = candidates.filter(c => {
      if (!c.artist || !c.title) return false;
      const key = `${dedupKey(c.artist)}::${dedupKey(c.title)}`;
      if (DJ.usedTracks.has(key)) return false;
      if (isRecentlyPlayed(c.artist, c.title)) return false;
      if (isInQueue(c.artist, c.title)) return false;
      return true;
    }).sort(() => Math.random() - 0.5);

    let added = 0;
    for (const t of candidates) {
      if (added >= 4) break;
      if (await enqueueOnlineTrack(t)) added++;
    }
    if (added > 0) { renderQueue(); setStatus(`Queued ${added} new track${added!==1?'s':''} from discovery`); }
  } catch(e) { setStatus('Discovery error: ' + e.message); }
  finally { DJ.discovering = false; }
}

async function enqueueOnlineTrack(t) {
  if (!t.artist || !t.title) return false;
  const key = `${dedupKey(t.artist)}::${dedupKey(t.title)}`;
  const ytKey = t.youtubeId ? `yt:${t.youtubeId}` : '';

  // Check all dedup sources
  if (DJ.usedTracks.has(key)) return false;
  if (ytKey && DJ.usedTracks.has(ytKey)) return false;
  if (isRecentlyPlayed(t.artist, t.title)) return false;
  if (isInQueue(t.artist, t.title)) return false;

  setStatus(`Searching: ${t.title} — ${t.artist}`);
  const result = await Engine.searchVideo(t.artist, t.title);
  if (!result || !result.videoId) { setStatus(`No source for: ${t.artist} — ${t.title}`); return false; }

  let info = { tags: [], album: '', image: '', duration: 0 };
  if (DJ.hasLastfm) { try { info = await Engine.getTrackInfo(t.artist, t.title); } catch(e) {} }
  DJ.usedTracks.add(key);
  if (ytKey) DJ.usedTracks.add(ytKey);

  const fromSearch = result.lengthSeconds != null ? normalizeClientDuration(result.lengthSeconds) : 0;

  // Song length filter
  const maxMin = parseInt(document.getElementById('cfg-max-track')?.value) || 0;
  const durSec = info.duration || t.duration || fromSearch || 0;
  if (maxMin > 0 && durSec > maxMin * 60) {
    setStatus(`Skipped (${durSec}s exceeds ${maxMin}min limit): ${t.title}`);
    return false;
  }

  const track = {
    type: 'online', youtubeId: result.videoId,
    _source: result._source || '', _instance: result._instance || '',
    title: t.title, artist: t.artist,
    album: info.album || '', tags: info.tags || [],
    duration: info.duration || t.duration || fromSearch || 0,
    image: info.image || '', artwork: info.image || ''
  };
  DJ.queue.push(track);
  if (!DJ.knownArtists.includes(t.artist)) DJ.knownArtists.push(t.artist);
  (info.tags||[]).forEach(tag => { if (!DJ.seedTags.includes(tag)) DJ.seedTags.push(tag); });
  renderQueue();
  return true;
}

/** Pre-download upcoming tracks in batch. */
async function preDownloadAhead() {
  const count = parseInt(document.getElementById('cfg-predownload')?.value) || 5;
  const pending = [];
  for (let i = DJ.trackIndex + 1; i < DJ.queue.length && pending.length < count; i++) {
    const t = DJ.queue[i];
    if (t.type === 'online' && t.youtubeId && !t._downloadStarted) {
      pending.push(t);
      t._downloadStarted = true;
    }
  }
  if (!pending.length) return;
  try {
    const r = await fetch('/api/cache/downloadBatch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: pending.map(t => ({
        videoId: t.youtubeId, title: t.title, artist: t.artist,
        _source: t._source || '', _instance: t._instance || ''
      })) })
    });
    const data = await r.json();
    if (data.results) {
      const ok = data.results.filter(r => r.ok).length;
      if (ok > 0) console.debug(`[AutoDJ] Pre-downloaded ${ok}/${data.results.length} tracks ahead`);
    }
  } catch (e) { /* background download failure is non-fatal */ }
}

// ─── Spotify ──────────────────────────────────────────────────────────────────
async function spotifySearch() {
  if (!DJ.hasSpotify) { setStatus('Configure Spotify credentials in Settings'); return; }
  const q = document.getElementById('spotify-search')?.value.trim();
  const type = document.getElementById('spotify-type')?.value;
  const div = document.getElementById('spotify-results');
  if (!q || !div) return;
  div.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:8px">Searching...</div>';
  try {
    let tracks = [];
    if (type === 'track') {
      const d = await (await fetch(`/api/spotify/search?q=${encodeURIComponent(q)}&type=track&limit=5`)).json();
      tracks = (d.tracks?.items||[]).map(t=>({title:t.name,artist:t.artists?.[0]?.name||'',album:t.album?.name||'',duration:Math.round(t.duration_ms/1000),image:t.album?.images?.[0]?.url||'',tags:[]}));
    } else if (type === 'artist') {
      const d = await (await fetch(`/api/spotify/search?q=${encodeURIComponent(q)}&type=artist&limit=1`)).json();
      const id = d.artists?.items?.[0]?.id;
      if (id) { const d2 = await (await fetch(`/api/spotify/artists/${id}/top-tracks?market=US`)).json();
        tracks = (d2.tracks||[]).slice(0,5).map(t=>({title:t.name,artist:t.artists?.[0]?.name||q,album:t.album?.name||'',duration:Math.round(t.duration_ms/1000),image:t.album?.images?.[0]?.url||'',tags:[]})); }
    } else {
      const sr = await (await fetch(`/api/spotify/search?q=${encodeURIComponent(q)}&type=track&limit=1`)).json();
      const sid = sr.tracks?.items?.[0]?.id;
      if (sid) { const rd = await (await fetch(`/api/spotify/recommendations?seed_tracks=${sid}&limit=8`)).json();
        tracks = (rd.tracks||[]).map(t=>({title:t.name,artist:t.artists?.[0]?.name||'',album:t.album?.name||'',duration:Math.round(t.duration_ms/1000),image:t.album?.images?.[0]?.url||'',tags:[]})); }
    }
    div.innerHTML = tracks.length ? tracks.map((t,i) => `
      <div class="spotify-result">
        ${t.image?`<img class="sp-img" src="${t.image}">`:'<div class="sp-img" style="background:var(--border)">♪</div>'}
        <div class="sp-info"><div class="sp-name">${t.title}</div><div class="sp-artist">${t.artist}${t.album?' · '+t.album:''}</div></div>
        <button class="btn" style="padding:3px 8px;font-size:9px" onclick='queueSpotifyTrack(${JSON.stringify(t).replace(/'/g,"&#39;")})'>Queue</button>
      </div>`).join('') : '<div style="color:var(--muted);font-size:11px;padding:8px">No results</div>';
  } catch(e) { div.innerHTML = `<div style="color:var(--accent2);font-size:11px;padding:8px">Error: ${e.message}</div>`; }
}

async function queueSpotifyTrack(t) {
  setStatus(`Finding "${t.title}"...`);
  const result = await Engine.searchVideo(t.artist, t.title);
  if (result && result.videoId) {
    DJ.queue.push({...t, type:'online', youtubeId:result.videoId, _source:result._source||'', _instance:result._instance||'', artwork:t.image});
    renderQueue();
    setStatus(`Queued: ${t.title}`);
  } else { setStatus(`Not found: ${t.title}`); }
}

// ─── AI ───────────────────────────────────────────────────────────────────────
async function aiAnalyzeAndRecommend() {
  if (!DJ.hasAI) { setStatus('Configure an AI key in Settings first'); return; }
  const el = document.getElementById('ai-result');
  el.innerHTML = '<span style="color:var(--muted)">Consulting AI...</span>';
  try {
    const cur = DJ.queue[DJ.trackIndex];
    const recs = await Engine.aiRecommend(cur, DJ.history, DJ.seedTags, document.getElementById('ai-mood')?.value);
    el.innerHTML = (Array.isArray(recs) ? recs : []).map(r =>
      `<div style="margin-bottom:8px;border-bottom:1px solid var(--border);padding-bottom:6px">
        <div style="color:var(--bright)">${r.title} — ${r.artist}</div>
        <div style="color:var(--accent3);font-size:10px">${r.reason||''}</div>
        <button class="btn" style="padding:3px 8px;font-size:9px;margin-top:4px"
          onclick="enqueueAITrack('${r.artist.replace(/'/g,"\\'")}','${r.title.replace(/'/g,"\\'")}')">+ Queue</button>
      </div>`).join('') || '<span style="color:var(--muted)">No recommendations returned</span>';
  } catch(e) { el.innerHTML = `<span style="color:var(--accent2)">Error: ${e.message}</span>`; }
}

async function enqueueAITrack(artist, title) {
  const result = await Engine.searchVideo(artist, title);
  if (result?.videoId) {
    DJ.queue.push({type:'online',youtubeId:result.videoId,_source:result._source||'',_instance:result._instance||'',title,artist,tags:DJ.seedTags.slice(0,3)});
    renderQueue(); setStatus(`Queued: ${title}`);
  } else setStatus(`Not found: ${title}`);
}

async function aiRefillQueue() {
  if (!DJ.hasAI) { setStatus('Configure an AI key in Settings first'); return; }
  setStatus('AI refilling queue...');
  try {
    const recs = await Engine.aiRecommend(DJ.queue[DJ.trackIndex], DJ.history, DJ.seedTags, document.getElementById('ai-mood')?.value||'');
    let added = 0;
    for (const r of (Array.isArray(recs)?recs:[])) {
      const result = await Engine.searchVideo(r.artist, r.title);
      if (result?.videoId) { DJ.queue.push({type:'online',youtubeId:result.videoId,_source:result._source||'',_instance:result._instance||'',title:r.title,artist:r.artist,tags:[]}); added++; }
    }
    renderQueue(); setStatus(`AI added ${added} tracks`);
  } catch(e) { setStatus('AI error: '+e.message); }
}

// ─── Broadcast Now Playing ────────────────────────────────────────────────────
async function broadcastNP(track) {
  await broadcastDeckState();
}

// ─── Temp Upload ──────────────────────────────────────────────────────────────
let tempFileRegistry = [];

async function uploadTempFiles(fileList) {
  if (!fileList?.length) return;
  const statusEl = document.getElementById('temp-status');
  if (statusEl) { statusEl.style.display='block'; statusEl.textContent=`Uploading ${fileList.length} file(s)...`; }
  const fd = new FormData();
  let count = 0;
  for (const f of fileList) {
    if (f.type.startsWith('audio/') || f.name.match(/\.(mp3|flac|wav|ogg|m4a|aac|opus|wma)$/i)) { fd.append('files',f); count++; }
  }
  if (!count) { if (statusEl) statusEl.textContent='No audio files found.'; return; }
  try {
    const r = await fetch('/api/temp/upload',{method:'POST',body:fd});
    const data = await r.json();
    if (!data.ok) throw new Error(data.error||'Upload failed');
    for (const f of data.files) {
      const track = { type:'temp', url:f.url, title:f.title, artist:f.artist||'Unknown',
        album:'', duration:0, tags:[], storedName:f.storedName };
      DJ.queue.push(track);
      tempFileRegistry.push(track);
      // Auto-start if not playing
      if (!DJ.started && DJ.queue.length === 1) {
        DJ.trackIndex = 0;
        startPlayback();
      }
    }
    renderQueue(); renderTempFiles();
    if (statusEl) { statusEl.textContent=`✓ ${data.count} file(s) queued`; setTimeout(()=>{statusEl.style.display='none';},3000); }
    setStatus(`Temp: ${data.count} files queued`);
  } catch(e) { if (statusEl) statusEl.textContent=`Error: ${e.message}`; }
}

async function renderTempFiles() {
  try {
    const files = await (await fetch('/api/temp/list')).json();
    const panel = document.getElementById('temp-files-panel');
    const list = document.getElementById('temp-file-list');
    const countEl = document.getElementById('temp-count');
    if (!panel) return;
    if (!files.length) { panel.style.display='none'; return; }
    panel.style.display='block';
    if (countEl) countEl.textContent = files.length;
    list.innerHTML = files.map(f=>`
      <div class="temp-file-item">
        <span class="tf-name" title="${f.filename}">⏳ ${f.filename}</span>
        <span class="tf-size">${fmtBytes(f.size)}</span>
        <button class="tf-del" onclick="deleteTempFile('${f.storedName}')">×</button>
      </div>`).join('');
  } catch(e) {}
}

async function deleteTempFile(stored) {
  await fetch(`/api/temp/file?file=${encodeURIComponent(stored)}`,{method:'DELETE'});
  const i = DJ.queue.findIndex(t=>t.storedName===stored);
  if (i > DJ.trackIndex) DJ.queue.splice(i,1);
  tempFileRegistry = tempFileRegistry.filter(t=>t.storedName!==stored);
  renderQueue(); renderTempFiles();
}

async function clearTempFiles() {
  if (!confirm('Clear all temp files?')) return;
  await fetch('/api/temp/clear',{method:'DELETE'});
  DJ.queue = DJ.queue.filter(t=>t.type!=='temp');
  tempFileRegistry = [];
  renderQueue(); renderTempFiles();
  setStatus('Temp files cleared');
}

function checkAutoCleanTemp() {
  const rem = DJ.queue.slice(DJ.trackIndex+1).some(t=>t.type==='temp');
  if (!rem && tempFileRegistry.length > 0) {
    fetch('/api/temp/clear',{method:'DELETE'}).catch(()=>{});
    tempFileRegistry = [];
    renderTempFiles();
  }
}

setInterval(renderTempFiles, 5000);

// ─── System Stats ─────────────────────────────────────────────────────────────
function fmtBytes(b) {
  if (!b) return '0 B';
  const k=1024, s=['B','KB','MB','GB','TB'];
  const i=Math.floor(Math.log(b)/Math.log(k));
  return (b/Math.pow(k,i)).toFixed(1)+' '+s[i];
}
function fmtUptime(s) {
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60);
  return h>0?`${h}h ${m}m`:`${m}m`;
}

async function updateSystemStats() {
  try {
    const s = await (await fetch('/api/system/stats')).json();
    const set = (id, val) => { const e=document.getElementById(id); if(e) e.textContent=val; };
    const setW = (id, pct) => { const e=document.getElementById(id); if(e) e.style.width=(pct||0)+'%'; };
    const warn = (id, cond) => { const e=document.getElementById(id); if(e) e.className='stat-value'+(cond?' stat-warn':''); };

    const cpuPct = s.cpu?.percent;
    const cpuLabel = cpuPct != null ? cpuPct + '%' : '—';
    set('stat-cpu', cpuLabel); warn('stat-cpu', cpuPct != null && cpuPct > 85);
    set('stat-cpu-sub', `${s.cpu?.cores ?? '—'} cores · ${(s.cpu?.model || '—').toString().substring(0,24)}`);
    setW('stat-cpu-bar', cpuPct != null ? cpuPct : 0);

    const ramPct = s.ram?.percent ?? 0;
    set('stat-ram', ramPct+'%'); warn('stat-ram', ramPct>85);
    set('stat-ram-sub', `${fmtBytes(s.ram?.used||0)} / ${fmtBytes(s.ram?.total||0)}`);
    setW('stat-ram-bar', ramPct);

    const diskPct = s.disk?.percent ?? 0;
    set('stat-disk', (s.disk?.total ? diskPct+'%' : '—')); warn('stat-disk', diskPct>90);
    set('stat-disk-sub', `${fmtBytes(s.disk?.free||0)} free of ${fmtBytes(s.disk?.total||0)}`);
    setW('stat-disk-bar', s.disk?.total ? diskPct : 0);

    const tf = s.temp?.files ?? 0, tsz = s.temp?.size ?? 0;
    set('stat-temp', String(tf));
    set('stat-temp-sub', `${fmtBytes(tsz)} · up ${fmtUptime(s.uptime||0)}`);
    setW('stat-temp-bar', tf>0?100:5);

    // Session & queue indicators
    const sdur = s.sessionDuration || DJ.config?.sessionDuration || 0;
    const qlim = s.queueLimit || DJ.config?.queueLimit || 0;
    if (sdur > 0 && s.sessionActive && s.sessionStart) {
      const elapsed = (Date.now() - (typeof s.sessionStart === 'number' ? s.sessionStart : new Date(s.sessionStart).getTime())) / 3600000;
      const remain = Math.max(0, sdur - elapsed);
      set('stat-session', remain > 1 ? `${Math.floor(remain)}h ${Math.floor((remain%1)*60)}m` : `${Math.floor(remain*60)}m`);
      set('stat-session-sub', `${sdur}h limit`);
    } else if (sdur > 0) {
      set('stat-session', `${sdur}h`);
      set('stat-session-sub', 'not started');
    } else {
      set('stat-session', '∞');
      set('stat-session-sub', 'no limit');
    }
    const qlen = s.queueLength ?? DJ.queue?.length ?? 0;
    if (qlim > 0) {
      set('stat-queue-limit', `${qlen}/${qlim}`);
      set('stat-queue-limit-sub', qlen >= qlim ? 'FULL' : `${qlim - qlen} slots open`);
    } else {
      set('stat-queue-limit', String(qlen));
      set('stat-queue-limit-sub', 'no limit');
    }
  } catch(e) {}
}
setInterval(updateSystemStats, 3000);
updateSystemStats();

// ─── Listeners ────────────────────────────────────────────────────────────────
async function fetchListeners() {
  try {
    const r = await fetch('/api/listeners');
    const d = await r.json();
    const badge = document.getElementById('listener-count-badge');
    if (badge) badge.textContent = d.count || '0';
    const tbody = document.getElementById('listener-tbody');
    if (!tbody) return;
    if (!d.listeners || d.listeners.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="padding:24px;text-align:center;color:var(--muted)">No listeners connected. Open /display in another tab.</td></tr>';
      return;
    }
    tbody.innerHTML = d.listeners.map(l => {
      const device = l.isMobile ? '📱 Mobile' : l.isTablet ? '📟 Tablet' : '🖥️ Desktop';
      const ago = l.connectedAgo < 60000 ? `${Math.floor(l.connectedAgo/1000)}s` : `${Math.floor(l.connectedAgo/60000)}m`;
      return `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:6px 12px;color:var(--muted)">${l.id}</td>
        <td style="padding:6px 12px;font-family:monospace;font-size:10px">${l.ip}</td>
        <td style="padding:6px 12px">${l.browser}</td>
        <td style="padding:6px 12px">${l.os}</td>
        <td style="padding:6px 12px">${device}</td>
        <td style="padding:6px 12px"><span style="background:var(--surface2);padding:2px 8px;border-radius:var(--radius-sm);font-size:10px;color:var(--accent)">${l.page}</span></td>
        <td style="padding:6px 12px;text-align:right;color:var(--muted)">${ago}</td>
      </tr>`;
    }).join('');
  } catch(e) { /* ignore poll errors */ }
}
setInterval(fetchListeners, 5000);

// ─── Messages ─────────────────────────────────────────────────────────────────
function renderMessages() {
  const list = document.getElementById('msg-list');
  if (!list) return;
  list.innerHTML = DJ.messages.map((m,i)=>`
    <div class="msg-item"><span>${m}</span>
    <button class="msg-del" onclick="removeMessage(${i})">×</button></div>`).join('');
}
function addMessage() {
  const inp = document.getElementById('new-msg');
  const val = inp?.value.trim(); if (!val) return;
  DJ.messages.push(val); inp.value='';
  renderMessages(); Engine.broadcastNowPlaying({messages:DJ.messages});
}
function removeMessage(i) { DJ.messages.splice(i,1); renderMessages(); Engine.broadcastNowPlaying({messages:DJ.messages}); }

function escHtml(str) {
  const e = document.createElement('span');
  e.textContent = str == null ? '' : String(str);
  return e.innerHTML;
}

function queueFromUnifiedSearch(p) {
  if (!p || !p.videoId) return;
  const ytKey = `yt:${p.videoId}`;
  if (DJ.usedTracks.has(ytKey)) {
    setStatus(`Already played this session: ${p.title || p.videoId}`);
    return;
  }
  const dur = p.lengthSeconds != null ? normalizeClientDuration(p.lengthSeconds) : 0;
  const maxMin = parseInt(document.getElementById('cfg-max-track')?.value) || 0;
  if (maxMin > 0 && dur > maxMin * 60) {
    setStatus(`Skipped (${dur}s exceeds ${maxMin}min limit): ${p.title}`);
    return;
  }
  DJ.queue.push({
    type: 'online',
    youtubeId: p.videoId,
    title: p.title || 'Unknown',
    artist: p.author || p.uploader || 'Unknown',
    _source: p._source || '',
    _instance: p._instance || '',
    artwork: p.artwork || '',
    duration: dur
  });
  renderQueue();
  setStatus(`Queued: ${p.title || p.videoId}`);
}

async function unifiedQueueSearch() {
  const inp = document.getElementById('unified-search-q');
  const box = document.getElementById('unified-search-results');
  const q = inp?.value.trim();
  if (!q || !box) return;
  box.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:8px">Searching…</div>';
  try {
    const r = await fetch(`/api/youtube/search?q=${encodeURIComponent(q)}`);
    const results = await r.json();
    if (!Array.isArray(results) || !results.length) {
      box.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:8px">No results. Try another query or add a Jamendo client id in Settings.</div>';
      return;
    }
    box.innerHTML = results.map(it => {
      const payload = encodeURIComponent(JSON.stringify({
        videoId: it.videoId,
        title: it.title,
        author: it.author || it.uploader || it.channel || '',
        uploader: it.uploader,
        _source: it._source,
        _instance: it._instance,
        artwork: it.artwork,
        lengthSeconds: it.lengthSeconds
      }));
      const who = it.author || it.uploader || it.channel || '—';
      const src = it._source || '';
      const art = it.artwork || '';
      return `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);font-size:11px">
        ${art ? `<img src="${art}" style="width:36px;height:36px;border-radius:3px;object-fit:cover;flex-shrink:0" alt="">` : '<div style="width:36px;height:36px;border-radius:3px;background:var(--surface2);flex-shrink:0"></div>'}
        <div style="flex:1;min-width:0">
          <div style="color:var(--bright);font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(it.title || '—')}</div>
          <div style="color:var(--text);font-size:10px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(who)}${src ? ' <span style="color:var(--muted)">·</span> ' + escHtml(src) : ''}</div>
        </div>
        <button type="button" class="btn accent" style="padding:4px 10px;font-size:9px;flex-shrink:0" data-add="${payload}">+ Queue</button>
      </div>`;
    }).join('');
    box.querySelectorAll('[data-add]').forEach(btn => {
      btn.addEventListener('click', () => {
        try { queueFromUnifiedSearch(JSON.parse(decodeURIComponent(btn.getAttribute('data-add')))); } catch (err) {}
      });
    });
  } catch (e) {
    box.innerHTML = `<div style="color:var(--accent2);font-size:11px;padding:8px">${escHtml(e.message)}</div>`;
  }
}

async function testSources() {
  const out = document.getElementById('src-test-out');
  if (!out) return;
  out.textContent = 'Testing…';
  try {
    const d = await (await fetch('/api/test/sources')).json();
    const lines = [];
    lines.push(`Up ${d.summary?.up ?? 0} / ${d.summary?.total ?? 0}`);
    for (const [type, arr] of Object.entries(d.results || {})) {
      const upc = (arr || []).filter(x => x.ok).length;
      lines.push(`${type}: ${upc}/${(arr || []).length}`);
    }
    out.textContent = lines.join(' · ');
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
  }
}

// ─── Drop Zone ────────────────────────────────────────────────────────────────
function setupDropZone() {
  const dz = document.getElementById('drop-zone');
  if (!dz) return;
  dz.addEventListener('dragenter', e=>{e.preventDefault();dz.classList.add('drag-over');});
  dz.addEventListener('dragover', e=>e.preventDefault());
  dz.addEventListener('dragleave', ()=>dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e=>{e.preventDefault();dz.classList.remove('drag-over');addLocalFiles(e.dataTransfer.files);});
}

/** Normalize a string for dedup comparison (lowercase, trim, collapse whitespace). */
function dedupKey(s) {
  return String(s).toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Check if a track is already in the recently-played sliding window. */
function isRecentlyPlayed(artist, title) {
  const key = `${dedupKey(artist)}::${dedupKey(title)}`;
  return DJ.recentlyPlayed && DJ.recentlyPlayed.includes(key);
}

/** Check if a track is already in the current queue (by normalized title+artist). */
function isInQueue(artist, title) {
  const key = `${dedupKey(artist)}::${dedupKey(title)}`;
  return DJ.queue.some(t => {
    const tk = `${dedupKey(t.artist)}::${dedupKey(t.title)}`;
    return tk === key || (t.youtubeId && t.youtubeId === artist);
  });
}

/** Add a track to the recently-played sliding window (max 20). */
function addToRecentlyPlayed(artist, title) {
  if (!DJ.recentlyPlayed) DJ.recentlyPlayed = [];
  DJ.recentlyPlayed.push(`${dedupKey(artist)}::${dedupKey(title)}`);
  if (DJ.recentlyPlayed.length > 20) DJ.recentlyPlayed.shift();
}

/** Update browser Media Session metadata (lock screen / notification). */
function updateMediaSession(track) {
  if (!track || !('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || '',
      artist: track.artist || '',
      album: track.album || '',
      artwork: track.artwork ? [{ src: track.artwork, sizes: '512x512', type: 'image/jpeg' }] : []
    });
    navigator.mediaSession.setActionHandler('play', () => deckPlay(DJ.currentDeck));
    navigator.mediaSession.setActionHandler('pause', () => deckPause(DJ.currentDeck));
    navigator.mediaSession.setActionHandler('nexttrack', () => forceSkipNext());
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      const audio = getDeckAudio(DJ.currentDeck);
      if (audio && details.seekTime != null) audio.currentTime = details.seekTime;
    });
  } catch (e) { /* Media Session not supported */ }
}

/** Prune usedTracks set to keep it from growing unbounded. */
function pruneUsedTracks() {
  if (DJ.usedTracks && DJ.usedTracks.size > 200) {
    const arr = [...DJ.usedTracks];
    DJ.usedTracks = new Set(arr.slice(arr.length - 150));
  }
}

// ─── Logs Tab ───────────────────────────────────────────────────────────────────
async function fetchLogs() {
  const container = document.getElementById('log-entries');
  if (!container) return;
  const level = document.getElementById('log-filter-level')?.value || '';
  try {
    const r = await fetch(`/api/logs?level=${level}`);
    const data = await r.json();
    const entries = data.entries || [];
    if (!entries.length) {
      container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted)">No log entries</div>';
      return;
    }
    container.innerHTML = entries.map(e => {
      const ts = new Date(e.ts).toLocaleTimeString('en-US', { hour12: false });
      const levelClass = e.level === 'error' ? 'color:var(--accent2)' : e.level === 'warn' ? 'color:var(--yellow)' : 'color:var(--muted)';
      return `<div style="padding:3px 12px;border-bottom:1px solid var(--border);display:flex;gap:8px">
        <span style="color:var(--muted);flex-shrink:0">${ts}</span>
        <span style="${levelClass};flex-shrink:0">[${e.tag}]</span>
        <span style="color:var(--text);word-break:break-all">${escHtml(e.message)}</span>
      </div>`;
    }).join('');
    container.scrollTop = container.scrollHeight;
  } catch (e) {
    container.innerHTML = `<div style="padding:16px;text-align:center;color:var(--accent2)">Error: ${escHtml(e.message)}</div>`;
  }
}
async function clearLogs() {
  await fetch('/api/logs', { method: 'DELETE' });
  const container = document.getElementById('log-entries');
  if (container) container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted)">Logs cleared</div>';
}
async function copyLogs() {
  try {
    const r = await fetch('/api/logs');
    const data = await r.json();
    const text = (data.entries || []).map(e =>
      `${new Date(e.ts).toLocaleTimeString('en-US',{hour12:false})} [${e.tag}] ${e.message}`
    ).join('\n');
    await navigator.clipboard.writeText(text);
    setStatus(`Copied ${data.entries.length} log entries`);
  } catch (e) { setStatus('Copy failed: ' + e.message); }
}
async function downloadLogs() {
  try {
    const r = await fetch('/api/logs');
    const data = await r.json();
    const text = (data.entries || []).map(e =>
      `${new Date(e.ts).toISOString()} [${e.tag}] [${e.level}] ${e.message}`
    ).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `autodj-logs-${now}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus(`Downloaded ${data.entries.length} log entries`);
  } catch (e) { setStatus('Download failed: ' + e.message); }
}

// Auto-refresh logs every 3s when tab is visible
setInterval(() => {
  const logsTab = document.getElementById('tab-logs');
  if (logsTab && logsTab.classList.contains('active')) fetchLogs();
}, 3000);

// ─── Song Verification ─────────────────────────────────────────────────────────
async function verifyTrack(videoId, title, artist) {
  try {
    const r = await fetch('/api/cache/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, expectedTitle: title, expectedArtist: artist })
    });
    const d = await r.json();
    if (d.ok) {
      setStatus(`✓ Verified: "${title}" (title ${(d.titleSim*100).toFixed(0)}%, artist ${(d.artistSim*100).toFixed(0)}%)`);
    } else {
      setStatus(`⚠ Weak match: ID3 title="${d.id3?.title || '?'}" vs expected "${title}" (${(d.titleSim*100).toFixed(0)}%)`);
    }
    return d.ok;
  } catch (e) {
    setStatus(`Verify error: ${e.message}`);
    return false;
  }
}

// ─── WebRTC Shared Audio ──────────────────────────────────────────────────────
DJ._webrtcActive = false;
DJ._webrtcReceiver = null;
async function toggleWebRTC() {
  const btn = document.getElementById('share-audio-btn');
  if (DJ._webrtcActive) {
    Engine.stopWebRTCBroadcast();
    if (DJ._webrtcReceiver) {
      clearInterval(DJ._webrtcReceiver.poll);
      DJ._webrtcReceiver.pc.close();
      DJ._webrtcReceiver = null;
    }
    DJ._webrtcActive = false;
    if (btn) { btn.textContent = '🔊 Share Audio'; btn.classList.remove('green'); }
    setStatus('Audio sharing stopped');
    return;
  }
  try {
    await Engine.startWebRTCBroadcast();
    DJ._webrtcActive = true;
    if (btn) { btn.textContent = '🔇 Stop Sharing'; btn.classList.add('green'); }
    setStatus('Sharing audio — open the Display page to listen');
  } catch (e) {
    setStatus('Failed to start audio sharing: ' + e.message);
  }
}

// ─── Source Priority (drag-reorderable) ──────────────────────────────────────
function setupSourcePriorityDrag() {
  const list = document.getElementById('source-priority-list');
  if (!list) return;
  let dragSrc = null;
  list.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.src-prio-item');
    if (!item) return;
    dragSrc = item;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.dataset.src);
  });
  list.addEventListener('dragend', (e) => {
    e.target.closest('.src-prio-item')?.classList.remove('dragging');
    document.querySelectorAll('.src-prio-item').forEach(el => el.classList.remove('drag-over'));
    dragSrc = null;
  });
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.src-prio-item');
    if (!target || target === dragSrc) return;
    target.classList.add('drag-over');
  });
  list.addEventListener('dragleave', (e) => {
    e.target.closest('.src-prio-item')?.classList.remove('drag-over');
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    const target = e.target.closest('.src-prio-item');
    if (!target || !dragSrc || target === dragSrc) return;
    target.classList.remove('drag-over');
    const rect = target.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      list.insertBefore(dragSrc, target);
    } else {
      list.insertBefore(dragSrc, target.nextSibling);
    }
  });
}
function readSourcePriority() {
  const items = document.querySelectorAll('#source-priority-list .src-prio-item');
  return Array.from(items).map(el => el.dataset.src);
}
function renderSourcePriority(priority) {
  const list = document.getElementById('source-priority-list');
  if (!list || !Array.isArray(priority)) return;
  const items = Array.from(list.querySelectorAll('.src-prio-item'));
  const ordered = priority.map(s => items.find(el => el.dataset.src === s)).filter(Boolean);
  const remaining = items.filter(el => !priority.includes(el.dataset.src));
  list.replaceChildren(...ordered, ...remaining);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(s) {
  if (!s || isNaN(s) || s < 0) return '0:00';
  const sec = Math.round(s);
  if (sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const secs = sec % 60;
  if (m >= 60) return `${Math.floor(m/60)}:${(m%60).toString().padStart(2,'0')}:${secs.toString().padStart(2,'0')}`;
  return `${m}:${secs.toString().padStart(2,'0')}`;
}
function setStatus(msg) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
  console.log('[AutoDJ]', msg);
}
