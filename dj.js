/**
 * AutoDJ DJ Console — UI Logic
 */

// ─── State ────────────────────────────────────────────────────────────────────
const DJ = {
  queue: [],
  history: [],
  trackIndex: -1,
  currentDeck: 'a',
  usedTracks: new Set(),
  seedTags: [],
  knownArtists: [],
  localFiles: [],       // { file, url, title, artist, duration, type:'local' }
  ytPlayers: {},
  ytReady: false,
  animFrame: null,
  messages: []
};

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initAudioElements();
  loadConfig();
  startClock();
  startRenderLoop();
  setupDropZone();
  setStatus('Ready — configure settings and start a mix');
});

function initAudioElements() {
  const aa = document.getElementById('audio-a');
  const ab = document.getElementById('audio-b');
  Engine.setupDeckAudio('a', aa);
  Engine.setupDeckAudio('b', ab);

  aa.addEventListener('ended', () => onTrackEnded('a'));
  ab.addEventListener('ended', () => onTrackEnded('b'));
  aa.addEventListener('timeupdate', () => updateDeckUI('a'));
  ab.addEventListener('timeupdate', () => updateDeckUI('b'));
  aa.addEventListener('loadedmetadata', () => onMetaLoaded('a'));
  ab.addEventListener('loadedmetadata', () => onMetaLoaded('b'));
}

// ─── Clock ─────────────────────────────────────────────────────────────────────
function startClock() {
  const el = document.getElementById('clock');
  const tick = () => { el.textContent = new Date().toLocaleTimeString('en-US', { hour12: false }); };
  setInterval(tick, 1000); tick();
}

