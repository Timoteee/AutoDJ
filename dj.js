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
  // Enter key for online song input
  const onlineInput = document.getElementById('online-song-input');
  if (onlineInput) onlineInput.addEventListener('keydown', e => { if (e.key === 'Enter') addOnlineSong(); });
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

    // Display settings
    const marqueeMode = document.getElementById('cfg-marquee-mode');
    if (marqueeMode && cfg.marqueeMode) marqueeMode.value = cfg.marqueeMode;
    const rssUrl = document.getElementById('cfg-rss-url');
    if (rssUrl && cfg.rssUrl) rssUrl.value = cfg.rssUrl;
    const bgArt = document.getElementById('cfg-bg-art');
    if (bgArt && cfg.bgArtSource) bgArt.value = cfg.bgArtSource;
    toggleRssPreview();

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
    messages: DJ.messages,
    marqueeMode: document.getElementById('cfg-marquee-mode')?.value || 'static',
    rssUrl: document.getElementById('cfg-rss-url')?.value || '',
    bgArtSource: document.getElementById('cfg-bg-art')?.value || 'track'
  };
  await fetch('/api/config', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  await loadConfig();
  setStatus('Configuration saved ✓ — testing services...');
  // Auto-test after save
  await testAllServices();
}

// ─── API Service Testing ─────────────────────────────────────────────────────
async function testAllServices() {
  const banner = document.getElementById('service-test-banner');
  if (banner) { banner.style.display = 'block'; banner.textContent = 'Testing services...'; banner.style.color = 'var(--accent)'; banner.style.background = 'rgba(0,229,255,0.06)'; banner.style.borderColor = 'rgba(0,229,255,0.2)'; }

  try {
    const r = await fetch('/api/test/services');
    const results = await r.json();

    // Update indicators
    setTestResult('test-lastfm', results.lastfm);
    setTestResult('test-spotify', results.spotify);
    setTestResult('test-ai', results.ai);
    setTestResult('test-musicbrainz', results.musicbrainz);
    setTestResult('test-discogs', results.discogs);

    // Update streaming instances
    const streamEl = document.getElementById('test-streaming');
    if (streamEl && results.streaming) {
      const up = results.streaming.filter(s => s.ok).length;
      streamEl.innerHTML = `<span style="color:${up > 0 ? 'var(--green)' : 'var(--accent2)'}">${up > 0 ? '●' : '✗'}</span> Streaming: ${up}/${results.streaming.length} instances up`;
    }

    // Update DJ state
    DJ.hasLastfm = results.lastfm?.ok || false;
    DJ.hasSpotify = results.spotify?.ok || false;
    DJ.hasAI = results.ai?.ok || false;
    updateServiceIndicators();

    // Banner
    if (banner) {
      const s = results.summary;
      banner.textContent = `${s.connected} of ${s.total} services connected · ${s.streamingUp} streaming instances up`;
      banner.style.color = s.connected >= 3 ? 'var(--green)' : s.connected >= 1 ? 'var(--yellow)' : 'var(--accent2)';
      banner.style.background = s.connected >= 3 ? 'rgba(0,255,136,0.06)' : s.connected >= 1 ? 'rgba(255,204,0,0.06)' : 'rgba(255,51,102,0.06)';
      banner.style.borderColor = s.connected >= 3 ? 'rgba(0,255,136,0.2)' : s.connected >= 1 ? 'rgba(255,204,0,0.2)' : 'rgba(255,51,102,0.2)';
    }
    setStatus(`Services tested: ${results.summary.connected}/${results.summary.total} connected`);
  } catch(e) {
    if (banner) { banner.textContent = 'Test failed: ' + e.message; banner.style.color = 'var(--accent2)'; }
  }
}

function setTestResult(elId, result) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (result?.ok) {
    el.innerHTML = `<span style="color:var(--green)">● Connected</span>`;
  } else {
    el.innerHTML = `<span style="color:var(--accent2)">✗ ${escHtml(result?.error || 'Failed')}</span>`;
  }
}

