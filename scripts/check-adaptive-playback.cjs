const { chromium } = require(process.env.AUTODJ_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.AUTODJ_TEST_URL || 'http://localhost:3100';
// Locally generated tone: tests audible mixer transport without downloading music.
const sr = 16000, seconds = 18, wav = Buffer.alloc(44 + sr * seconds * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < sr * seconds; i++) wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * i / sr) * 4000), 44 + i * 2);
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const errors = []; context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
    await context.route('**/test-tone*.wav', r => r.fulfill({ contentType: 'audio/wav', body: wav }));
    await context.route('**/api/discovery/**', r => r.fulfill({ contentType: 'application/json', body: '{"recommendations":[]}' }));
    await context.route('**/api/queue', r => r.fulfill({ contentType: 'application/json', body: '{"queue":[],"trackIndex":-1}' }));
    const dj = await context.newPage(); await dj.goto(base + '/dj'); await dj.locator('body').click({ position: { x: 10, y: 10 } });
    await dj.evaluate(async () => {
      sseSource.close(); document.getElementById('automix').checked = true;
      document.getElementById('smart-fade').checked = true;
      DJ.queue = [1,2,3].map(i => ({ type: 'local', title: 'Tone ' + i, artist: 'Fixture', url: '/test-tone' + i + '.wav', duration: 18 }));
      DJ.trackIndex = 0; DJ.currentDeck = 'a'; DJ.started = true;
      Engine.initAudioCtx(); await loadTrackOnDeck('a', DJ.queue[0]);
    });
    await dj.waitForFunction(() => getDeckAudio('b').readyState >= 3 && Engine.decks.b.track?.title === 'Tone 2');
    const displays = await Promise.all([context.newPage(), context.newPage()]);
    for (const display of displays) {
      await display.goto(base + '/display'); await display.locator('#audio-listen-btn').click();
      await display.waitForFunction(() => mixerConnected && mixerAudio.currentTime > 0 && _webrtcState.pc.connectionState === "connected", null, { timeout: 25000 });
      const rms = await display.evaluate(async () => {
        const ctx = new AudioContext(); const source = ctx.createMediaStreamSource(mixerAudio.srcObject);
        const analyser = ctx.createAnalyser(); source.connect(analyser); await ctx.resume();
        await new Promise(r => setTimeout(r, 200)); const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples); const rms = Math.sqrt(samples.reduce((s, v) => s + v*v, 0) / samples.length); await ctx.close(); return rms;
      });
      if (rms <= .005) {
        console.log('Sender', await dj.evaluate(() => ({ state: Engine.audioCtx.state, a: { paused: getDeckAudio('a').paused, time: getDeckAudio('a').currentTime, gain: Engine.decks.a.gain?.gain.value, vu: Engine.getVULevel('a') }, b: { paused: getDeckAudio('b').paused, gain: Engine.decks.b.gain?.gain.value } })));
        console.log('Receiver', await display.evaluate(async () => { const stats = await _webrtcState.pc.getStats(); return [...stats.values()].filter(x => x.type === 'inbound-rtp').map(x => ({ bytesReceived: x.bytesReceived, audioLevel: x.audioLevel, totalAudioEnergy: x.totalAudioEnergy, packetsReceived: x.packetsReceived })); }));
      }
      assert(rms > .005, 'Mixer must transmit non-silent audio: ' + rms);
    }
    console.log('Two displays receive audible mixer audio automatically');
    for (const [index, deck] of [[1, 'b'], [2, 'a']]) {
      await dj.waitForFunction(() => Engine.decks[getNextDeck()].track === DJ.queue[DJ.trackIndex + 1] && getDeckAudio(getNextDeck()).readyState >= 3);
      await dj.bringToFront();
      await dj.evaluate(() => { getDeckAudio(DJ.currentDeck).currentTime = 16.5; updateDeckUI(DJ.currentDeck); });
      await dj.waitForFunction(expected => DJ.trackIndex === expected && !Engine.isFading && !DJ.fadeLock, index);
      const state = await dj.evaluate(() => ({ deck: DJ.currentDeck, fader: getCrossfaderValue(), paused: getDeckAudio(DJ.currentDeck).paused }));
      assert.equal(state.deck, deck); assert.equal(state.paused, false); assert.equal(state.fader, deck === 'b' ? 1 : 0);
      for (const display of displays) await display.waitForFunction(title => document.getElementById('track-title').textContent === title, 'Tone ' + (index + 1));
      console.log('Automatic crossfade completed to deck ' + deck);
    }
    await dj.route('**/api/cache/download', r => r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"Provider unavailable"}' }));
    const failure = await dj.evaluate(async () => {
      document.getElementById('automix').checked = false;
      DJ.queue.push({ type: 'online', title: 'Unavailable', youtubeId: 'abcdefghijk' });
      DJ.trackIndex = 2; DJ.currentDeck = 'a'; DJ.started = true;
      const outgoing = getDeckAudio('a'); outgoing.loop = true; outgoing.currentTime = 0; await outgoing.play();
      const before = DJ.trackIndex;
      await triggerCrossfade();
      return { index: DJ.trackIndex, before, started: DJ.started, locked: DJ.fadeLock, paused: getDeckAudio(DJ.currentDeck).paused };
    });
    assert.equal(failure.index, failure.before); assert.equal(failure.started, true); assert.equal(failure.locked, false); assert.equal(failure.paused, false);
    console.log('Failed incoming download preserves outgoing playback and releases transition lock');
    await displays[0].evaluate(() => {
      applyState({ nowPlaying: { title: 'Late URL', artist: 'Fixture', duration: 18, elapsed: 0, streamUrl: '' }, isPlaying: true });
      applyState({ nowPlaying: { title: 'Late URL', artist: 'Fixture', duration: 18, elapsed: 0, streamUrl: '/test-tone-late.wav' }, isPlaying: true });
    });
    assert.equal(await displays[0].evaluate(() => currentStreamUrl), '/test-tone-late.wav');
    console.log('Display reconciles audio URLs arriving after track metadata');
    assert.equal(await dj.locator('#share-audio-btn').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