// ─── Config ────────────────────────────────────────────────────────────────────
async function loadConfig() {
  try {
    const r = await fetch('/api/config');
    const cfg = await r.json();
    if (cfg.lastfmKey) document.getElementById('cfg-lastfm').placeholder = '●●● configured ●●●';
    if (cfg.spotifyClientId) document.getElementById('cfg-sp-id').value = cfg.spotifyClientId;
    if (cfg.anthropicKey) document.getElementById('cfg-anthropic').placeholder = '●●● configured ●●●';
    if (cfg.openaiKey) document.getElementById('cfg-openai').placeholder = '●●● configured ●●●';
    document.getElementById('cfg-ai-provider').value = cfg.aiProvider || 'anthropic';
    if (cfg.musicDirs) document.getElementById('cfg-dirs').value = cfg.musicDirs.join('\n');
    if (cfg.messages) {
      DJ.messages = cfg.messages;
      renderMessages();
    }
  } catch(e) {}
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
  await fetch('/api/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  setStatus('Configuration saved');
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.textContent.toLowerCase().includes(name)));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${name}`));
}

// ─── Local Files ──────────────────────────────────────────────────────────────
function addLocalFiles(fileList) {
  let added = 0;
  for (const file of fileList) {
    if (!file.type.startsWith('audio/') && !file.name.match(/\.(mp3|flac|wav|ogg|m4a|aac|opus)$/i)) continue;
    const url = URL.createObjectURL(file);
    const parts = file.name.replace(/\.[^.]+$/, '').split(' - ');
    const track = {
      type: 'local',
      file, url,
      title: parts.length >= 2 ? parts.slice(1).join(' - ') : file.name.replace(/\.[^.]+$/, ''),
      artist: parts.length >= 2 ? parts[0] : 'Unknown',
      album: '',
      duration: 0,
      tags: [],
      youtubeId: null,
      filepath: file.name
    };
    DJ.localFiles.push(track);
    added++;
  }
  renderLocalFiles();
  setStatus(`Added ${added} local files`);
}

function renderLocalFiles() {
  const list = document.getElementById('local-file-list');
  if (DJ.localFiles.length === 0) {
    list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted);font-size:11px">No files loaded</div>';
    return;
  }
  list.innerHTML = DJ.localFiles.map((f, i) => `
    <div class="local-file">
      <div style="flex:1;overflow:hidden">
        <div class="local-file-name">${f.title}</div>
        <div style="font-size:9px;color:var(--muted)">${f.artist}</div>
      </div>
      <div class="local-file-meta">${f.duration ? fmt(f.duration) : '—'}</div>
      <button class="btn" style="padding:4px 10px;font-size:9px;margin-left:6px" onclick="addSingleToQueue(${i})">+ Queue</button>
      <button class="ctrl-btn" style="margin-left:4px;padding:4px 8px;font-size:10px" onclick="playLocalNow(${i})">▶</button>
    </div>
  `).join('');
}

function addSingleToQueue(localIdx) {
  const t = { ...DJ.localFiles[localIdx] };
  DJ.queue.push(t);
  renderQueue();
  setStatus(`Queued: ${t.title}`);
}

function playLocalNow(localIdx) {
  const t = { ...DJ.localFiles[localIdx] };
  DJ.queue.splice(DJ.trackIndex + 1, 0, t);
  triggerCrossfade();
}

function addAllToQueue() {
  const mode = document.getElementById('queue-mode')?.value || 'local-first';
  let toAdd = DJ.localFiles.map(f => ({...f}));
  if (mode === 'shuffle-mix') toAdd = toAdd.sort(() => Math.random() - 0.5);
  DJ.queue.push(...toAdd);
  renderQueue();
  setStatus(`Added ${toAdd.length} local tracks to queue`);
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
    setStatus(`Found ${files.length} tracks in library`);
  } catch(e) { setStatus('Library scan failed: ' + e.message); }
}

// ─── Queue ────────────────────────────────────────────────────────────────────
function renderQueue() {
  const list = document.getElementById('queue-list');
  document.getElementById('q-count').textContent = DJ.queue.length;

  if (DJ.queue.length === 0) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:11px">Queue empty</div>';
    return;
  }

  list.innerHTML = DJ.queue.map((t, i) => {
    const isPlay = i === DJ.trackIndex;
    const isNext = i === DJ.trackIndex + 1;
    const isPast = i < DJ.trackIndex;
    const src = t.type === 'local' ? 'LOCAL' : t.type === 'temp' ? 'TEMP' : 'ONLINE';
    const badge = isPlay ? '<span class="q-badge badge-play">▶ NOW</span>' :
                  isNext ? '<span class="q-badge badge-next">NEXT</span>' :
                  t.type === 'local' ? '<span class="q-badge badge-loc">LOCAL</span>' :
                  t.type === 'temp' ? '<span class="q-badge" style="background:rgba(255,204,0,0.15);color:#ffcc00">TEMP</span>' :
                  '<span class="q-badge badge-q">AUTO</span>';

    return `<div class="qitem ${isPlay?'playing':''} ${isNext?'next':''} ${isPast?'past':''} ${t.type}"
      draggable="${!isPlay}" 
      data-idx="${i}"
      ondragstart="onDragStart(event,${i})"
      ondragover="onDragOver(event)"
      ondrop="onDrop(event,${i})"
      ondragleave="onDragLeave(event)">
      <div class="q-num">${i+1}</div>
      <div class="q-src">${src}</div>
      <div class="q-info">
        <div class="q-title">${t.title}</div>
        <div class="q-artist">${t.artist}${t.album ? ' · ' + t.album : ''}</div>
        ${t.tags?.length ? `<div class="q-tags">${t.tags.slice(0,3).join(' · ')}</div>` : ''}
      </div>
      ${badge}
      <div class="q-dur">${t.duration ? fmt(t.duration) : '—'}</div>
      <button class="q-remove" onclick="removeFromQueue(${i})">×</button>
    </div>`;
  }).join('');

  // Scroll current into view
  list.querySelector('.playing')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  // Update sidebars
  const np = DJ.queue[DJ.trackIndex];
  const nu = DJ.queue[DJ.trackIndex + 1];
  if (np) {
    document.getElementById('np-sidebar-title').textContent = np.title;
    document.getElementById('np-sidebar-artist').textContent = np.artist;
    document.getElementById('np-sidebar-genre').textContent = np.tags?.slice(0,2).join(', ') || '—';
  }
}

// Drag-to-reorder
let dragIdx = null;
function onDragStart(e, idx) { dragIdx = idx; e.currentTarget.classList.add('dragging'); }
function onDragOver(e) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function onDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function onDrop(e, targetIdx) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  if (dragIdx === null || dragIdx === targetIdx) return;
  const item = DJ.queue.splice(dragIdx, 1)[0];
  DJ.queue.splice(targetIdx, 0, item);
  if (dragIdx < DJ.trackIndex) DJ.trackIndex--;
  else if (targetIdx <= DJ.trackIndex) DJ.trackIndex++;
  dragIdx = null;
  renderQueue();
}

function removeFromQueue(idx) {
  if (idx === DJ.trackIndex) return; // can't remove now playing
  DJ.queue.splice(idx, 1);
  if (idx < DJ.trackIndex) DJ.trackIndex--;
  renderQueue();
}

function shuffleQueue() {
  const past = DJ.queue.slice(0, DJ.trackIndex + 1);
  const future = DJ.queue.slice(DJ.trackIndex + 1).sort(() => Math.random() - 0.5);
  DJ.queue = [...past, ...future];
  renderQueue();
  setStatus('Queue shuffled');
}

function clearQueue() {
  const hasTempFiles = DJ.queue.slice(DJ.trackIndex + 1).some(t => t.type === 'temp');
  DJ.queue = DJ.queue.slice(0, DJ.trackIndex + 1);
  if (hasTempFiles) {
    fetch('/api/temp/clear', { method: 'DELETE' }).catch(() => {});
    tempFileRegistry = [];
    renderTempFiles();
    setStatus('Queue cleared + temp files deleted');
  } else {
    setStatus('Queue cleared');
  }
  renderQueue();
}

// ─── Playback ─────────────────────────────────────────────────────────────────
function getDeckAudio(deck) { return document.getElementById(`audio-${deck}`); }
function getNextDeck(deck) { return deck === 'a' ? 'b' : 'a'; }

async function playTrackOnDeck(deck, track) {
  const audio = getDeckAudio(deck);
  Engine.decks[deck].track = track;
  Engine.decks[deck].cuePoint = 0;
  Engine.decks[deck].fadePoint = null;

  // Setup audio
  if (track.type === 'local' && track.url) {
    audio.src = track.url;
  } else if (track.youtubeId) {
    // Use a YouTube embed for online tracks
    loadYouTubeDeck(deck, track.youtubeId);
    return;
  } else {
    setStatus(`No audio source for: ${track.title}`);
    setTimeout(() => advanceQueue(), 2000);
    return;
  }

  audio.load();
  audio.play().catch(e => setStatus('Playback error: ' + e.message));

  // Update deck UI
  document.getElementById(`title-${deck}`).textContent = track.title;
  document.getElementById(`artist-${deck}`).textContent = track.artist;
  document.getElementById(`album-${deck}`).textContent = track.album || '';
  document.getElementById(`tags-${deck}`).textContent = track.tags?.slice(0,4).join(' · ') || '';

  if (deck === DJ.currentDeck) {
    document.getElementById('deck-a').classList.toggle('live', deck === 'a');
    document.getElementById('deck-b').classList.toggle('live', deck === 'b');
    broadcastNP(track);
  }
}

async function onMetaLoaded(deck) {
  const audio = getDeckAudio(deck);
  const dur = audio.duration;
  Engine.decks[deck].track && (Engine.decks[deck].track.duration = dur);

  // Run analysis
  if (document.getElementById('smart-fade')?.checked) {
    setStatus(`Analyzing fade point for deck ${deck.toUpperCase()}...`);
    const fp = await Engine.detectFadePoint(audio);
    Engine.decks[deck].fadePoint = fp;
    setStatus(`Deck ${deck.toUpperCase()} ready — fade point: ${fmt(fp)}`);
  }

  const bpm = await Engine.analyzeBPM(audio);
  if (bpm) {
    Engine.decks[deck].bpm = bpm;
    document.getElementById(`bpm-${deck}`).textContent = bpm;
  }
}

function onTrackEnded(deck) {
  if (deck !== DJ.currentDeck) return;
  advanceQueue();
}

function advanceQueue() {
  DJ.trackIndex++;
  if (DJ.trackIndex >= DJ.queue.length) {
    setStatus('Queue ended — fetching more...');
    fetchMoreOnline().then(() => {
      if (DJ.queue.length > DJ.trackIndex) {
        const nextDeck = getNextDeck(DJ.currentDeck);
        playTrackOnDeck(nextDeck, DJ.queue[DJ.trackIndex]);
        DJ.currentDeck = nextDeck;
        renderQueue();
      }
    });
    return;
  }
  const track = DJ.queue[DJ.trackIndex];
  const nextDeck = getNextDeck(DJ.currentDeck);
  playTrackOnDeck(nextDeck, track);
  DJ.currentDeck = nextDeck;
  document.getElementById('deck-a').classList.toggle('live', DJ.currentDeck === 'a');
  document.getElementById('deck-b').classList.toggle('live', DJ.currentDeck === 'b');
  renderQueue();
  broadcastNP(track);

  if (DJ.queue.length - DJ.trackIndex < 3) fetchMoreOnline();
  checkAutoCleanTemp();
}

// ─── Deck Controls ────────────────────────────────────────────────────────────
function deckPlay(deck) {
  Engine.initAudioCtx();
  const audio = getDeckAudio(deck);
  audio.play().catch(() => {});
  Engine.decks[deck].gain.gain.value = deck === DJ.currentDeck ? 1 : 0;
}

function deckPause(deck) { getDeckAudio(deck).pause(); }
function deckStop(deck) { const a = getDeckAudio(deck); a.pause(); a.currentTime = 0; }
function deckSkip(deck) { if (deck === DJ.currentDeck) triggerCrossfade(); }
function setCue(deck) {
  const audio = getDeckAudio(deck);
  Engine.decks[deck].cuePoint = audio.currentTime;
  setStatus(`Cue set on deck ${deck.toUpperCase()} at ${fmt(audio.currentTime)}`);
}

function seekDeck(deck, event) {
  const audio = getDeckAudio(deck);
  if (!audio.duration) return;
  const rect = document.getElementById(`prog-wrap-${deck}`).getBoundingClientRect();
  const pct = (event.clientX - rect.left) / rect.width;
  audio.currentTime = pct * audio.duration;
}

function setVol(deck, val) {
  Engine.decks[deck].gain.gain.value = parseFloat(val);
  document.getElementById(`vol-val-${deck}`).textContent = Math.round(val * 100) + '%';
}

// ─── Crossfade Control ────────────────────────────────────────────────────────
function triggerCrossfade() {
  if (Engine.isFading) return;
  const fromDeck = DJ.currentDeck;
  const toDeck = getNextDeck(fromDeck);
  const dur = parseInt(document.getElementById('fade-dur').value) || 8;

  // Pre-load next track on the other deck if needed
  const nextTrack = DJ.queue[DJ.trackIndex + 1];
  if (!nextTrack) {
    setStatus('No next track — fetching...');
    fetchMoreOnline().then(() => triggerCrossfade());
    return;
  }

  // Load onto the next deck
  DJ.trackIndex++;
  playTrackOnDeck(toDeck, nextTrack);

  document.getElementById('fade-btn').classList.add('fading');
  setStatus(`Crossfading: ${fromDeck.toUpperCase()} → ${toDeck.toUpperCase()} (${dur}s)`);

  Engine.crossfade(fromDeck, toDeck, dur, () => {
    DJ.currentDeck = toDeck;
    document.getElementById('deck-a').classList.toggle('live', toDeck === 'a');
    document.getElementById('deck-b').classList.toggle('live', toDeck === 'b');
    document.getElementById('fade-btn').classList.remove('fading');
    setStatus(`Now on deck ${toDeck.toUpperCase()}: ${nextTrack.title}`);
    broadcastNP(nextTrack);
    renderQueue();
    if (DJ.queue.length - DJ.trackIndex < 3) fetchMoreOnline();
  });

  // Broadcast fading state
  Engine.broadcastNowPlaying({ isFading: true });
  setTimeout(() => Engine.broadcastNowPlaying({ isFading: false }), dur * 1000);
}

function onXfader(val) {
  const aVol = 1 - parseFloat(val);
  const bVol = parseFloat(val);
  if (Engine.decks.a.gain) Engine.decks.a.gain.gain.value = aVol;
  if (Engine.decks.b.gain) Engine.decks.b.gain.gain.value = bVol;
}

// ─── Deck UI Update ──────────────────────────────────────────────────────────
function updateDeckUI(deck) {
  const audio = getDeckAudio(deck);
  const cur = audio.currentTime || 0;
  const dur = audio.duration || 0;
  const pct = dur > 0 ? (cur / dur * 100) : 0;
  const remain = dur - cur;

  document.getElementById(`prog-${deck}`).style.width = pct + '%';
  document.getElementById(`time-${deck}`).textContent = fmt(cur);
  document.getElementById(`remain-${deck}`).textContent = '-' + fmt(remain);
  document.getElementById(`dur-${deck}`).textContent = fmt(dur);

  // Auto-mix trigger
  if (document.getElementById('automix')?.checked && deck === DJ.currentDeck && !Engine.isFading) {
    const fadeSec = parseInt(document.getElementById('fade-dur').value) || 8;
    const fp = Engine.decks[deck].fadePoint;
    const triggerAt = fp || (dur - fadeSec);
    if (dur > 0 && remain <= (dur - triggerAt) && remain > 0 && remain < fadeSec + 2) {
      triggerCrossfade();
    }
  }
}

// ─── Render Loop ──────────────────────────────────────────────────────────────
function startRenderLoop() {
  const canvases = { a: document.getElementById('wave-a'), b: document.getElementById('wave-b') };
  Object.values(canvases).forEach(c => { c.width = c.offsetWidth; });

  const loop = () => {
    ['a', 'b'].forEach(deck => {
      const audio = getDeckAudio(deck);
      const dur = audio?.duration || 1;
      const cur = audio?.currentTime || 0;
      Engine.drawWaveform(deck, canvases[deck], cur / dur);

      // VU meters
      const levels = Engine.getVULevel(deck);
      const bars = document.getElementById(`vu-${deck}`)?.children || [];
      levels.forEach((lv, i) => {
        if (bars[i]) bars[i].style.height = Math.max(2, lv * 32) + 'px';
      });
    });
    DJ.animFrame = requestAnimationFrame(loop);
  };
  loop();
}

// ─── Discovery ────────────────────────────────────────────────────────────────
async function startAutoDiscover() {
  const artist = document.getElementById('seed-artist').value.trim();
  const track = document.getElementById('seed-track').value.trim();

  if (!artist) { setStatus('Enter a seed artist'); return; }

  setStatus('Starting discovery...');
  DJ.knownArtists = [artist];
  DJ.usedTracks.clear();
  DJ.seedTags = [];

  // Get tags
  if (track) {
    const info = await Engine.getTrackInfo(artist, track);
    DJ.seedTags = info.tags;
  } else {
    const info = await Engine.getArtistInfo(artist);
    DJ.seedTags = info.tags;
  }
  setStatus(`Genre tags: ${DJ.seedTags.slice(0,3).join(', ')}`);

  // Get seed tracks
  let seeds = track ? [{ title: track, artist }] : [];
  const tops = await Engine.getTopTracks(artist, 3);
  seeds.push(...tops);

  for (const t of seeds.slice(0, 3)) {
    await enqueueOnlineTrack(t);
  }

  if (DJ.trackIndex < 0 && DJ.queue.length > 0) {
    DJ.trackIndex = 0;
    playTrackOnDeck(DJ.currentDeck, DJ.queue[0]);
    renderQueue();
  }

  setTimeout(() => fetchMoreOnline(), 3000);
}

async function fetchMoreOnline() {
  const mode = document.getElementById('discovery-mode')?.value || 'both';
  const needed = 4;
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

    // Similar to current
    const cur = DJ.queue[DJ.trackIndex];
    if (cur) {
      const sim = await Engine.getSimilarTracks(cur.artist, cur.title, 5);
      candidates.push(...sim);
    }

    candidates = candidates.filter(c => {
      const key = `${c.artist?.toLowerCase()}::${c.title?.toLowerCase()}`;
      return !DJ.usedTracks.has(key) && c.artist && c.title;
    });
    candidates = candidates.sort(() => Math.random() - 0.5);

    let added = 0;
    for (const t of candidates) {
      if (added >= needed) break;
      await enqueueOnlineTrack(t);
      added++;
    }

    if (added > 0) renderQueue();
  } catch(e) { setStatus('Discovery error: ' + e.message); }
}

async function enqueueOnlineTrack(t) {
  const key = `${t.artist?.toLowerCase()}::${t.title?.toLowerCase()}`;
  if (DJ.usedTracks.has(key) || !t.artist || !t.title) return;

  setStatus(`Finding: ${t.title} — ${t.artist}`);
  const ytId = await Engine.findYouTubeId(t.artist, t.title);
  if (!ytId) return;

  // Get extra info
  const info = await Engine.getTrackInfo(t.artist, t.title);

  DJ.usedTracks.add(key);
  const track = {
    type: 'online', youtubeId: ytId,
    title: t.title, artist: t.artist,
    album: info.album || '', tags: info.tags,
    duration: info.duration || t.duration || 0
  };
  DJ.queue.push(track);
  if (!DJ.knownArtists.includes(t.artist)) DJ.knownArtists.push(t.artist);
  if (info.tags) info.tags.forEach(tag => { if (!DJ.seedTags.includes(tag)) DJ.seedTags.push(tag); });
  renderQueue();
}

// ─── YouTube for Online Tracks ────────────────────────────────────────────────
let ytPlayersInited = false;

window.onYouTubeIframeAPIReady = function() {
  DJ.ytReady = true;
};

function loadYouTubeDeck(deck, videoId) {
  // For online tracks we use a hidden iframe and route audio through the audio element
  // Since we can't directly capture YT audio to WebAudio, we load it in a player
  // and show visual feedback. The crossfade is handled via YT player volume.
  const containerId = `yt-${deck}`;

  if (DJ.ytPlayers[deck]) {
    DJ.ytPlayers[deck].loadVideoById(videoId);
    return;
  }

  if (!DJ.ytReady) {
    setTimeout(() => loadYouTubeDeck(deck, videoId), 500);
    return;
  }

  DJ.ytPlayers[deck] = new YT.Player(containerId, {
    height: '1', width: '1',
    playerVars: { autoplay: 1, controls: 0, rel: 0 },
    videoId,
    events: {
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED && deck === DJ.currentDeck) advanceQueue();
      },
      onReady: (e) => {
        e.target.playVideo();
        // Set initial volume based on which deck is live
        e.target.setVolume(deck === DJ.currentDeck ? 100 : 0);
      }
    }
  });

  // Simulate timeupdate for YT tracks
  const t = DJ.queue.find(q => q.youtubeId === videoId);
  if (t && t.duration) simulateYTProgress(deck, t.duration);
}

function simulateYTProgress(deck, duration) {
  if (!duration) return;
  let elapsed = 0;
  const iv = setInterval(() => {
    if (!DJ.ytPlayers[deck]) { clearInterval(iv); return; }
    elapsed += 0.5;
    if (elapsed > duration) { clearInterval(iv); return; }

    const pct = (elapsed / duration) * 100;
    const remain = duration - elapsed;
    document.getElementById(`prog-${deck}`).style.width = pct + '%';
    document.getElementById(`time-${deck}`).textContent = fmt(elapsed);
    document.getElementById(`remain-${deck}`).textContent = '-' + fmt(remain);
    document.getElementById(`dur-${deck}`).textContent = fmt(duration);

    if (document.getElementById('automix')?.checked && deck === DJ.currentDeck && !Engine.isFading) {
      const fadeSec = parseInt(document.getElementById('fade-dur').value) || 8;
      if (remain <= fadeSec + 1 && remain > 0) triggerCrossfade();
    }
  }, 500);
}

// Override crossfade for YT players
const _origXfade = Engine.crossfade.bind(Engine);
// Wrap crossfade to handle YT players
function triggerCrossfade() {
  if (Engine.isFading) return;
  const fromDeck = DJ.currentDeck;
  const toDeck = getNextDeck(fromDeck);
  const dur = parseInt(document.getElementById('fade-dur').value) || 8;

  const nextTrack = DJ.queue[DJ.trackIndex + 1];
  if (!nextTrack) {
    setStatus('No next track — fetching...');
    fetchMoreOnline().then(() => { if (DJ.queue[DJ.trackIndex+1]) triggerCrossfade(); });
    return;
  }

  DJ.trackIndex++;

  const isFromYT = !!DJ.ytPlayers[fromDeck];
  const willBeYT = nextTrack.type === 'online';

  playTrackOnDeck(toDeck, nextTrack);

  document.getElementById('fade-btn').classList.add('fading');
  setStatus(`Crossfading → ${nextTrack.title}`);

  const steps = dur * 20;
  let step = 0;
  const iv = setInterval(() => {
    step++;
    const t = step / steps;
    const ease = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
    const fromVol = 1 - ease;
    const toVol = ease;

    // Local audio
    if (Engine.decks[fromDeck].gain) Engine.decks[fromDeck].gain.gain.value = fromVol;
    if (Engine.decks[toDeck].gain) Engine.decks[toDeck].gain.gain.value = toVol;

    // YT players
    if (DJ.ytPlayers[fromDeck]) try { DJ.ytPlayers[fromDeck].setVolume(fromVol * 100); } catch(e) {}
    if (DJ.ytPlayers[toDeck]) try { DJ.ytPlayers[toDeck].setVolume(toVol * 100); } catch(e) {}

    const xf = document.getElementById('crossfader');
    if (xf) xf.value = fromDeck === 'a' ? ease : 1 - ease;

    if (step >= steps) {
      clearInterval(iv);
      DJ.currentDeck = toDeck;
      document.getElementById('deck-a').classList.toggle('live', toDeck === 'a');
      document.getElementById('deck-b').classList.toggle('live', toDeck === 'b');
      document.getElementById('fade-btn').classList.remove('fading');

      if (DJ.ytPlayers[fromDeck]) try { DJ.ytPlayers[fromDeck].stopVideo(); } catch(e) {}
      if (Engine.decks[fromDeck].audio) Engine.decks[fromDeck].audio.pause();

      setStatus(`▶ ${nextTrack.title} — ${nextTrack.artist}`);
      broadcastNP(nextTrack);
      renderQueue();
      Engine.broadcastNowPlaying({ isFading: false });
      if (DJ.queue.length - DJ.trackIndex < 3) fetchMoreOnline();
    }
  }, 50);

  Engine.broadcastNowPlaying({ isFading: true });
}

// ─── Spotify ──────────────────────────────────────────────────────────────────
async function spotifySearch() {
  const q = document.getElementById('spotify-search').value.trim();
  const type = document.getElementById('spotify-type').value;
  const div = document.getElementById('spotify-results');

  if (!q) return;
  div.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:8px">Searching...</div>';

  try {
    let tracks = [];
    if (type === 'track') {
      const r = await fetch(`/api/spotify/search?q=${encodeURIComponent(q)}&type=track&limit=5`);
      const data = await r.json();
      tracks = (data.tracks?.items || []).map(t => ({
        title: t.name,
        artist: t.artists?.[0]?.name || '',
        album: t.album?.name || '',
        duration: Math.round(t.duration_ms / 1000),
        image: t.album?.images?.[0]?.url || '',
        tags: []
      }));
    } else if (type === 'artist') {
      const r = await fetch(`/api/spotify/search?q=${encodeURIComponent(q)}&type=artist&limit=1`);
      const data = await r.json();
      const artistId = data.artists?.items?.[0]?.id;
      if (artistId) {
        const r2 = await fetch(`/api/spotify/artists/${artistId}/top-tracks?market=US`);
        const data2 = await r2.json();
        tracks = (data2.tracks || []).slice(0, 5).map(t => ({
          title: t.name, artist: q,
          album: t.album?.name || '', duration: Math.round(t.duration_ms / 1000),
          image: t.album?.images?.[0]?.url || '', tags: []
        }));
      }
    } else if (type === 'recommendations') {
      const cur = DJ.queue[DJ.trackIndex];
      let seedUrl = `/api/spotify/search?q=${encodeURIComponent(q)}&type=track&limit=1`;
      const sr = await fetch(seedUrl);
      const sd = await sr.json();
      const seedId = sd.tracks?.items?.[0]?.id;
      if (seedId) {
        const rr = await fetch(`/api/spotify/recommendations?seed_tracks=${seedId}&limit=8`);
        const rd = await rr.json();
        tracks = (rd.tracks || []).map(t => ({
          title: t.name, artist: t.artists?.[0]?.name || '',
          album: t.album?.name || '', duration: Math.round(t.duration_ms / 1000),
          image: t.album?.images?.[0]?.url || '', tags: []
        }));
      }
    }

    div.innerHTML = tracks.map((t, i) => `
      <div class="spotify-result">
        ${t.image ? `<img class="sp-img" src="${t.image}" alt="">` : '<div class="sp-img" style="background:var(--border)"></div>'}
        <div class="sp-info">
          <div class="sp-name">${t.title}</div>
          <div class="sp-artist">${t.artist}${t.album ? ' · ' + t.album : ''}</div>
        </div>
        <button class="btn" style="padding:4px 10px;font-size:9px" onclick="addSpotifyTrack(${i}, ${JSON.stringify(tracks).replace(/"/g,'&quot;')})">+ Queue</button>
      </div>
    `).join('');

    if (tracks.length === 0) div.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:8px">No results (check Spotify credentials)</div>';
  } catch(e) {
    div.innerHTML = `<div style="color:var(--accent2);font-size:11px;padding:8px">Error: ${e.message}</div>`;
  }
}

async function addSpotifyTrack(idx, tracks) {
  const t = tracks[idx];
  setStatus(`Finding "${t.title}" on YouTube...`);
  const ytId = await Engine.findYouTubeId(t.artist, t.title);
  if (ytId) {
    DJ.queue.push({ ...t, type: 'online', youtubeId: ytId });
    renderQueue();
    setStatus(`Queued: ${t.title}`);
  } else {
    setStatus(`Could not find "${t.title}" on YouTube`);
  }
}

// ─── AI ───────────────────────────────────────────────────────────────────────
async function aiAnalyzeAndRecommend() {
  const mood = document.getElementById('ai-mood').value;
  const el = document.getElementById('ai-result');
  el.innerHTML = '<span style="color:var(--muted)">Asking AI...</span>';

  try {
    const cur = DJ.queue[DJ.trackIndex];
    const recs = await Engine.aiRecommend(cur, DJ.history, DJ.seedTags, mood);
    el.innerHTML = recs.map(r =>
      `<div style="margin-bottom:8px;border-bottom:1px solid var(--border);padding-bottom:6px">
        <div style="color:var(--bright)">${r.title} — ${r.artist}</div>
        <div style="color:var(--accent3);font-size:10px">${r.reason}</div>
        <button class="btn" style="padding:3px 8px;font-size:9px;margin-top:4px" onclick="enqueueAITrack('${r.artist.replace(/'/g,"\\'")}','${r.title.replace(/'/g,"\\'")}')">+ Queue</button>
      </div>`
    ).join('');
  } catch(e) {
    el.innerHTML = `<span style="color:var(--accent2)">AI error: ${e.message} — check your API key in Settings</span>`;
  }
}

async function enqueueAITrack(artist, title) {
  setStatus(`Finding AI recommendation: ${title}...`);
  const ytId = await Engine.findYouTubeId(artist, title);
  if (ytId) {
    DJ.queue.push({ type: 'online', youtubeId: ytId, title, artist, tags: DJ.seedTags.slice(0, 3) });
    renderQueue();
    setStatus(`Queued: ${title} — ${artist}`);
  } else {
    setStatus(`Not found on YouTube: ${title}`);
  }
}

async function aiRefillQueue() {
  setStatus('AI is analyzing queue and refilling...');
  const mood = document.getElementById('ai-mood')?.value || '';
  try {
    const cur = DJ.queue[DJ.trackIndex];
    const recs = await Engine.aiRecommend(cur, DJ.history, DJ.seedTags, mood);
    let added = 0;
    for (const r of recs) {
      const ytId = await Engine.findYouTubeId(r.artist, r.title);
      if (ytId) {
        DJ.queue.push({ type: 'online', youtubeId: ytId, title: r.title, artist: r.artist, tags: [] });
        added++;
      }
    }
    renderQueue();
    setStatus(`AI added ${added} tracks to queue`);
  } catch(e) { setStatus('AI refill failed: ' + e.message); }
}

// ─── Now Playing Broadcast ────────────────────────────────────────────────────
async function broadcastNP(track) {
  const next = DJ.queue[DJ.trackIndex + 1];
  const audio = getDeckAudio(DJ.currentDeck);
  const genre = track.tags?.[0] || DJ.seedTags[0] || '';

  await Engine.broadcastNowPlaying({
    nowPlaying: {
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration || audio?.duration || 0,
      elapsed: audio?.currentTime || 0,
      fadePoint: Engine.decks[DJ.currentDeck].fadePoint,
      tags: track.tags
    },
    nextUp: next ? { title: next.title, artist: next.artist } : null,
    genre: genre.charAt(0).toUpperCase() + genre.slice(1),
    isPlaying: true,
    messages: DJ.messages
  });
}

// ─── Messages ─────────────────────────────────────────────────────────────────
function renderMessages() {
  const list = document.getElementById('msg-list');
  list.innerHTML = DJ.messages.map((m, i) => `
    <div class="msg-item">
      <span>${m}</span>
      <button class="msg-del" onclick="removeMessage(${i})">×</button>
    </div>
  `).join('');
}

function addMessage() {
  const inp = document.getElementById('new-msg');
  const val = inp.value.trim();
  if (!val) return;
  DJ.messages.push(val);
  inp.value = '';
  renderMessages();
  Engine.broadcastNowPlaying({ messages: DJ.messages });
}

function removeMessage(idx) {
  DJ.messages.splice(idx, 1);
  renderMessages();
}

// ─── Drop Zone ────────────────────────────────────────────────────────────────
function setupDropZone() {
  const dz = document.getElementById('drop-zone');
  if (!dz) return;
  dz.addEventListener('dragenter', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragover', e => { e.preventDefault(); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('drag-over');
    addLocalFiles(e.dataTransfer.files);
  });
}

// ─── Temp Upload ──────────────────────────────────────────────────────────────
let tempFileRegistry = []; // Track temp files client-side too

async function uploadTempFiles(fileList) {
  if (!fileList || fileList.length === 0) return;

  const statusEl = document.getElementById('temp-status');
  statusEl.style.display = 'block';
  statusEl.textContent = `Uploading ${fileList.length} file(s)...`;

  const formData = new FormData();
  let count = 0;
  for (const file of fileList) {
    if (file.type.startsWith('audio/') || file.name.match(/\.(mp3|flac|wav|ogg|m4a|aac|opus|wma)$/i)) {
      formData.append('files', file);
      count++;
    }
  }

  if (count === 0) {
    statusEl.textContent = 'No audio files found.';
    return;
  }

  try {
    const r = await fetch('/api/temp/upload', { method: 'POST', body: formData });
    const data = await r.json();

    if (!data.ok) throw new Error(data.error || 'Upload failed');

    // Add to queue as 'temp' type
    for (const f of data.files) {
      const parts = f.filename.replace(/\.[^.]+$/, '').split(' - ');
      const track = {
        type: 'temp',
        url: f.url,
        filepath: f.filepath,
        title: parts.length >= 2 ? parts.slice(1).join(' - ') : f.title,
        artist: parts.length >= 2 ? parts[0] : 'Unknown',
        album: '',
        duration: 0,
        tags: [],
        youtubeId: null,
        tempStored: true,
        storedName: f.url.split('file=')[1]
      };
      DJ.queue.push(track);
      tempFileRegistry.push(track);
    }

    renderQueue();
    renderTempFiles();
    statusEl.textContent = `✓ ${data.count} file(s) uploaded to temp queue`;
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
    setStatus(`Temp: ${data.count} files uploaded and queued`);

  } catch(e) {
    statusEl.textContent = `Upload error: ${e.message}`;
    setStatus('Temp upload failed: ' + e.message);
  }
}

async function renderTempFiles() {
  try {
    const r = await fetch('/api/temp/list');
    const files = await r.json();

    const panel = document.getElementById('temp-files-panel');
    const list = document.getElementById('temp-file-list');
    const count = document.getElementById('temp-count');

    if (files.length === 0) {
      panel.style.display = 'none';
      return;
    }

    panel.style.display = 'block';
    count.textContent = files.length;
    list.innerHTML = files.map(f => `
      <div class="temp-file-item">
        <span class="tf-name" title="${f.filename}">⏳ ${f.filename}</span>
        <span class="tf-size">${fmtBytes(f.size)}</span>
        <button class="tf-del" onclick="deleteTempFile('${f.storedName}')" title="Remove">×</button>
      </div>
    `).join('');
  } catch(e) {}
}

async function deleteTempFile(storedName) {
  try {
    await fetch(`/api/temp/file?file=${encodeURIComponent(storedName)}`, { method: 'DELETE' });
    // Remove from queue
    const idx = DJ.queue.findIndex(t => t.storedName === storedName);
    if (idx > DJ.trackIndex) DJ.queue.splice(idx, 1);
    tempFileRegistry = tempFileRegistry.filter(t => t.storedName !== storedName);
    renderQueue();
    renderTempFiles();
  } catch(e) {}
}

async function clearTempFiles() {
  if (!confirm('Clear all temp files? They will be removed from the queue.')) return;
  await fetch('/api/temp/clear', { method: 'DELETE' });
  DJ.queue = DJ.queue.filter(t => t.type !== 'temp');
  tempFileRegistry = [];
  renderQueue();
  renderTempFiles();
  setStatus('Temp files cleared');
}

// Auto-clear temp files when queue naturally ends (all tracks played)
function checkAutoCleanTemp() {
  const remaining = DJ.queue.slice(DJ.trackIndex + 1);
  const hasTempRemaining = remaining.some(t => t.type === 'temp');
  if (!hasTempRemaining && tempFileRegistry.length > 0) {
    // Queue is clear of temp files, auto-clean
    fetch('/api/temp/clear', { method: 'DELETE' }).catch(() => {});
    tempFileRegistry = [];
    renderTempFiles();
    setStatus('Temp files auto-cleared (queue complete)');
  }
}

// ─── System Stats ─────────────────────────────────────────────────────────────
function fmtBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function updateSystemStats() {
  try {
    const r = await fetch('/api/system/stats');
    const s = await r.json();

    // CPU
    const cpuPct = s.cpu.percent;
    document.getElementById('stat-cpu').textContent = cpuPct + '%';
    document.getElementById('stat-cpu').className = cpuPct > 85 ? 'stat-value stat-warn' : 'stat-value';
    document.getElementById('stat-cpu-sub').textContent = `${s.cpu.cores} cores · ${s.cpu.model.substring(0,28)}`;
    document.getElementById('stat-cpu-bar').style.width = cpuPct + '%';

    // RAM
    document.getElementById('stat-ram').textContent = s.ram.percent + '%';
    document.getElementById('stat-ram').className = s.ram.percent > 85 ? 'stat-value stat-warn' : 'stat-value';
    document.getElementById('stat-ram-sub').textContent = `${fmtBytes(s.ram.used)} / ${fmtBytes(s.ram.total)} · proc: ${fmtBytes(s.ram.processRss)}`;
    document.getElementById('stat-ram-bar').style.width = s.ram.percent + '%';

    // Disk
    document.getElementById('stat-disk').textContent = s.disk.percent + '%';
    document.getElementById('stat-disk').className = s.disk.percent > 90 ? 'stat-value stat-warn' : 'stat-value';
    document.getElementById('stat-disk-sub').textContent = `${fmtBytes(s.disk.free)} free of ${fmtBytes(s.disk.total)}`;
    document.getElementById('stat-disk-bar').style.width = s.disk.percent + '%';

    // Temp storage
    document.getElementById('stat-temp').textContent = s.temp.files;
    document.getElementById('stat-temp-sub').textContent = `${fmtBytes(s.temp.size)} · ${s.platform} · up ${fmtUptime(s.uptime)}`;
    // Show temp bar as filled if files present
    document.getElementById('stat-temp-bar').style.width = s.temp.files > 0 ? '100%' : '5%';

  } catch(e) {
    document.getElementById('stat-cpu').textContent = 'N/A';
  }
}

function fmtUptime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Poll stats every 3 seconds
setInterval(updateSystemStats, 3000);
updateSystemStats();
// Poll temp files list every 5 seconds
setInterval(renderTempFiles, 5000);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(s) {
  if (!s || isNaN(s)) return '0:00';
  s = Math.max(0, s);
  return `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`;
}

function setStatus(msg) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
  console.log('[AutoDJ]', msg);
}
