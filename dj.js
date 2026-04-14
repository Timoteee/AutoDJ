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
  hasSpotify: false,
  hasAI: false,
  started: false,        // has user clicked play at least once
  discovering: false,    // prevent concurrent discovery runs
  fadeLock: false,       // prevent double-trigger of auto-mix
};

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupAudioElements();
  await loadConfig();
  startClock();
  setupDropZone();
  setStatus('Ready — add local files or set a seed artist in Discover tab');
  // Start render loop after a brief paint delay
  setTimeout(startRenderLoop, 200);
});

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
    DJ.hasSpotify = cfg.hasSpotify;
    DJ.hasAI = cfg.hasAI;

    if (cfg.lastfmKey) document.getElementById('cfg-lastfm').placeholder = '●●● configured ●●●';
    if (cfg.spotifyClientId) document.getElementById('cfg-sp-id').value = cfg.spotifyClientId;
    if (cfg.anthropicKey) document.getElementById('cfg-anthropic').placeholder = '●●● configured ●●●';
    if (cfg.openaiKey) document.getElementById('cfg-openai').placeholder = '●●● configured ●●●';
    document.getElementById('cfg-ai-provider').value = cfg.aiProvider || 'anthropic';
    if (cfg.musicDirs) document.getElementById('cfg-dirs').value = cfg.musicDirs.join('\n');
    if (cfg.messages) { DJ.messages = cfg.messages; renderMessages(); }

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
    spotifyClientId: document.getElementById('cfg-sp-id').value,
    spotifyClientSecret: document.getElementById('cfg-sp-secret').value,
    anthropicKey: document.getElementById('cfg-anthropic').value,
    openaiKey: document.getElementById('cfg-openai').value,
    aiProvider: document.getElementById('cfg-ai-provider').value,
    musicDirs: document.getElementById('cfg-dirs').value.split('\n').map(s=>s.trim()).filter(Boolean),
    messages: DJ.messages
  };
  await fetch('/api/config', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  await loadConfig(); // Refresh indicators
  setStatus('Configuration saved ✓');
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
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

// Called on first user interaction to unlock AudioContext
function startPlayback() {
  Engine.initAudioCtx();
  Engine.ensureDeckConnected('a');
  Engine.ensureDeckConnected('b');
  DJ.started = true;

  if (DJ.queue.length === 0) { setStatus('Add some tracks first!'); return; }
  if (DJ.trackIndex < 0) {
    DJ.trackIndex = 0;
    loadTrackOnDeck(DJ.currentDeck, DJ.queue[0]);
  } else {
    getDeckAudio(DJ.currentDeck).play().catch(()=>{});
  }
}

async function loadTrackOnDeck(deck, track) {
  if (!track) return;
  Engine.decks[deck].track = track;
  Engine.decks[deck].cuePoint = 0;
  Engine.decks[deck].fadePoint = null;
  Engine.decks[deck].bpm = null;
  DJ.fadeLock = false;

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
      } else {
        setStatus(`⚠ ${data.error || 'Download failed'}. Skipping "${track.title}"...`);
        console.error('[LoadDeck] Download failed:', data.error);
        setTimeout(() => advanceQueue(), 2000);
        return;
      }
    } catch(e) {
      setStatus(`⚠ Error: ${e.message}. Skipping...`);
      setTimeout(() => advanceQueue(), 2000);
      return;
    }
  } else {
    setStatus(`No source for: ${track.title} — skipping`);
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
  // Set volume: live deck = 1, staging deck = 0
  if (Engine.decks[deck].gain) {
    Engine.decks[deck].gain.gain.value = deck === DJ.currentDeck ? 1 : 0;
  }

  // Play
  const playPromise = audio.play();
  if (playPromise) playPromise.catch(e => {
    setStatus(`Play blocked (${deck.toUpperCase()}): click ▶ to start`);
  });

  if (deck === DJ.currentDeck) broadcastNP(track);
}

