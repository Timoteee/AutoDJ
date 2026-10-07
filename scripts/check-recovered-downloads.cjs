const { chromium } = require(process.env.AUTODJ_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.AUTODJ_TEST_URL || 'http://localhost:8090';
(async () => {
  const snapshot = await (await fetch(base + '/api/queue')).json();
  const tracks = snapshot.queue.filter(t => t.youtubeId && t.type !== 'local');
  for (const track of tracks) {
    const response = await fetch(base + '/api/cache/stream/' + encodeURIComponent(track.youtubeId), { headers: { Range: 'bytes=0-31' } });
    assert.equal(response.status, 206, track.title + ' must be cached');
    assert((await response.arrayBuffer()).byteLength > 0);
  }
  console.log('All queued online tracks have readable cached audio:', tracks.length);
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    await page.route('**/api/queue', r => r.fulfill({ contentType: 'application/json', body: '{"queue":[],"trackIndex":-1}' }));
    await page.route('**/api/nowplaying/stream', r => r.abort());
    await page.route('**/api/nowplaying/update', r => r.fulfill({ contentType: 'application/json', body: '{"ok":true}' }));
    await page.goto(base + '/dj'); await page.locator('body').click({ position: { x: 10, y: 10 } });
    for (const track of tracks.filter(t => ['Codeine Crazy', 'Digits', 'Monster', '2Pac', 'I Serve the Base'].includes(t.title))) {
      const result = await page.evaluate(async track => {
        document.getElementById('automix').checked = false;
        DJ.queue = [track]; DJ.trackIndex = 0; DJ.currentDeck = 'a'; DJ.started = true;
        getDeckAudio('a').muted = true;
        await loadTrackOnDeck('a', track); await new Promise(r => setTimeout(r, 300));
        const audio = getDeckAudio('a'); const result = { duration: audio.duration, elapsed: audio.currentTime, failed: track._failed };
        audio.pause(); return result;
      }, track);
      assert(result.duration > 30 && result.elapsed > 0 && !result.failed, track.title + ': ' + JSON.stringify(result));
      console.log('Browser playback verified:', track.title, Math.round(result.duration) + 's');
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
