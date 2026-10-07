const { chromium } = require(process.env.AUTODJ_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://localhost:3000/dj');
    await page.locator('.sidebar [data-page="discovery"]').click();
    await page.locator('#discover-search').fill('drake');
    await page.evaluate(() => discoverSearch());
    assert(await page.locator('.album-card').count() > 0);
    assert(await page.locator('.source-audius').count() > 0);
    assert(await page.locator('.source-youtube').count() > 0);
    console.log('Drake UI search renders YouTube and Audius results');
    const audio = await page.evaluate(async () => {
      const hits = await (await fetch('/api/youtube/search?q=drake')).json();
      const hit = hits.find(hit => hit._source === 'audius');
      const r = await fetch('/api/cache/download', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: hit.videoId, title: hit.title, artist: hit.author, _source: 'audius' }) });
      const track = await r.json();
      if (!r.ok || !track.ok) throw new Error(JSON.stringify(track));
      const player = new Audio(track.url);
      player.muted = true;
      await player.play();
      await new Promise(resolve => setTimeout(resolve, 700));
      const result = { duration: player.duration, elapsed: player.currentTime };
      player.pause();
      return result;
    });
    assert(audio.duration > 0 && audio.elapsed > 0, JSON.stringify(audio));
    console.log('Browser decoded and played cached Audius audio:', JSON.stringify(audio));
    await page.route('**/api/youtube/search?**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Search sources unavailable"}' }));
    await page.evaluate(() => discoverSearch());
    assert.match(await page.locator('#discovery-results').textContent(), /sources unavailable/);
    assert.deepEqual(errors, []);
    console.log('UI shows source failures instead of no matches');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
