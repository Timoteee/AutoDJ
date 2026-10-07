const { chromium } = require(process.env.AUTODJ_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.AUTODJ_TEST_URL || 'http://localhost:3000';
const seed = { type: 'online', youtubeId: 'AEZLbq5o4AE', _source: 'youtube', artist: 'Alicia Keys', title: "Alicia Keys - Un-Thinkable (I'm Ready) Remix feat. Drake (Official Audio)", duration: 278 };
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Keep the host user's queue and playback state out of this browser test.
    await page.route('**/api/queue', route => route.fulfill({ contentType: 'application/json', body: '{"queue":[],"trackIndex":-1}' }));
    await page.route('**/api/nowplaying/stream', route => route.abort());
    await page.route('**/api/nowplaying/update', route => route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }));
    await page.route('**/api/playback/**', route => route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }));
    await page.goto(base + '/dj');
    await page.waitForTimeout(700);
    const played = await page.evaluate(async track => {
      document.getElementById('automix').checked = false;
      DJ.queue = [track]; DJ.trackIndex = 0; DJ.currentDeck = 'a'; DJ.started = true;
      const audio = getDeckAudio('a'); audio.muted = true;
      Engine.initAudioCtx();
      await loadTrackOnDeck('a', track);
      await new Promise(resolve => setTimeout(resolve, 700));
      const result = { duration: audio.duration, elapsed: audio.currentTime, failed: !!track._failed };
      audio.pause(); DJ.started = false;
      return result;
    }, seed);
    assert(played.duration > 270 && played.elapsed > 0 && !played.failed, JSON.stringify(played));
    console.log('Exact Alicia Keys track downloads and plays:', JSON.stringify(played));
    await page.evaluate(() => { document.getElementById('automix').checked = true; renderQueue(); });
    await page.waitForFunction(() => DJ.queue.length > 1 && !DJ.discovering, null, { timeout: 60000 });
    const queue = await page.evaluate(() => DJ.queue.map(t => ({ title: t.title, duration: t.duration })));
    assert(queue.every(track => track.duration > 0 && track.duration <= 600));
    console.log('Autoqueue seeded from manually queued track:', queue.length, 'tracks');
    await page.route('**/api/ai/recommend', route => route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"AI unavailable during test"}' }));
    await page.evaluate(() => aiAnalyzeAndRecommend());
    assert(await page.locator('[data-recommend]').count() > 0);
    console.log('Song suggestions fall back to Last.fm when AI is unavailable');
    await page.route('**/api/cache/download', route => route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"test download failure"}' }));
    const retained = await page.evaluate(async () => {
      document.getElementById('automix').checked = false;
      DJ.queue = [{ type: 'online', youtubeId: 'abcdefghijk', title: 'Failure test', artist: 'Test' }];
      DJ.trackIndex = 0;
      await loadTrackOnDeck('a', DJ.queue[0]);
      return { length: DJ.queue.length, failed: DJ.queue[0]._failed, started: DJ.started };
    });
    assert.deepEqual(retained, { length: 1, failed: true, started: false });
    assert.deepEqual(errors, []);
    console.log('Failed downloads retain the track for retry');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