async function onMetaLoaded(deck) {
  const audio = getDeckAudio(deck);
  const dur = audio.duration;
  const track = Engine.decks[deck].track;
  if (track && dur) track.duration = dur;

  // Update duration display
  document.getElementById(`dur-${deck}`).textContent = fmt(dur);

  // Smart fade analysis
  if (document.getElementById('smart-fade')?.checked && audio.src) {
    Engine.detectFadePoint(audio.src, dur).then(fp => {
      Engine.decks[deck].fadePoint = fp;
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
  if (deck === DJ.currentDeck) {
    setStatus(`Stream error — skipping to next track`);
    setTimeout(() => advanceQueue(), 1000);
  }
}

function onTrackEnded(deck) {
  if (deck !== DJ.currentDeck) return;
  advanceQueue();
}

function advanceQueue() {
  DJ.fadeLock = false;
  const justPlayed = DJ.queue[DJ.trackIndex];
  DJ.history.push(justPlayed);
  DJ.trackIndex++;

  // Mark as played in cache (triggers auto-cleanup of old cached files)
  if (justPlayed?.youtubeId) {
    fetch('/api/cache/played', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: justPlayed.youtubeId }) }).catch(() => {});
  }

  if (DJ.trackIndex >= DJ.queue.length) {
    setStatus('Queue ended — fetching more tracks...');
    fetchMoreOnline().then(() => {
      if (DJ.queue.length > DJ.trackIndex) {
        const nd = getNextDeck();
        DJ.currentDeck = nd;
        loadTrackOnDeck(nd, DJ.queue[DJ.trackIndex]);
        renderQueue();
      }
    });
    return;
  }

  const track = DJ.queue[DJ.trackIndex];
  const nextDeck = getNextDeck();
  DJ.currentDeck = nextDeck;
  loadTrackOnDeck(nextDeck, track);
  document.getElementById('deck-a').classList.toggle('live', nextDeck==='a');
  document.getElementById('deck-b').classList.toggle('live', nextDeck==='b');
  renderQueue();
  broadcastNP(track);

  // Keep queue topped up
  if (DJ.queue.length - DJ.trackIndex < 3) fetchMoreOnline();
  checkAutoCleanTemp();
}

// ─── Deck Controls ────────────────────────────────────────────────────────────
function deckPlay(deck) {
  if (!DJ.started) { startPlayback(); return; }
  Engine.initAudioCtx();
  Engine.ensureDeckConnected(deck);
  const audio = getDeckAudio(deck);
  if (!audio.src) { setStatus(`No track on Deck ${deck.toUpperCase()} — queue something first`); return; }
  audio.play().then(() => setStatus(`▶ Playing Deck ${deck.toUpperCase()}`))
    .catch(e => setStatus(`Play error: ${e.message} — click again`));
}
function deckPause(deck) { getDeckAudio(deck).pause(); }
function deckStop(deck) { const a = getDeckAudio(deck); a.pause(); a.currentTime = 0; }
function deckSkip(deck) { if (deck === DJ.currentDeck) triggerCrossfade(); }
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
function onXfader(val) {
  const v = parseFloat(val);
  if (Engine.decks.a.gain) Engine.decks.a.gain.gain.value = 1 - v;
  if (Engine.decks.b.gain) Engine.decks.b.gain.gain.value = v;
}

// ─── Auto-mix trigger (fixed — no re-entrant firing) ─────────────────────────
function updateDeckUI(deck) {
  const audio = getDeckAudio(deck);
  const cur = audio.currentTime || 0;
  const dur = audio.duration || 0;
  const remain = dur - cur;
  const pct = dur > 0 ? (cur / dur * 100) : 0;

  document.getElementById(`prog-${deck}`).style.width = pct + '%';
  document.getElementById(`time-${deck}`).textContent = fmt(cur);
  document.getElementById(`remain-${deck}`).textContent = remain > 0 ? '-' + fmt(remain) : '0:00';
  document.getElementById(`dur-${deck}`).textContent = fmt(dur);

  // Periodically broadcast elapsed for display page interpolation
  if (deck === DJ.currentDeck && Math.round(cur) % 5 === 0) {
    const track = Engine.decks[deck].track;
    if (track) Engine.broadcastNowPlaying({ nowPlaying: { ...track, elapsed: cur, duration: dur } });
  }

  // Auto-mix: fire once when remain enters the fade window
  if (!document.getElementById('automix')?.checked) return;
  if (deck !== DJ.currentDeck) return;
  if (Engine.isFading || DJ.fadeLock) return;
  if (dur < 5 || remain <= 0) return;

  const fadeSec = parseInt(document.getElementById('fade-dur')?.value) || 8;
  const fp = Engine.decks[deck].fadePoint;
  const triggerRemain = fp ? (dur - fp) : fadeSec;

  if (remain <= triggerRemain + 0.5 && remain > 0.5) {
    DJ.fadeLock = true; // prevent re-firing
    triggerCrossfade();
  }
}