// ─── Similar to Current ──────────────────────────────────────────────────────
async function findSimilarToCurrent() {
  const cur = DJ.queue[DJ.trackIndex];
  if (!cur || !cur.artist || !cur.title) {
    setStatus('No track is currently playing');
    return;
  }
  setStatus(`Finding tracks similar to "${cur.artist} — ${cur.title}"...`);

  try {
    const result = await Engine.findSimilarToCurrent(cur.artist, cur.title, 8);
    if (result.tracks.length === 0) {
      setStatus('No similar tracks found from any source');
      return;
    }

    setStatus(`Found ${result.tracks.length} similar tracks from ${result.source}`);
    showDiscoverResults(result.tracks, `Similar to "${cur.title}" (${result.source})`);

    // Auto-queue the first few
    let added = 0;
    for (const t of result.tracks.slice(0, 4)) {
      if (added >= 3) break;
      if (await enqueueOnlineTrack(t)) added++;
    }
    if (added > 0) {
      renderQueue();
      setStatus(`Queued ${added} similar tracks from ${result.source}`);
    }
  } catch(e) {
    console.error('[Similar]', e);
    setStatus('Error finding similar tracks: ' + e.message);
  }
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
    // Get direct audio stream from Piped
    setStatus(`Fetching stream for: ${track.title}...`);
    const stream = await Engine.getPipedAudioUrl(track.youtubeId);
    if (stream) {
      streamUrl = stream.url;
      track._streamUrl = stream.url; // stored for display relay
      // Fill in metadata from Piped if not set
      if (!track.artwork && stream.thumbnail) track.artwork = stream.thumbnail;
      if (!track.title || track.title === '?') track.title = stream.title || track.title;
      if (!track.duration && stream.duration) track.duration = stream.duration;
      audio.src = streamUrl;
      audio.load();
    } else {
      setStatus(`No stream found for ${track.title} — skipping`);
      setTimeout(() => advanceQueue(), 1500);
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
  DJ.history.push(DJ.queue[DJ.trackIndex]);
  DJ.trackIndex++;

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
  getDeckAudio(deck).play().catch(()=>{});
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

  // Periodically broadcast elapsed for display page interpolation (~every 1s)
  if (deck === DJ.currentDeck && Math.floor(cur) !== Math.floor(cur - 0.3)) {
    const track = Engine.decks[deck].track;
    const audioA = getDeckAudio('a');
    const audioB = getDeckAudio('b');
    const xfader = document.getElementById('crossfader');
    if (track) Engine.broadcastNowPlaying({
      nowPlaying: { title: track.title, artist: track.artist, album: track.album, artwork: track.artwork || track.image || '', elapsed: cur, duration: dur, fadePoint: Engine.decks[deck].fadePoint },
      isPlaying: true,
      deckState: {
        activeDeck: DJ.currentDeck,
        crossfader: parseFloat(xfader?.value || 0),
        decks: {
          a: { elapsed: audioA?.currentTime || 0, duration: audioA?.duration || 0, gain: Engine.decks.a.gain?.gain?.value ?? 0 },
          b: { elapsed: audioB?.currentTime || 0, duration: audioB?.duration || 0, gain: Engine.decks.b.gain?.gain?.value ?? 0 }
        }
      }
    });
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
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:11px">Queue empty — add tracks from Library or Discover</div>';
    updateIdleDeckPreview();
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
    const loadBtns = !isPlay && !isPast ? `<button class="ctrl-btn" style="padding:2px 5px;font-size:8px" onclick="loadToDeck('a',${i})" title="Load to Deck A">→A</button>
      <button class="ctrl-btn" style="padding:2px 5px;font-size:8px" onclick="loadToDeck('b',${i})" title="Load to Deck B">→B</button>` : '';
    return `<div class="qitem${isPlay?' playing':''}${isNext?' next':''}${isPast?' past':''} ${t.type}"
      draggable="${!isPlay}" data-idx="${i}"
      ondragstart="onDragStart(event,${i})" ondragover="onDragOver(event)"
      ondrop="onDrop(event,${i})" ondragleave="onDragLeave(event)"
      ontouchstart="onTouchDragStart(event,${i})" ontouchmove="onTouchDragMove(event)" ontouchend="onTouchDragEnd(event,${i})">
      <div class="q-num" style="cursor:grab;user-select:none" title="Drag to reorder">⠿</div>
      <div class="q-src">${src}</div>
      <div class="q-info">
        <div class="q-title">${escHtml(t.title || '?')}</div>
        <div class="q-artist">${escHtml(t.artist || '?')}${t.album?' · '+escHtml(t.album):''}</div>
        ${t.tags?.length ? `<div class="q-tags">${t.tags.slice(0,3).join(' · ')}</div>` : ''}
      </div>
      <span class="q-badge ${badgeClass}" ${badgeStyle}>${badgeText}</span>
      <div class="q-dur">${t.duration ? fmt(t.duration) : '—'}</div>
      <div style="display:flex;gap:2px;align-items:center">${loadBtns}
      <button class="q-remove" onclick="removeFromQueue(${i})" ${isPlay?'disabled style="opacity:0.2"':''}>×</button></div>
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

  updateIdleDeckPreview();
}

// Show preview of next track on the idle deck
function updateIdleDeckPreview() {
  const nextTrack = DJ.queue[DJ.trackIndex + 1];
  const idleDeck = getNextDeck();
  const titleEl = document.getElementById(`title-${idleDeck}`);
  const artistEl = document.getElementById(`artist-${idleDeck}`);

  // Only update if the idle deck doesn't have a track loaded
  if (Engine.decks[idleDeck].track) return;
  if (nextTrack && titleEl && artistEl) {
    titleEl.textContent = `⏭ ${nextTrack.title || '?'}`;
    titleEl.style.opacity = '0.5';
    artistEl.textContent = nextTrack.artist || '?';
    artistEl.style.opacity = '0.5';
  }
}

// Load a specific queue item directly to a deck
function loadToDeck(deck, queueIdx) {
  const track = DJ.queue[queueIdx];
  if (!track) return;
  Engine.initAudioCtx();
  Engine.ensureDeckConnected(deck);
  loadTrackOnDeck(deck, track);
  setStatus(`Loaded "${track.title}" on Deck ${deck.toUpperCase()}`);
}

// Load next queued track onto the idle deck
function loadNextOnIdleDeck() {
  const nextTrack = DJ.queue[DJ.trackIndex + 1];
  if (!nextTrack) { setStatus('No next track in queue'); return; }
  const idleDeck = getNextDeck();
  loadToDeck(idleDeck, DJ.trackIndex + 1);
}

// ─── Touch drag-to-reorder support ──────────────────────────────────────────
let touchDragIdx = null;
let touchDragEl = null;

function onTouchDragStart(e, idx) {
  touchDragIdx = idx;
  touchDragEl = e.currentTarget;
  touchDragEl.style.opacity = '0.5';
}

function onTouchDragMove(e) {
  if (touchDragIdx === null) return;
  e.preventDefault();
}

function onTouchDragEnd(e, targetIdx) {
  if (touchDragIdx === null || touchDragIdx === targetIdx) {
    if (touchDragEl) touchDragEl.style.opacity = '1';
    touchDragIdx = null;
    touchDragEl = null;
    return;
  }
  const item = DJ.queue.splice(touchDragIdx, 1)[0];
  DJ.queue.splice(targetIdx, 0, item);
  if (touchDragIdx < DJ.trackIndex) DJ.trackIndex--;
  else if (targetIdx <= DJ.trackIndex) DJ.trackIndex++;
  touchDragIdx = null;
  touchDragEl = null;
  renderQueue();
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
  clearDiscoverResults();

  try {
    const info = track ? await Engine.getTrackInfo(artist, track) : await Engine.getArtistInfo(artist);
    DJ.seedTags = info.tags || [];
    setStatus(`Tags: ${DJ.seedTags.slice(0,4).join(', ') || 'none found'}`);

    let seeds = track ? [{title:track,artist}] : [];
    const tops = await Engine.getTopTracks(artist, 4);
    seeds.push(...tops);

    // Show found tracks in the Discover results panel before queuing
    showDiscoverResults(seeds, 'Top tracks');

    for (const t of seeds.slice(0, 3)) await enqueueOnlineTrack(t);

    if (DJ.trackIndex < 0 && DJ.queue.length > 0) {
      DJ.trackIndex = 0;
      startPlayback();
      renderQueue();
    }

    // Keep filling
    setTimeout(() => fetchMoreOnline(), 2000);
  } catch(e) { setStatus('Discovery error: ' + e.message); console.error('[Discovery]', e); }
}

async function fetchMoreOnline() {
  if (DJ.discovering || !DJ.hasLastfm) return;
  DJ.discovering = true;
  const mode = document.getElementById('discovery-mode')?.value || 'both';
  let candidates = [];

  try {
    if ((mode === 'similar' || mode === 'both') && DJ.knownArtists.length) {
      const base = DJ.knownArtists[Math.floor(Math.random() * Math.min(DJ.knownArtists.length, 5))];
      setStatus(`Finding artists similar to ${base}...`);
      const similar = await Engine.getSimilarArtists(base, 6);
      for (const a of similar.slice(0, 3)) {
        const tracks = await Engine.getTopTracks(a, 2);
        candidates.push(...tracks);
      }
    }
    if ((mode === 'tag' || mode === 'both') && DJ.seedTags.length) {
      const tag = DJ.seedTags[Math.floor(Math.random() * DJ.seedTags.length)];
      setStatus(`Finding tracks tagged "${tag}"...`);
      const tagTracks = await Engine.getTagTracks(tag, 5);
      candidates.push(...tagTracks);
    }
    const cur = DJ.queue[DJ.trackIndex];
    if (cur && cur.artist && cur.title) {
      const sim = await Engine.getSimilarTracks(cur.artist, cur.title, 5);
      candidates.push(...sim);
    }

    candidates = candidates.filter(c => {
      const key = `${c.artist?.toLowerCase()}::${c.title?.toLowerCase()}`;
      return !DJ.usedTracks.has(key) && c.artist && c.title;
    }).sort(() => Math.random() - 0.5);

    // Show what we found
    if (candidates.length > 0) showDiscoverResults(candidates, 'Discovered');

    let added = 0;
    for (const t of candidates) {
      if (added >= 4) break;
      if (await enqueueOnlineTrack(t)) added++;
    }
    if (added > 0) { renderQueue(); setStatus(`Queued ${added} new track${added!==1?'s':''} from discovery`); }
    else if (candidates.length === 0) { setStatus('No new candidates found — try broadening seed tags'); }
    else { setStatus('Found candidates but could not resolve streams — instances may be down'); }
  } catch(e) { setStatus('Discovery error: ' + e.message); console.error('[Discovery]', e); }
  finally { DJ.discovering = false; }
}

async function enqueueOnlineTrack(t) {
  const key = `${t.artist?.toLowerCase()}::${t.title?.toLowerCase()}`;
  if (DJ.usedTracks.has(key) || !t.artist || !t.title) return false;

  setStatus(`Searching: ${t.artist} — ${t.title}`);
  try {
    const videoId = await Engine.searchVideo(t.artist, t.title);
    if (!videoId) {
      console.warn(`[Enqueue] No video found for: ${t.artist} — ${t.title}`);
      setStatus(`No video found for: ${t.artist} — ${t.title}`);
      updateDiscoverItemStatus(t, 'not-found');
      return false;
    }

    const info = await Engine.getTrackInfo(t.artist, t.title);
    DJ.usedTracks.add(key);

    const track = {
      type: 'online', youtubeId: videoId,
      title: t.title, artist: t.artist,
      album: info.album || '', tags: info.tags || [],
      duration: info.duration || t.duration || 0,
      image: info.image || '', artwork: info.image || ''
    };
    DJ.queue.push(track);
    if (!DJ.knownArtists.includes(t.artist)) DJ.knownArtists.push(t.artist);
    (info.tags||[]).forEach(tag => { if (!DJ.seedTags.includes(tag)) DJ.seedTags.push(tag); });
    renderQueue();
    updateDiscoverItemStatus(t, 'queued');
    setStatus(`Queued: ${t.artist} — ${t.title}`);
    return true;
  } catch(e) {
    console.error(`[Enqueue] Error for ${t.artist} — ${t.title}:`, e);
    setStatus(`Error queuing ${t.artist} — ${t.title}: ${e.message}`);
    updateDiscoverItemStatus(t, 'error');
    return false;
  }
}

// ─── Discovery Results Panel ─────────────────────────────────────────────────
function clearDiscoverResults() {
  const el = document.getElementById('discover-results');
  if (el) el.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:12px;text-align:center">Run a discovery to see results here</div>';
}

function showDiscoverResults(tracks, label) {
  const el = document.getElementById('discover-results');
  if (!el || !tracks.length) return;

  const existingHtml = el.innerHTML.includes('disc-item') ? el.innerHTML : '';
  const newHtml = tracks.map(t => {
    const id = `disc-${(t.artist||'').replace(/\W/g,'')}-${(t.title||'').replace(/\W/g,'')}`.slice(0,60);
    return `<div class="disc-item" id="${id}" style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border);font-size:11px">
      <div style="flex:1;overflow:hidden">
        <div style="color:var(--bright);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(t.title || '?')}</div>
        <div style="color:var(--muted);font-size:10px">${escHtml(t.artist || '?')}</div>
      </div>
      <span class="disc-status" style="font-size:9px;color:var(--muted);min-width:50px;text-align:center">—</span>
      <button class="btn" style="padding:3px 10px;font-size:9px;white-space:nowrap"
        onclick="manualEnqueueDiscover('${escAttr(t.artist)}','${escAttr(t.title)}',this)">+ Queue</button>
    </div>`;
  }).join('');

  if (existingHtml.includes('disc-item')) {
    // Append
    el.insertAdjacentHTML('beforeend', newHtml);
  } else {
    el.innerHTML = `<div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);padding:6px 12px;border-bottom:1px solid var(--border)">${label}</div>` + newHtml;
  }
}

