/**
 * AutoDJ Engine v2.0
 * Handles: Audio loading, Web Audio API, crossfading, BPM/fade detection,
 * queue management, Last.fm discovery, Spotify, AI recommendations
 */

const Engine = (() => {
  // ─── Audio Context ──────────────────────────────────────────────────────────
  let audioCtx = null;
  const decks = {
    a: { audio: null, source: null, gain: null, analyser: null, track: null, type: 'local', cuePoint: 0, bpm: null, fadePoint: null },
    b: { audio: null, source: null, gain: null, analyser: null, track: null, type: 'local', cuePoint: 0, bpm: null, fadePoint: null }
  };

  function initAudioCtx() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  function setupDeckAudio(deck, audioEl) {
    if (!audioCtx) initAudioCtx();
    const d = decks[deck];
    if (d.source) { try { d.source.disconnect(); } catch(e) {} }

    d.audio = audioEl;
    d.source = audioCtx.createMediaElementSource(audioEl);
    d.gain = audioCtx.createGain();
    d.analyser = audioCtx.createAnalyser();
    d.analyser.fftSize = 256;

    d.source.connect(d.gain);
    d.gain.connect(d.analyser);
    d.analyser.connect(audioCtx.destination);
    d.gain.gain.value = 1.0;
  }

  // ─── BPM Detection ──────────────────────────────────────────────────────────
  async function analyzeBPM(audioEl) {
    if (!audioEl.src || !audioCtx) return null;
    try {
      // Offline decode for BPM
      const resp = await fetch(audioEl.src, { headers: { Range: 'bytes=0-500000' } });
      const buf = await resp.arrayBuffer();
      const decoded = await audioCtx.decodeAudioData(buf);

      const data = decoded.getChannelData(0);
      const sampleRate = decoded.sampleRate;
      const windowSize = Math.round(sampleRate * 0.01);
      const energies = [];

      for (let i = 0; i < data.length - windowSize; i += windowSize) {
        let energy = 0;
        for (let j = i; j < i + windowSize; j++) energy += data[j] * data[j];
        energies.push(energy / windowSize);
      }

      // Find peaks
      const avg = energies.reduce((a, b) => a + b, 0) / energies.length;
      const threshold = avg * 1.5;
      const minGap = Math.round(0.3 * sampleRate / windowSize);

      const peaks = [];
      for (let i = 1; i < energies.length - 1; i++) {
        if (energies[i] > threshold && energies[i] > energies[i-1] && energies[i] > energies[i+1]) {
          if (peaks.length === 0 || i - peaks[peaks.length-1] >= minGap) peaks.push(i);
        }
      }

      if (peaks.length < 4) return null;
      const intervals = [];
      for (let i = 1; i < Math.min(peaks.length, 20); i++) {
        intervals.push(peaks[i] - peaks[i-1]);
      }
      const avgInterval = intervals.reduce((a,b)=>a+b,0)/intervals.length;
      const bpm = Math.round(60 / (avgInterval * windowSize / sampleRate));
      return (bpm >= 60 && bpm <= 200) ? bpm : null;
    } catch(e) { return null; }
  }

  // ─── Smart Fade Point ───────────────────────────────────────────────────────
  async function detectFadePoint(audioEl) {
    // Detect quiet section near end of track for best crossfade entry
    if (!audioEl.src || !audioCtx) return null;
    try {
      const dur = audioEl.duration;
      if (!dur || dur < 30) return dur ? dur - 8 : null;

      // Analyze last 30% of track
      const startPct = 0.7;
      const startByte = Math.round(startPct * 500000);
      const resp = await fetch(audioEl.src, { headers: { Range: `bytes=${startByte}-600000` } });
      const buf = await resp.arrayBuffer();

      if (buf.byteLength < 1000) return dur - 10;

      const decoded = await audioCtx.decodeAudioData(buf);
      const data = decoded.getChannelData(0);
      const chunkSize = Math.round(decoded.sampleRate * 0.5);
      const chunks = [];

      for (let i = 0; i < data.length - chunkSize; i += chunkSize) {
        let rms = 0;
        for (let j = i; j < i + chunkSize; j++) rms += data[j] * data[j];
        chunks.push({ rms: Math.sqrt(rms / chunkSize), time: startPct * dur + (i / decoded.sampleRate) });
      }

      // Find a quiet dip in the last 30%
      chunks.sort((a, b) => a.rms - b.rms);
      const quietChunk = chunks.slice(0, 3).find(c => c.time > dur * 0.6 && c.time < dur - 5);
      return quietChunk ? quietChunk.time : dur - 10;
    } catch(e) { return null; }
  }

  // ─── Crossfade ──────────────────────────────────────────────────────────────
  let fadeInterval = null;
  let isFading = false;

  function crossfade(fromDeck, toDeck, durationSec, onComplete) {
    if (isFading) return;
    isFading = true;
    if (fadeInterval) clearInterval(fadeInterval);

    const steps = durationSec * 30;
    let step = 0;

    const from = decks[fromDeck];
    const to = decks[toDeck];

    if (to.audio && to.audio.paused) {
      to.audio.play().catch(() => {});
    }
    if (to.gain) to.gain.gain.value = 0;

    fadeInterval = setInterval(() => {
      step++;
      const t = step / steps;
      const ease = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;

      if (from.gain) from.gain.gain.value = Math.max(0, 1 - ease);
      if (to.gain) to.gain.gain.value = Math.min(1, ease);

      // Also move crossfader slider visually
      const xf = document.getElementById('crossfader');
      if (xf) xf.value = fromDeck === 'a' ? ease : 1 - ease;

      if (step >= steps) {
        clearInterval(fadeInterval);
        isFading = false;
        if (from.gain) from.gain.gain.value = 0;
        if (to.gain) to.gain.gain.value = 1;
        if (from.audio) { from.audio.pause(); from.audio.currentTime = 0; }
        if (onComplete) onComplete();
      }
    }, 1000 / 30);
  }

  // ─── VU Meter Reads ─────────────────────────────────────────────────────────
  function getVULevel(deck) {
    const d = decks[deck];
    if (!d.analyser) return new Array(6).fill(0);
    const buf = new Uint8Array(d.analyser.frequencyBinCount);
    d.analyser.getByteFrequencyData(buf);
    const bands = [0, 4, 12, 30, 60, 100];
    return bands.map((start, i) => {
      const end = bands[i+1] || buf.length;
      let sum = 0;
      for (let j = start; j < end; j++) sum += buf[j];
      return sum / ((end - start) * 255);
    });
  }

  // ─── Waveform Draw ──────────────────────────────────────────────────────────
  function drawWaveform(deck, canvas, progress) {
    const ctx2 = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx2.clearRect(0, 0, w, h);

    const d = decks[deck];
    if (!d.analyser) {
      ctx2.fillStyle = '#1a2035';
      ctx2.fillRect(0, 0, w, h);
      return;
    }

    const buf = new Uint8Array(d.analyser.frequencyBinCount);
    d.analyser.getByteFrequencyData(buf);

    const barW = w / buf.length * 2;
    const playedX = w * progress;

    for (let i = 0; i < buf.length; i++) {
      const barH = (buf[i] / 255) * h;
      const x = i * barW;
      const isPlayed = x < playedX;
      ctx2.fillStyle = isPlayed ? '#00e5ff' : '#1a2035';
      ctx2.fillRect(x, h - barH, barW - 1, barH);
    }

    // Fade point line
    if (d.fadePoint && d.audio?.duration) {
      const fpX = (d.fadePoint / d.audio.duration) * w;
      ctx2.fillStyle = '#ffcc0088';
      ctx2.fillRect(fpX, 0, 2, h);
    }
  }

  // ─── Last.fm API ────────────────────────────────────────────────────────────
  async function lfm(params) {
    const url = new URL('/api/lastfm', window.location.origin);
    Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Last.fm error: ${r.status}`);
    return r.json();
  }

  async function getSimilarArtists(artist, limit=8) {
    try {
      const d = await lfm({ method: 'artist.getsimilar', artist, limit });
      return (d.similarartists?.artist || []).map(a => a.name);
    } catch { return []; }
  }

  async function getTopTracks(artist, limit=5) {
    try {
      const d = await lfm({ method: 'artist.gettoptracks', artist, limit });
      return (d.toptracks?.track || []).map(t => ({ title: t.name, artist, duration: parseInt(t.duration) || 0 }));
    } catch { return []; }
  }

  async function getSimilarTracks(artist, track, limit=5) {
    try {
      const d = await lfm({ method: 'track.getsimilar', artist, track, limit });
      return (d.similartracks?.track || []).map(t => ({ title: t.name, artist: t.artist?.name, duration: parseInt(t.duration) || 0 }));
    } catch { return []; }
  }

  async function getTagTracks(tag, limit=8) {
    try {
      const d = await lfm({ method: 'tag.gettoptracks', tag, limit });
      return (d.tracks?.track || []).map(t => ({ title: t.name, artist: t.artist?.name }));
    } catch { return []; }
  }

  async function getTrackInfo(artist, track) {
    try {
      const d = await lfm({ method: 'track.getinfo', artist, track });
      const info = d.track;
      return {
        tags: (info?.toptags?.tag || []).slice(0, 6).map(t => t.name.toLowerCase()),
        duration: parseInt(info?.duration) || 0,
        album: info?.album?.title || '',
        image: info?.album?.image?.find(i => i.size === 'extralarge')?.['#text'] || ''
      };
    } catch { return { tags: [], duration: 0, album: '', image: '' }; }
  }

  async function getArtistInfo(artist) {
    try {
      const d = await lfm({ method: 'artist.getinfo', artist });
      return {
        tags: (d.artist?.tags?.tag || []).slice(0, 5).map(t => t.name.toLowerCase()),
        image: d.artist?.image?.find(i => i.size === 'extralarge')?.['#text'] || ''
      };
    } catch { return { tags: [] }; }
  }

  // ─── YouTube Search ─────────────────────────────────────────────────────────
  async function findYouTubeId(artist, title) {
    try {
      const q = `${artist} ${title} audio`;
      const r = await fetch(`/api/youtube/search?q=${encodeURIComponent(q)}`);
      const results = await r.json();
      return results[0]?.videoId || null;
    } catch { return null; }
  }

  // ─── AI Recommendations ─────────────────────────────────────────────────────
  async function aiRecommend(currentTrack, history, tags, mood) {
    const r = await fetch('/api/ai/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentTrack, history, tags, mood })
    });
    if (!r.ok) throw new Error('AI request failed');
    return r.json();
  }

  // ─── Now Playing SSE Update ─────────────────────────────────────────────────
  async function broadcastNowPlaying(data) {
    try {
      await fetch('/api/nowplaying/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    } catch(e) {}
  }

  return {
    decks, initAudioCtx, setupDeckAudio,
    analyzeBPM, detectFadePoint, crossfade, getVULevel, drawWaveform,
    lfm, getSimilarArtists, getTopTracks, getSimilarTracks, getTagTracks, getTrackInfo, getArtistInfo,
    findYouTubeId, aiRecommend, broadcastNowPlaying,
    get isFading() { return isFading; },
    get audioCtx() { return audioCtx; }
  };
})();
