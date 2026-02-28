/**
 * AutoDJ Engine v3.0
 * Fixed: AudioContext timing, Piped direct audio streams, waveform canvas,
 *        ID3 metadata extraction, artwork, crossfade bugs, SSE broadcast timing
 */

const Engine = (() => {
  let audioCtx = null;
  const decks = {
    a: { audio: null, source: null, gain: null, analyser: null, track: null,
         cuePoint: 0, bpm: null, fadePoint: null, ytInterval: null },
    b: { audio: null, source: null, gain: null, analyser: null, track: null,
         cuePoint: 0, bpm: null, fadePoint: null, ytInterval: null }
  };

  // ─── AudioContext — MUST be created on user gesture ──────────────────────────
  function initAudioCtx() {
    if (audioCtx && audioCtx.state !== 'closed') {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return;
    }
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  // Connect an <audio> element to the Web Audio graph.
  // Safe to call multiple times — disconnects old source first.
  function connectDeckAudio(deck, audioEl) {
    const d = decks[deck];
    // If element already has a source node, reuse it — can't createMediaElementSource twice
    if (d.source && d.audio === audioEl) return;
    if (d.source) { try { d.source.disconnect(); } catch(e) {} }

    if (!audioCtx) initAudioCtx();

    d.audio = audioEl;
    try {
      d.source = audioCtx.createMediaElementSource(audioEl);
    } catch(e) {
      // Already connected to a different context — skip
      console.warn('Engine: could not create source', e.message);
      return;
    }
    d.gain = audioCtx.createGain();
    d.analyser = audioCtx.createAnalyser();
    d.analyser.fftSize = 512;

    d.source.connect(d.gain);
    d.gain.connect(d.analyser);
    d.analyser.connect(audioCtx.destination);
    d.gain.gain.value = 1.0;
  }

  // Called once on page load to set up the audio elements
  function setupDeckAudio(deck, audioEl) {
    decks[deck].audio = audioEl;
    // Don't connect to WebAudio yet — wait for user gesture
  }

  // Called on first play (after user gesture)
  function ensureDeckConnected(deck) {
    initAudioCtx();
    const d = decks[deck];
    if (!d.source && d.audio) connectDeckAudio(deck, d.audio);
  }

  // ─── ID3 / Metadata extraction via browser ───────────────────────────────────
  // Reads ID3v2 tags from an ArrayBuffer (first 128KB of file)
  function extractID3(buffer) {
    const meta = { title: '', artist: '', album: '', year: '', artwork: null };
    try {
      const view = new DataView(buffer);
      const bytes = new Uint8Array(buffer);

      // Check for ID3v2 header
      if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return meta;
      const id3ver = bytes[3];
      const tagSize = ((bytes[6]&0x7f)<<21)|((bytes[7]&0x7f)<<14)|((bytes[8]&0x7f)<<7)|(bytes[9]&0x7f);

      let pos = 10;
      const enc = { 0: 'iso-8859-1', 1: 'utf-16', 3: 'utf-8' };

      const readStr = (start, len, encoding) => {
        try {
          const slice = bytes.slice(start, start + len);
          const e = enc[encoding] || 'utf-8';
          return new TextDecoder(e).decode(slice).replace(/\0/g,'').trim();
        } catch(e) { return ''; }
      };

      while (pos < tagSize + 10 && pos < buffer.byteLength - 10) {
        const frameId = String.fromCharCode(...bytes.slice(pos, pos+4));
        if (frameId === '\0\0\0\0') break;

        let frameSize;
        if (id3ver >= 4) {
          frameSize = ((bytes[pos+4]&0x7f)<<21)|((bytes[pos+5]&0x7f)<<14)|((bytes[pos+6]&0x7f)<<7)|(bytes[pos+7]&0x7f);
        } else {
          frameSize = (bytes[pos+4]<<24)|(bytes[pos+5]<<16)|(bytes[pos+6]<<8)|bytes[pos+7];
        }
        if (frameSize <= 0 || pos + 10 + frameSize > buffer.byteLength) break;

        const dataStart = pos + 10;
        const encoding = bytes[dataStart];

        if (frameId === 'TIT2') meta.title = readStr(dataStart+1, frameSize-1, encoding);
        else if (frameId === 'TPE1') meta.artist = readStr(dataStart+1, frameSize-1, encoding);
        else if (frameId === 'TALB') meta.album = readStr(dataStart+1, frameSize-1, encoding);
        else if (frameId === 'TDRC' || frameId === 'TYER') meta.year = readStr(dataStart+1, frameSize-1, encoding);
        else if (frameId === 'APIC') {
          // Artwork: encoding(1) + mimeType + \0 + picType(1) + desc + \0 + imageData
          let i = dataStart + 1;
          while (i < dataStart + frameSize && bytes[i] !== 0) i++; // end of mime
          i++; // skip \0
          i++; // skip picture type
          while (i < dataStart + frameSize && bytes[i] !== 0) i++; // end of desc
          i++; // skip \0
          const imgData = bytes.slice(i, dataStart + frameSize);
          const mime = bytes.slice(dataStart+1, dataStart + (i - dataStart - 2)).reduce((s,c)=>s+String.fromCharCode(c),'').split('\0')[0];
          const blob = new Blob([imgData], { type: mime || 'image/jpeg' });
          meta.artwork = URL.createObjectURL(blob);
        }
        pos += 10 + frameSize;
      }
    } catch(e) {}
    return meta;
  }

  async function readFileMetadata(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(extractID3(e.target.result));
      reader.onerror = () => resolve({ title:'', artist:'', album:'', artwork: null });
      // Read first 512KB — enough for ID3 tags and embedded artwork
      reader.readAsArrayBuffer(file.slice(0, 512 * 1024));
    });
  }

  // ─── BPM Detection ───────────────────────────────────────────────────────────
  async function analyzeBPM(url) {
    if (!url || !audioCtx) return null;
    try {
      const resp = await fetch(url, { headers: { Range: 'bytes=0-400000' } });
      const buf = await resp.arrayBuffer();
      const decoded = await audioCtx.decodeAudioData(buf);
      const data = decoded.getChannelData(0);
      const sr = decoded.sampleRate;
      const wSize = Math.round(sr * 0.01);
      const energies = [];
      for (let i = 0; i < data.length - wSize; i += wSize) {
        let e = 0; for (let j = i; j < i+wSize; j++) e += data[j]*data[j];
        energies.push(e / wSize);
      }
      const avg = energies.reduce((a,b)=>a+b,0)/energies.length;
      const thresh = avg * 1.5;
      const minGap = Math.round(0.3 * sr / wSize);
      const peaks = [];
      for (let i = 1; i < energies.length-1; i++) {
        if (energies[i] > thresh && energies[i] > energies[i-1] && energies[i] > energies[i+1]) {
          if (!peaks.length || i - peaks[peaks.length-1] >= minGap) peaks.push(i);
        }
      }
      if (peaks.length < 4) return null;
      const intervals = [];
      for (let i = 1; i < Math.min(peaks.length,20); i++) intervals.push(peaks[i]-peaks[i-1]);
      const avgInterval = intervals.reduce((a,b)=>a+b)/intervals.length;
      const bpm = Math.round(60/(avgInterval * wSize / sr));
      return (bpm >= 60 && bpm <= 200) ? bpm : null;
    } catch(e) { return null; }
  }

  // ─── Smart Fade Point ────────────────────────────────────────────────────────
  async function detectFadePoint(url, duration) {
    if (!url || !duration || duration < 20) return duration ? Math.max(duration - 8, duration * 0.8) : null;
    try {
      // Try to fetch the last ~20% of the file
      const resp = await fetch(url, { headers: { Range: 'bytes=800000-1200000' } });
      if (!resp.ok) return duration - 10;
      const buf = await resp.arrayBuffer();
      if (buf.byteLength < 1000) return duration - 10;
      const decoded = await audioCtx.decodeAudioData(buf);
      const data = decoded.getChannelData(0);
      const chunkSec = 0.5;
      const chunkSize = Math.round(decoded.sampleRate * chunkSec);
      const startTime = duration * 0.7;
      const chunks = [];
      for (let i = 0; i < data.length - chunkSize; i += chunkSize) {
        let rms = 0;
        for (let j = i; j < i+chunkSize; j++) rms += data[j]*data[j];
        chunks.push({ rms: Math.sqrt(rms/chunkSize), time: startTime + (i/decoded.sampleRate) });
      }
      chunks.sort((a,b) => a.rms - b.rms);
      const quiet = chunks.slice(0,5).find(c => c.time > duration*0.65 && c.time < duration - 4);
      return quiet ? quiet.time : duration - 10;
    } catch(e) { return duration - 10; }
  }

  // ─── Crossfade ───────────────────────────────────────────────────────────────
  let fadeRaf = null;
  let isFading = false;

  function crossfade(fromDeck, toDeck, durationSec, onComplete) {
    if (isFading) return;
    isFading = true;

    const from = decks[fromDeck];
    const to = decks[toDeck];

    ensureDeckConnected(toDeck);
    if (to.gain) to.gain.gain.value = 0;
    if (to.audio?.paused) to.audio.play().catch(() => {});

    const startTime = audioCtx.currentTime;
    const endTime = startTime + durationSec;

    // Use AudioContext scheduler for sample-accurate fade
    if (from.gain) {
      from.gain.gain.setValueAtTime(1, startTime);
      from.gain.gain.linearRampToValueAtTime(0, endTime);
    }
    if (to.gain) {
      to.gain.gain.setValueAtTime(0, startTime);
      to.gain.gain.linearRampToValueAtTime(1, endTime);
    }

    // Poll for crossfader UI + completion
    const poll = () => {
      const now = audioCtx.currentTime;
      const t = Math.min((now - startTime) / durationSec, 1);
      const xf = document.getElementById('crossfader');
      if (xf) xf.value = fromDeck === 'a' ? t : 1 - t;

      if (t >= 1) {
        isFading = false;
        if (from.audio) { from.audio.pause(); from.audio.currentTime = 0; }
        if (from.gain) from.gain.gain.value = 0;
        if (to.gain) to.gain.gain.value = 1;
        if (onComplete) onComplete();
        return;
      }
      fadeRaf = requestAnimationFrame(poll);
    };
    fadeRaf = requestAnimationFrame(poll);
  }

  // ─── VU Meters ───────────────────────────────────────────────────────────────
  function getVULevel(deck) {
    const d = decks[deck];
    if (!d.analyser) return new Array(6).fill(0);
    const buf = new Uint8Array(d.analyser.frequencyBinCount);
    d.analyser.getByteFrequencyData(buf);
    const bands = [0, 4, 12, 30, 60, 100];
    return bands.map((start, i) => {
      const end = bands[i+1] || buf.length;
      let sum = 0; for (let j = start; j < end; j++) sum += buf[j];
      return sum / ((end - start) * 255);
    });
  }

  // ─── Waveform ────────────────────────────────────────────────────────────────
  function drawWaveform(deck, canvas, progress) {
    if (!canvas || canvas.width === 0) {
      canvas.width = canvas.offsetWidth || 300;
    }
    const ctx2 = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx2.clearRect(0, 0, w, h);
    ctx2.fillStyle = '#0b0f1a';
    ctx2.fillRect(0, 0, w, h);

    const d = decks[deck];
    if (!d.analyser) return;

    const buf = new Uint8Array(d.analyser.frequencyBinCount);
    d.analyser.getByteFrequencyData(buf);

    const barW = Math.max(1, (w / buf.length) * 2);
    const playedX = w * progress;

    for (let i = 0; i < buf.length; i++) {
      const barH = Math.max(1, (buf[i] / 255) * h);
      const x = i * barW;
      const played = x < playedX;
      ctx2.fillStyle = played ? '#00e5ff' : '#1e2a40';
      ctx2.fillRect(x, h - barH, barW - 0.5, barH);
    }

    // Fade point marker
    if (d.fadePoint && d.audio?.duration) {
      const fpX = (d.fadePoint / d.audio.duration) * w;
      ctx2.fillStyle = '#ffcc00aa';
      ctx2.fillRect(fpX - 1, 0, 2, h);
    }
  }

  // ─── Piped direct audio stream ────────────────────────────────────────────────
  async function getPipedAudioUrl(videoId) {
    try {
      console.log(`[Engine] Getting Piped stream for videoId: ${videoId}`);
      const r = await fetch(`/api/piped/streams?videoId=${videoId}`);
      if (!r.ok) {
        console.error(`[Engine] Piped streams HTTP ${r.status} for ${videoId}`);
        return null;
      }
      const data = await r.json();
      if (data.audioStreams?.length > 0) {
        console.log(`[Engine] Got ${data.audioStreams.length} audio streams for ${videoId}`);
        return { url: data.audioStreams[0].url, thumbnail: data.thumbnail,
                 title: data.title, uploader: data.uploader, duration: data.duration };
      }
      if (data.error) {
        console.error(`[Engine] Piped error for ${videoId}: ${data.error}`);
      }
    } catch(e) {
      console.error(`[Engine] getPipedAudioUrl error:`, e);
    }
    return null;
  }

  // ─── Last.fm ─────────────────────────────────────────────────────────────────
  async function lfm(params) {
    const url = new URL('/api/lastfm', window.location.origin);
    Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Last.fm ${r.status}`);
    const d = await r.json();
    if (d.error) throw new Error(d.message || `Last.fm error ${d.error}`);
    return d;
  }

  async function getSimilarArtists(artist, limit=8) {
    try { const d = await lfm({method:'artist.getsimilar',artist,limit}); return (d.similarartists?.artist||[]).map(a=>a.name); }
    catch(e) { return []; }
  }
  async function getTopTracks(artist, limit=5) {
    try { const d = await lfm({method:'artist.gettoptracks',artist,limit});
      return (d.toptracks?.track||[]).map(t=>({title:t.name,artist,duration:parseInt(t.duration)||0})); }
    catch(e) { return []; }
  }
  async function getSimilarTracks(artist, track, limit=5) {
    try { const d = await lfm({method:'track.getsimilar',artist,track,limit});
      return (d.similartracks?.track||[]).map(t=>({title:t.name,artist:t.artist?.name||artist,duration:parseInt(t.duration)||0})); }
    catch(e) { return []; }
  }
  async function getTagTracks(tag, limit=8) {
    try { const d = await lfm({method:'tag.gettoptracks',tag,limit});
      return (d.tracks?.track||[]).map(t=>({title:t.name,artist:t.artist?.name||''})); }
    catch(e) { return []; }
  }
  async function getTrackInfo(artist, track) {
    try { const d = await lfm({method:'track.getinfo',artist,track});
      const info = d.track;
      return { tags:(info?.toptags?.tag||[]).slice(0,6).map(t=>t.name.toLowerCase()),
        duration:parseInt(info?.duration)||0, album:info?.album?.title||'',
        image:(info?.album?.image||[]).find(i=>i.size==='extralarge')?.['#text']||'' }; }
    catch(e) { return {tags:[],duration:0,album:'',image:''}; }
  }
  async function getArtistInfo(artist) {
    try { const d = await lfm({method:'artist.getinfo',artist});
      return { tags:(d.artist?.tags?.tag||[]).slice(0,5).map(t=>t.name.toLowerCase()),
        image:(d.artist?.image||[]).find(i=>i.size==='extralarge')?.['#text']||'' }; }
    catch(e) { return {tags:[],image:''}; }
  }

  // ─── MusicBrainz Fallback ────────────────────────────────────────────────────
  async function mbSimilarArtists(artist, limit=5) {
    try {
      const r = await fetch(`/api/musicbrainz/artist?query=${encodeURIComponent(artist)}&limit=1`);
      const d = await r.json();
      const mbid = d.artists?.[0]?.id;
      if (!mbid) return [];
      // Get artist relations
      const r2 = await fetch(`/api/musicbrainz/artist/${mbid}?inc=artist-rels`);
      const d2 = await r2.json();
      const related = (d2.relations || [])
        .filter(r => r.type === 'member of band' || r.type === 'collaboration' || r.type === 'is person')
        .map(r => r.artist?.name).filter(Boolean).slice(0, limit);
      return related;
    } catch(e) { console.error('[MB] similar artists error:', e); return []; }
  }

  async function mbSearchTracks(artist, limit=5) {
    try {
      const r = await fetch(`/api/musicbrainz/recording?query=artist:${encodeURIComponent(artist)}&limit=${limit}`);
      const d = await r.json();
      return (d.recordings || []).map(rec => ({
        title: rec.title,
        artist: rec['artist-credit']?.[0]?.name || artist,
        duration: rec.length ? Math.round(rec.length / 1000) : 0,
        source: 'musicbrainz'
      }));
    } catch(e) { console.error('[MB] search error:', e); return []; }
  }

  async function mbSimilarTracks(artist, title, limit=5) {
    // MusicBrainz doesn't have direct "similar tracks" — search by same artist + related
    try {
      const tracks = await mbSearchTracks(artist, limit);
      // Filter out the original track
      return tracks.filter(t => t.title.toLowerCase() !== title.toLowerCase());
    } catch(e) { return []; }
  }

  // ─── Discogs Fallback ──────────────────────────────────────────────────────────
  async function discogsSimilarTracks(artist, title, limit=5) {
    try {
      const r = await fetch(`/api/discogs/search?artist=${encodeURIComponent(artist)}&type=release&per_page=3`);
      const d = await r.json();
      const results = [];
      for (const release of (d.results || []).slice(0, 2)) {
        // Get tracklist from release
        if (release.resource_url) {
          try {
            const r2 = await fetch(`/api/discogs/search?q=${encodeURIComponent(release.title + ' ' + artist)}&type=release&per_page=1`);
            const d2 = await r2.json();
            // Create track entries from the release info
            if (d2.results?.[0]) {
              results.push({
                title: d2.results[0].title?.split(' - ')?.[1] || d2.results[0].title || release.title,
                artist: artist,
                duration: 0,
                source: 'discogs'
              });
            }
          } catch(e) {}
        }
      }
      return results.filter(t => t.title.toLowerCase() !== title.toLowerCase()).slice(0, limit);
    } catch(e) { console.error('[Discogs] error:', e); return []; }
  }

  // ─── Similar to Current (multi-source fallback chain) ─────────────────────────
  async function findSimilarToCurrent(artist, title, limit=8) {
    const results = { tracks: [], source: '' };

    // 1. Last.fm track.getsimilar (primary)
    try {
      const lfmTracks = await getSimilarTracks(artist, title, limit);
      if (lfmTracks.length > 0) {
        results.tracks = lfmTracks.map(t => ({...t, source: 'lastfm'}));
        results.source = 'Last.fm';
        console.log(`[Similar] Got ${lfmTracks.length} from Last.fm`);
        return results;
      }
    } catch(e) { console.warn('[Similar] Last.fm failed:', e.message); }

    // 2. MusicBrainz fallback
    try {
      const mbTracks = await mbSimilarTracks(artist, title, limit);
      if (mbTracks.length > 0) {
        results.tracks = mbTracks;
        results.source = 'MusicBrainz';
        console.log(`[Similar] Got ${mbTracks.length} from MusicBrainz`);
        return results;
      }
    } catch(e) { console.warn('[Similar] MusicBrainz failed:', e.message); }

    // 3. Discogs fallback
    try {
      const dcTracks = await discogsSimilarTracks(artist, title, limit);
      if (dcTracks.length > 0) {
        results.tracks = dcTracks;
        results.source = 'Discogs';
        console.log(`[Similar] Got ${dcTracks.length} from Discogs`);
        return results;
      }
    } catch(e) { console.warn('[Similar] Discogs failed:', e.message); }

    // 4. Last.fm artist top tracks as last resort
    try {
      const topTracks = await getTopTracks(artist, limit);
      if (topTracks.length > 0) {
        results.tracks = topTracks.filter(t => t.title.toLowerCase() !== title.toLowerCase()).map(t => ({...t, source: 'lastfm-top'}));
        results.source = 'Last.fm (top tracks)';
        return results;
      }
    } catch(e) {}

    results.source = 'none';
    return results;
  }
  async function searchVideo(artist, title) {
    try {
      const q = `${artist} ${title} audio`;
      console.log(`[Engine] Searching video: "${q}"`);
      const r = await fetch(`/api/youtube/search?q=${encodeURIComponent(q)}`);
      if (!r.ok) {
        console.error(`[Engine] Video search HTTP ${r.status}`);
        return null;
      }
      const results = await r.json();
      if (!results.length) {
        console.warn(`[Engine] No video results for: ${artist} — ${title}`);
        return null;
      }
      console.log(`[Engine] Found video: ${results[0].videoId} — ${results[0].title}`);
      return results[0].videoId;
    } catch(e) {
      console.error(`[Engine] Video search error:`, e);
      return null;
    }
  }

  // ─── AI ───────────────────────────────────────────────────────────────────────
  async function aiRecommend(currentTrack, history, tags, mood) {
    const r = await fetch('/api/ai/recommend', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({currentTrack, history, tags, mood})
    });
    if (!r.ok) throw new Error('AI request failed');
    return r.json();
  }

  // ─── SSE Broadcast ───────────────────────────────────────────────────────────
  async function broadcastNowPlaying(data) {
    try {
      await fetch('/api/nowplaying/update', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(data)
      });
    } catch(e) {}
  }

  return {
    decks, initAudioCtx, setupDeckAudio, ensureDeckConnected, connectDeckAudio,
    readFileMetadata, extractID3,
    analyzeBPM, detectFadePoint,
    crossfade, getVULevel, drawWaveform,
    getPipedAudioUrl, searchVideo,
    lfm, getSimilarArtists, getTopTracks, getSimilarTracks, getTagTracks, getTrackInfo, getArtistInfo,
    mbSimilarArtists, mbSearchTracks, mbSimilarTracks,
    discogsSimilarTracks, findSimilarToCurrent,
    aiRecommend, broadcastNowPlaying,
    get isFading() { return isFading; },
    get audioCtx() { return audioCtx; }
  };
})();
