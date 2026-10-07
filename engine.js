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
    if (relayDestination) { d.analyser.connect(relayDestination); d.relayConnected = true; }
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
  const analyses = new Map();
  async function analyzeTrack(url) {
    if (analyses.has(url)) return analyses.get(url);
    const job = (async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('Audio analysis HTTP ' + response.status);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 80000000) throw new Error('Audio too large for analysis');
      const decoded = await audioCtx.decodeAudioData(bytes);
      return AudioTransitions.analyze(decoded.getChannelData(0), decoded.sampleRate);
    })();
    analyses.set(url, job);
    if (analyses.size > 6) analyses.delete(analyses.keys().next().value);
    try { return await job; } catch (error) { analyses.delete(url); return null; }
  }
  async function detectFadePoint(url, duration) {
    const profile = await analyzeTrack(url);
    return AudioTransitions.plan(profile, null, duration).start;
  }

  // ─── Crossfade ───────────────────────────────────────────────────────────────
  let fadeRaf = null;
  let isFading = false;

  async function crossfade(fromDeck, toDeck, durationSec, onComplete) {
    if (isFading) return;
    isFading = true;

    const from = decks[fromDeck];
    const to = decks[toDeck];

    ensureDeckConnected(toDeck);
    if (to.gain) to.gain.gain.value = 0;
    try { await to.audio.play(); } catch (error) { isFading = false; throw error; }

    const startTime = audioCtx.currentTime;
    const endTime = startTime + durationSec;

    const outgoing = new Float32Array(128), incoming = new Float32Array(128);
    for (let i = 0; i < 128; i++) { const [a, b] = AudioTransitions.gains(i / 127); outgoing[i] = a; incoming[i] = b; }
    for (const [deck, curve] of [[from, outgoing], [to, incoming]]) {
      if (deck.gain) { deck.gain.gain.cancelScheduledValues(startTime); deck.gain.gain.setValueCurveAtTime(curve, startTime, durationSec); }
    }
    // Poll for crossfader UI + completion
    const poll = () => {
      const now = audioCtx.currentTime;
      const t = Math.min((now - startTime) / durationSec, 1);
      const xf = document.getElementById('crossfader');
      if (xf) xf.value = fromDeck === 'a' ? t : 1 - t;
      const mx = document.getElementById('mixer-xfader'); if (mx && xf) mx.value = xf.value;

      if (t >= 1) {
        clearInterval(fadeRaf);
        isFading = false;
        const completedPlayback = { currentTime: from.audio?.currentTime || 0, duration: from.audio?.duration || 0 };
        if (from.audio) { from.audio.pause(); from.audio.currentTime = 0; }
        if (from.gain) from.gain.gain.value = 0;
        if (to.gain) to.gain.gain.value = 1;
        if (onComplete) onComplete(completedPlayback);
        return;
      }

    };
    fadeRaf = setInterval(poll, 50);
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
    if (d.fadePoint && d.audio?.duration && Number.isFinite(d.audio.duration) && d.audio.duration > 0) {
      const fpX = (d.fadePoint / d.audio.duration) * w;
      ctx2.fillStyle = '#ffcc00aa';
      ctx2.fillRect(fpX - 1, 0, 2, h);
    }
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
        duration:Math.round((parseInt(info?.duration)||0) / 1000), album:info?.album?.title||'',
        image:(info?.album?.image||[]).find(i=>i.size==='extralarge')?.['#text']||'' }; }
    catch(e) { return {tags:[],duration:0,album:'',image:''}; }
  }
  async function getArtistInfo(artist) {
    try { const d = await lfm({method:'artist.getinfo',artist});
      return { tags:(d.artist?.tags?.tag||[]).slice(0,5).map(t=>t.name.toLowerCase()),
        image:(d.artist?.image||[]).find(i=>i.size==='extralarge')?.['#text']||'' }; }
    catch(e) { return {tags:[],image:''}; }
  }

  // ─── Video Search ─────────────────────────────────────────────────────────────
  async function searchVideo(artist, title) {
    try {
      const q = `${artist} ${title} audio`;
      const r = await fetch(`/api/youtube/search?q=${encodeURIComponent(q)}`);
      const results = await r.json();
      if (results.length > 0) {
        const x = results[0];
        return { videoId: x.videoId, _source: x._source, _instance: x._instance, lengthSeconds: x.lengthSeconds };
      }
      return null;
    } catch { return null; }
  }

  // ─── AI ───────────────────────────────────────────────────────────────────────
  async function aiRecommend(currentTrack, history, tags, mood) {
    const r = await fetch('/api/ai/recommend', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({currentTrack, history, tags, mood})
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'AI request failed');
    return data;
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

  // ─── WebRTC Broadcast ─────────────────────────────────────────────────────────
  let relayDestination = null, relayTimer = null, relayBusy = false;
  const relayPeers = new Map();
  async function startWebRTCBroadcast() {
    initAudioCtx();
    if (relayTimer) return;
    if (!relayDestination) relayDestination = audioCtx.createMediaStreamDestination();
    for (const deck of Object.values(decks)) {
      if (deck.analyser && !deck.relayConnected) { deck.analyser.connect(relayDestination); deck.relayConnected = true; }
    }
    const tick = async () => {
      if (relayBusy) return; relayBusy = true;
      try {
        const response = await fetch('/api/audio/peers'); if (!response.ok) return;
        const listeners = await response.json();
        for (const [id, local] of relayPeers) if (!listeners.some(p => p.id === id)) { local.pc.close(); relayPeers.delete(id); }
        for (const listener of listeners) {
          let local = relayPeers.get(listener.id);
          const url = '/api/audio/peers/' + listener.id;
          if (!local) {
            const pc = new RTCPeerConnection({ iceServers: [] }); local = { pc, ice: 0 }; relayPeers.set(listener.id, local);
            relayDestination.stream.getTracks().forEach(track => pc.addTrack(track, relayDestination.stream));
            const offer = await pc.createOffer();
            await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offer }) });
            pc.onicecandidate = event => { if (event.candidate) fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'sender', candidate: event.candidate }) }).catch(() => {}); };
            await pc.setLocalDescription(offer);
            continue; // Wait for an answer to this offer, not the previous publisher's answer.
          }
          if (listener.answer && !local.pc.remoteDescription) await local.pc.setRemoteDescription(listener.answer);
          if (local.pc.remoteDescription) for (; local.ice < listener.receiverIce.length; local.ice++) await local.pc.addIceCandidate(listener.receiverIce[local.ice]).catch(() => {});
        }
      } catch (error) { console.warn('[Audio relay]', error.message); } finally { relayBusy = false; }
    };
    relayTimer = setInterval(tick, 1000); void tick();
  }
  function stopWebRTCBroadcast() {
    clearInterval(relayTimer); relayTimer = null;
    for (const local of relayPeers.values()) local.pc.close(); relayPeers.clear();
  }

  async function startWebRTCReceive(audioEl) {
    if (!audioEl) return null;
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      let stream = null;
      pc.ontrack = (e) => {
        stream = e.streams[0];
        if (audioEl && stream) {
          audioEl.srcObject = stream;
          audioEl.play().catch(() => {});
        }
      };

      // Poll for offer
      const poll = setInterval(async () => {
        try {
          const r = await fetch('/api/webrtc/offer');
          const offer = await r.json();
          if (offer && offer.sdp && pc.remoteDescription === null) {
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await fetch('/api/webrtc/answer', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sdp: pc.localDescription.sdp, type: pc.localDescription.type })
            });
            clearInterval(poll);
          }
          // Send ICE candidates
          pc.onicecandidate = (e) => {
            if (e.candidate) {
              fetch('/api/webrtc/ice', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex })
              }).catch(() => {});
            }
          };
        } catch (e) {}
      }, 1000);

      return { pc, poll };
    } catch (e) { console.warn('[WebRTC] receive start:', e); return null; }
  }

  return {
    decks, initAudioCtx, setupDeckAudio, ensureDeckConnected, connectDeckAudio,
    readFileMetadata, extractID3,
    analyzeBPM, analyzeTrack, detectFadePoint,
    crossfade, getVULevel, drawWaveform,
    searchVideo,
    lfm, getSimilarArtists, getTopTracks, getSimilarTracks, getTagTracks, getTrackInfo, getArtistInfo,
    aiRecommend, broadcastNowPlaying,
    startWebRTCBroadcast, stopWebRTCBroadcast, startWebRTCReceive,
    get isFading() { return isFading; },
    get audioCtx() { return audioCtx; }
  };
})();