function updateDiscoverItemStatus(t, status) {
  const id = `disc-${(t.artist||'').replace(/\W/g,'')}-${(t.title||'').replace(/\W/g,'')}`.slice(0,60);
  const el = document.getElementById(id);
  if (!el) return;
  const statusEl = el.querySelector('.disc-status');
  const btn = el.querySelector('button');
  if (status === 'queued') {
    if (statusEl) { statusEl.textContent = '✓ Queued'; statusEl.style.color = 'var(--green)'; }
    if (btn) { btn.disabled = true; btn.textContent = 'Queued'; }
  } else if (status === 'not-found') {
    if (statusEl) { statusEl.textContent = '✗ No video'; statusEl.style.color = 'var(--accent2)'; }
  } else if (status === 'error') {
    if (statusEl) { statusEl.textContent = '✗ Error'; statusEl.style.color = 'var(--accent2)'; }
  } else if (status === 'searching') {
    if (statusEl) { statusEl.textContent = '⟳ ...'; statusEl.style.color = 'var(--accent)'; }
  }
}

async function manualEnqueueDiscover(artist, title, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  const result = await enqueueOnlineTrack({ artist, title });
  if (!result && btn) {
    btn.disabled = false;
    btn.textContent = 'Retry';
    btn.style.borderColor = 'var(--accent2)';
    btn.style.color = 'var(--accent2)';
  }
}