// ─── Crossfade ────────────────────────────────────────────────────────────────
function triggerCrossfade() {
  if (Engine.isFading) return;

  const fromDeck = DJ.currentDeck;
  const toDeck = getNextDeck();
  const dur = parseInt(document.getElementById('fade-dur')?.value) || 8;
  const nextTrack = DJ.queue[DJ.trackIndex + 1];

  if (!nextTrack) {
    setStatus('Fetching next track...');
    fetchMoreOnline().then(() => {
      if (DJ.queue[DJ.trackIndex + 1]) triggerCrossfade();
    });
    return;
  }

  DJ.trackIndex++;
  DJ.fadeLock = false;

  // Load next track on staging deck
  loadTrackOnDeck(toDeck, nextTrack);

  document.getElementById('fade-btn').classList.add('fading');
  setStatus(`⇄ Crossfading → ${nextTrack.title}`);
  Engine.broadcastNowPlaying({ isFading: true });

  Engine.crossfade(fromDeck, toDeck, dur, () => {
    DJ.currentDeck = toDeck;
    document.getElementById('deck-a').classList.toggle('live', toDeck==='a');
    document.getElementById('deck-b').classList.toggle('live', toDeck==='b');
    document.getElementById('fade-btn').classList.remove('fading');
    setStatus(`▶ ${nextTrack.title} — ${nextTrack.artist}`);
    broadcastNP(nextTrack);
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
      const dur = audio?.duration || 1;
      const cur = audio?.currentTime || 0;
      if (canvases[deck]) Engine.drawWaveform(deck, canvases[deck], cur / dur);

      const levels = Engine.getVULevel(deck);
      const bars = document.getElementById(`vu-${deck}`)?.children || [];
      levels.forEach((lv, i) => { if (bars[i]) bars[i].style.height = Math.max(2, lv*30)+'px'; });
    });
    requestAnimationFrame(loop);
  };
  loop();
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
        <div class="q-title">${t.title}</div>
        <div class="q-artist">${t.artist}${t.album?' · '+t.album:''}</div>
        ${t.tags?.length ? `<div class="q-tags">${t.tags.slice(0,3).join(' · ')}</div>` : ''}
      </div>
      <span class="q-badge ${badgeClass}" ${badgeStyle}>${badgeText}</span>
      <div class="q-dur">${t.duration ? fmt(t.duration) : '—'}</div>
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
      const key = `${c.artist?.toLowerCase()}::${c.title?.toLowerCase()}`;
      return !DJ.usedTracks.has(key) && c.artist && c.title;
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
  const key = `${t.artist?.toLowerCase()}::${t.title?.toLowerCase()}`;
  if (DJ.usedTracks.has(key) || !t.artist || !t.title) return false;

  setStatus(`Searching: ${t.title} — ${t.artist}`);
  const result = await Engine.searchVideo(t.artist, t.title);
  if (!result || !result.videoId) { setStatus(`No source for: ${t.artist} — ${t.title}`); return false; }

  let info = { tags: [], album: '', image: '', duration: 0 };
  if (DJ.hasLastfm) { try { info = await Engine.getTrackInfo(t.artist, t.title); } catch(e) {} }
  DJ.usedTracks.add(key);

  const track = {
    type: 'online', youtubeId: result.videoId,
    _source: result._source || '', _instance: result._instance || '',
    title: t.title, artist: t.artist,
    album: info.album || '', tags: info.tags || [],
    duration: info.duration || t.duration || 0,
    image: info.image || '', artwork: info.image || ''
  };
  DJ.queue.push(track);
  if (!DJ.knownArtists.includes(t.artist)) DJ.knownArtists.push(t.artist);
  (info.tags||[]).forEach(tag => { if (!DJ.seedTags.includes(tag)) DJ.seedTags.push(tag); });
  renderQueue();
  return true;
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
  const next = DJ.queue[DJ.trackIndex+1];
  const audio = getDeckAudio(DJ.currentDeck);
  const genre = track.tags?.[0] || DJ.seedTags[0] || '';
  // Build stream URL for display page audio relay
  let streamUrl = '';
  if (track.type === 'local') streamUrl = track.url || '';
  else if (track.type === 'temp') streamUrl = track.url || '';
  // For online tracks, streamUrl is the Piped direct URL stored in track._streamUrl
  else if (track._streamUrl) streamUrl = '/api/piped/relay?url=' + encodeURIComponent(track._streamUrl);

  await Engine.broadcastNowPlaying({
    nowPlaying: {
      title: track.title, artist: track.artist, album: track.album,
      duration: track.duration || audio?.duration || 0,
      elapsed: audio?.currentTime || 0,
      fadePoint: Engine.decks[DJ.currentDeck].fadePoint,
      tags: track.tags, artwork: track.artwork || track.image || '',
      streamUrl
    },
    nextUp: next ? { title: next.title, artist: next.artist, artwork: next.artwork||next.image||'' } : null,
    genre: genre ? genre.charAt(0).toUpperCase()+genre.slice(1) : '',
    isPlaying: true, messages: DJ.messages
  });
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
    const setW = (id, pct) => { const e=document.getElementById(id); if(e) e.style.width=pct+'%'; };
    const warn = (id, cond) => { const e=document.getElementById(id); if(e) e.className='stat-value'+(cond?' stat-warn':''); };

    set('stat-cpu', s.cpu.percent+'%'); warn('stat-cpu', s.cpu.percent>85);
    set('stat-cpu-sub', `${s.cpu.cores} cores · ${s.cpu.model.substring(0,24)}`);
    setW('stat-cpu-bar', s.cpu.percent);

    set('stat-ram', s.ram.percent+'%'); warn('stat-ram', s.ram.percent>85);
    set('stat-ram-sub', `${fmtBytes(s.ram.used)} / ${fmtBytes(s.ram.total)}`);
    setW('stat-ram-bar', s.ram.percent);

    set('stat-disk', s.disk.percent+'%'); warn('stat-disk', s.disk.percent>90);
    set('stat-disk-sub', `${fmtBytes(s.disk.free)} free of ${fmtBytes(s.disk.total)}`);
    setW('stat-disk-bar', s.disk.percent);

    set('stat-temp', s.temp.files);
    set('stat-temp-sub', `${fmtBytes(s.temp.size)} · up ${fmtUptime(s.uptime)}`);
    setW('stat-temp-bar', s.temp.files>0?100:5);
  } catch(e) {}
}
setInterval(updateSystemStats, 3000);
updateSystemStats();

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
function removeMessage(i) { DJ.messages.splice(i,1); renderMessages(); }

// ─── Drop Zone ────────────────────────────────────────────────────────────────
function setupDropZone() {
  const dz = document.getElementById('drop-zone');
  if (!dz) return;
  dz.addEventListener('dragenter', e=>{e.preventDefault();dz.classList.add('drag-over');});
  dz.addEventListener('dragover', e=>e.preventDefault());
  dz.addEventListener('dragleave', ()=>dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e=>{e.preventDefault();dz.classList.remove('drag-over');addLocalFiles(e.dataTransfer.files);});
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(s) {
  if (!s || isNaN(s) || s < 0) return '0:00';
  return `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`;
}
function setStatus(msg) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
  console.log('[AutoDJ]', msg);
}