// ─── Add Online Song by Search (Queue Tab) ──────────────────────────────────
async function addOnlineSong() {
  const input = document.getElementById('online-song-input');
  const statusEl = document.getElementById('online-add-status');
  if (!input) return;
  const query = input.value.trim();
  if (!query) { if (statusEl) statusEl.textContent = 'Enter an artist and title'; return; }

  if (statusEl) { statusEl.textContent = 'Searching...'; statusEl.style.color = 'var(--accent)'; }

  // Try to parse "artist - title" or just search as-is
  let artist = '', title = '';
  if (query.includes(' - ')) {
    const parts = query.split(' - ');
    artist = parts[0].trim();
    title = parts.slice(1).join(' - ').trim();
  } else if (query.includes(' — ')) {
    const parts = query.split(' — ');
    artist = parts[0].trim();
    title = parts.slice(1).join(' — ').trim();
  } else {
    // Search as-is, use the result title/author
    title = query;
    artist = '';
  }

  try {
    const searchQ = artist ? `${artist} ${title}` : query;
    const r = await fetch(`/api/youtube/search?q=${encodeURIComponent(searchQ + ' audio')}`);
    const results = await r.json();

    if (!results.length) {
      if (statusEl) { statusEl.textContent = `No results for "${query}"`; statusEl.style.color = 'var(--accent2)'; }
      return;
    }

    const best = results[0];
    const videoId = best.videoId;
    const trackTitle = title || best.title || query;
    const trackArtist = artist || best.author || 'Unknown';

    // Try to get metadata from Last.fm
    let info = { tags: [], album: '', image: '', duration: 0 };
    if (DJ.hasLastfm) {
      try { info = await Engine.getTrackInfo(trackArtist, trackTitle); } catch(e) {}
    }

    const track = {
      type: 'online', youtubeId: videoId,
      title: trackTitle, artist: trackArtist,
      album: info.album || '', tags: info.tags || [],
      duration: info.duration || best.lengthSeconds || 0,
      image: info.image || '', artwork: info.image || ''
    };
    DJ.queue.push(track);
    renderQueue();
    input.value = '';
    if (statusEl) { statusEl.textContent = `Queued: ${trackArtist} — ${trackTitle}`; statusEl.style.color = 'var(--green)'; }
    setStatus(`Queued: ${trackArtist} — ${trackTitle}`);
  } catch(e) {
    console.error('[AddOnline]', e);
    if (statusEl) { statusEl.textContent = `Error: ${e.message}`; statusEl.style.color = 'var(--accent2)'; }
  }
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s) { return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'\\"'); }

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
        ${t.image?`<img class="sp-img" src="${escHtml(t.image)}">`:'<div class="sp-img" style="background:var(--border);display:flex;align-items:center;justify-content:center">♪</div>'}
        <div class="sp-info">
          <div class="sp-name">${escHtml(t.title)}</div>
          <div class="sp-artist">${escHtml(t.artist)}${t.album?' · '+escHtml(t.album):''}</div>
        </div>
        <button class="btn" style="padding:3px 8px;font-size:9px" onclick="queueSpotifyResult(${i})">+ Queue</button>
      </div>`).join('') : '<div style="color:var(--muted);font-size:11px;padding:8px">No results</div>';
    // Store results for button reference
    window._spotifyResults = tracks;
  } catch(e) { div.innerHTML = `<div style="color:var(--accent2);font-size:11px;padding:8px">Error: ${e.message}</div>`; }
}

async function queueSpotifyResult(index) {
  const t = window._spotifyResults?.[index];
  if (!t) return;
  await queueSpotifyTrack(t);
}

async function queueSpotifyTrack(t) {
  setStatus(`Finding stream for "${t.artist} — ${t.title}"...`);
  try {
    const videoId = await Engine.searchVideo(t.artist, t.title);
    if (videoId) {
      DJ.queue.push({...t, type:'online', youtubeId:videoId, artwork:t.image});
      renderQueue();
      setStatus(`Queued: ${t.artist} — ${t.title}`);
    } else {
      setStatus(`No video found for: ${t.artist} — ${t.title}`);
    }
  } catch(e) {
    console.error('[SpotifyQueue]', e);
    setStatus(`Error queuing ${t.title}: ${e.message}`);
  }
}

// ─── AI ───────────────────────────────────────────────────────────────────────
async function aiAnalyzeAndRecommend() {
  if (!DJ.hasAI) { setStatus('Configure an AI key in Settings first'); return; }
  const el = document.getElementById('ai-result');
  el.innerHTML = '<span style="color:var(--muted)">Consulting AI...</span>';
  try {
    const cur = DJ.queue[DJ.trackIndex];
    const recs = await Engine.aiRecommend(cur, DJ.history, DJ.seedTags, document.getElementById('ai-mood')?.value);
    const results = Array.isArray(recs) ? recs : [];
    window._aiResults = results;
    el.innerHTML = results.length ? results.map((r, i) =>
      `<div style="margin-bottom:8px;border-bottom:1px solid var(--border);padding-bottom:6px">
        <div style="color:var(--bright)">${escHtml(r.artist)} — ${escHtml(r.title)}</div>
        <div style="color:var(--accent3);font-size:10px">${escHtml(r.reason||'')}</div>
        <button class="btn" style="padding:3px 8px;font-size:9px;margin-top:4px"
          onclick="enqueueAIResult(${i},this)">+ Queue</button>
      </div>`).join('') : '<span style="color:var(--muted)">No recommendations returned</span>';
  } catch(e) { el.innerHTML = `<span style="color:var(--accent2)">Error: ${e.message}</span>`; }
}

async function enqueueAIResult(index, btn) {
  const r = window._aiResults?.[index];
  if (!r) return;
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  try {
    const videoId = await Engine.searchVideo(r.artist, r.title);
    if (videoId) {
      DJ.queue.push({type:'online',youtubeId:videoId,title:r.title,artist:r.artist,tags:DJ.seedTags.slice(0,3)});
      renderQueue();
      setStatus(`Queued: ${r.artist} — ${r.title}`);
      if (btn) { btn.textContent = '✓'; btn.style.color = 'var(--green)'; btn.style.borderColor = 'var(--green)'; }
    } else {
      setStatus(`No video found for: ${r.artist} — ${r.title}`);
      if (btn) { btn.disabled = false; btn.textContent = 'Retry'; btn.style.color = 'var(--accent2)'; btn.style.borderColor = 'var(--accent2)'; }
    }
  } catch(e) {
    console.error('[AIQueue]', e);
    setStatus(`Error: ${e.message}`);
    if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
  }
}

async function enqueueAITrack(artist, title) {
  try {
    const videoId = await Engine.searchVideo(artist, title);
    if (videoId) {
      DJ.queue.push({type:'online',youtubeId:videoId,title,artist,tags:DJ.seedTags.slice(0,3)});
      renderQueue(); setStatus(`Queued: ${artist} — ${title}`);
    } else setStatus(`No video found for: ${artist} — ${title}`);
  } catch(e) { setStatus(`Error: ${e.message}`); }
}

async function aiRefillQueue() {
  if (!DJ.hasAI) { setStatus('Configure an AI key in Settings first'); return; }
  setStatus('AI refilling queue...');
  try {
    const recs = await Engine.aiRecommend(DJ.queue[DJ.trackIndex], DJ.history, DJ.seedTags, document.getElementById('ai-mood')?.value||'');
    let added = 0;
    for (const r of (Array.isArray(recs)?recs:[])) {
      const vid = await Engine.searchVideo(r.artist, r.title);
      if (vid) { DJ.queue.push({type:'online',youtubeId:vid,title:r.title,artist:r.artist,tags:[]}); added++; }
    }
    renderQueue(); setStatus(`AI added ${added} tracks`);
  } catch(e) { setStatus('AI error: '+e.message); }
}

// ─── Broadcast Now Playing ────────────────────────────────────────────────────
async function broadcastNP(track) {
  if (!track) return;
  const next = DJ.queue[DJ.trackIndex+1];
  const audioA = getDeckAudio('a');
  const audioB = getDeckAudio('b');
  const genre = track.tags?.[0] || DJ.seedTags[0] || '';
  // Build stream URL for display page audio relay
  let streamUrl = '';
  if (track.type === 'local') streamUrl = track.url || '';
  else if (track.type === 'temp') streamUrl = track.url || '';
  else if (track._streamUrl) streamUrl = '/api/piped/relay?url=' + encodeURIComponent(track._streamUrl);

  // Build next track stream URL
  let nextStreamUrl = '';
  if (next) {
    if (next.type === 'local' || next.type === 'temp') nextStreamUrl = next.url || '';
    else if (next._streamUrl) nextStreamUrl = '/api/piped/relay?url=' + encodeURIComponent(next._streamUrl);
  }

  // Background art - try to get artist image if that mode is selected
  let artistImageUrl = '';
  const bgSource = document.getElementById('cfg-bg-art')?.value || 'track';
  if (bgSource === 'artist' && track.artist && DJ.hasLastfm) {
    try {
      const info = await Engine.getArtistInfo(track.artist);
      artistImageUrl = info.image || '';
    } catch(e) {}
  }

  const xfader = document.getElementById('crossfader');
  await Engine.broadcastNowPlaying({
    nowPlaying: {
      title: track.title || 'Unknown Title',
      artist: track.artist || 'Unknown Artist',
      album: track.album || '',
      duration: track.duration || audioA?.duration || audioB?.duration || 0,
      elapsed: getDeckAudio(DJ.currentDeck)?.currentTime || 0,
      fadePoint: Engine.decks[DJ.currentDeck].fadePoint,
      tags: track.tags || [],
      artwork: track.artwork || track.image || '',
      image: track.image || track.artwork || '',
      streamUrl
    },
    nextUp: next ? {
      title: next.title || '?',
      artist: next.artist || '?',
      artwork: next.artwork || next.image || '',
      streamUrl: nextStreamUrl
    } : null,
    genre: genre ? genre.charAt(0).toUpperCase()+genre.slice(1) : '',
    isPlaying: true, messages: DJ.messages,
    bgArtSource: bgSource,
    bgImageUrl: track.artwork || track.image || '',
    artistImageUrl,
    deckState: {
      activeDeck: DJ.currentDeck,
      crossfader: parseFloat(xfader?.value || 0),
      decks: {
        a: {
          track: Engine.decks.a.track ? { title: Engine.decks.a.track.title, artist: Engine.decks.a.track.artist, streamUrl: Engine.decks.a.track._streamUrl ? '/api/piped/relay?url=' + encodeURIComponent(Engine.decks.a.track._streamUrl) : (Engine.decks.a.track.url || '') } : null,
          elapsed: audioA?.currentTime || 0,
          duration: audioA?.duration || 0,
          gain: Engine.decks.a.gain?.gain?.value ?? (DJ.currentDeck === 'a' ? 1 : 0),
          fadePoint: Engine.decks.a.fadePoint
        },
        b: {
          track: Engine.decks.b.track ? { title: Engine.decks.b.track.title, artist: Engine.decks.b.track.artist, streamUrl: Engine.decks.b.track._streamUrl ? '/api/piped/relay?url=' + encodeURIComponent(Engine.decks.b.track._streamUrl) : (Engine.decks.b.track.url || '') } : null,
          elapsed: audioB?.currentTime || 0,
          duration: audioB?.duration || 0,
          gain: Engine.decks.b.gain?.gain?.value ?? (DJ.currentDeck === 'b' ? 1 : 0),
          fadePoint: Engine.decks.b.fadePoint
        }
      }
    }
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

// ─── Authentication ─────────────────────────────────────────────────────────
async function doLogout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch(e) {}
  window.location.href = '/login';
}

async function changePassword() {
  const statusEl = document.getElementById('pw-change-status');
  const currentPw = document.getElementById('cfg-current-pw').value;
  const newPw = document.getElementById('cfg-new-pw').value;
  const confirmPw = document.getElementById('cfg-confirm-pw').value;

  statusEl.style.display = 'none';

  if (!currentPw || !newPw || !confirmPw) {
    showPwStatus('Please fill in all password fields', false);
    return;
  }
  if (newPw !== confirmPw) {
    showPwStatus('New passwords do not match', false);
    return;
  }
  if (newPw.length < 6) {
    showPwStatus('New password must be at least 6 characters', false);
    return;
  }

  try {
    const res = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw })
    });
    const data = await res.json();

    if (data.ok) {
      showPwStatus('Password changed successfully', true);
      document.getElementById('cfg-current-pw').value = '';
      document.getElementById('cfg-new-pw').value = '';
      document.getElementById('cfg-confirm-pw').value = '';
    } else {
      showPwStatus(data.error || 'Failed to change password', false);
    }
  } catch(e) {
    showPwStatus('Connection error', false);
  }
}

function showPwStatus(msg, success) {
  const el = document.getElementById('pw-change-status');
  el.style.display = 'block';
  el.textContent = msg;
  if (success) {
    el.style.background = 'rgba(0,255,136,0.08)';
    el.style.border = '1px solid rgba(0,255,136,0.25)';
    el.style.color = 'var(--green)';
  } else {
    el.style.background = 'rgba(255,51,102,0.08)';
    el.style.border = '1px solid rgba(255,51,102,0.25)';
    el.style.color = 'var(--accent2)';
  }
}

// ─── RSS / Display Settings ─────────────────────────────────────────────────
function toggleRssPreview() {
  const mode = document.getElementById('cfg-marquee-mode')?.value;
  const rssEl = document.getElementById('rss-config');
  const staticEl = document.getElementById('static-msg-config');
  if (rssEl) rssEl.style.display = mode === 'rss' ? 'block' : 'none';
  if (staticEl) staticEl.style.display = mode === 'static' ? 'block' : 'none';
}

async function previewRSS() {
  const url = document.getElementById('cfg-rss-url')?.value;
  const preview = document.getElementById('rss-preview');
  if (!url || !preview) return;
  preview.innerHTML = '<div style="color:var(--accent)">Fetching...</div>';
  try {
    const r = await fetch(`/api/rss/proxy?url=${encodeURIComponent(url)}`);
    const data = await r.json();
    if (data.items?.length) {
      preview.innerHTML = data.items.slice(0, 8).map(i =>
        `<div style="padding:3px 0;border-bottom:1px solid var(--border)">📰 ${escHtml(i.title)}</div>`
      ).join('') + `<div style="padding:3px 0;color:var(--green)">${data.items.length} items found</div>`;
    } else {
      preview.innerHTML = '<div style="color:var(--accent2)">No RSS items found — check the URL</div>';
    }
  } catch(e) {
    preview.innerHTML = `<div style="color:var(--accent2)">Error: ${e.message}</div>`;
  }
}
