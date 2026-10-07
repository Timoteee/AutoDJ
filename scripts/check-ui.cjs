// Install Playwright separately, or point AUTODJ_PLAYWRIGHT_MODULE at a bundled copy.
const { chromium } = require(process.env.AUTODJ_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.AUTODJ_TEST_URL || 'http://localhost:3000';
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('https://**/*', route => route.abort());
    await context.route('**/api/nowplaying/update', r => r.fulfill({ contentType: 'application/json', body: '{"ok":true}' }));
    await context.route('**/api/playback/**', r => r.fulfill({ contentType: 'application/json', body: '{"ok":true}' }));
    await context.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage blocked'); } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(base + '/dj');
      await page.waitForTimeout(1200);
      const layout = await page.evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { width: r.width, height: r.height }; };
        return { logo: rect('.brand-mark'), main: rect('.main-area'), grid: getComputedStyle(document.querySelector('.decks-grid')).display,
          overflow: document.documentElement.scrollWidth > innerWidth, connection: document.querySelector('#connection-state').textContent };
      });
      assert(layout.main.width > 300, JSON.stringify(layout));
      assert.equal(layout.grid, 'grid');
      assert.equal(layout.overflow, false);
      if (width > 768) assert.equal(layout.logo.width, 24);
      assert.equal(layout.connection, 'Live');
      const nav = width > 768 ? '.sidebar' : '.bottom-nav';
      for (const name of ['queue', 'discovery', 'downloads', 'settings', 'failed', 'console']) {
        await page.locator(`${nav} [data-page="${name}"]`).click();
        assert.equal(await page.locator(`#page-${name}`).isVisible(), true);
      }
      await page.screenshot({ path: `ui-${width}.png`, fullPage: true });
      console.log('Layout/navigation OK:', width, JSON.stringify(layout));
    }
    await page.route('**/api/config', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"test failure"}' }));
    await page.evaluate(() => saveConfig());
    assert.match(await page.locator('#status').textContent(), /not saved/);
    console.log('Failed settings save reports failure');
    assert.deepEqual(errors, []);
    for (const url of ['/display', '/display/nano']) {
      await page.goto(base + url);
      await page.waitForTimeout(500);
    }
    assert.deepEqual(errors, []);
    console.log('Display pages loaded without script errors');
    await context.close();
    const offlineContext = await browser.newContext();
    await offlineContext.route('**/api/nowplaying/update', r => r.fulfill({ contentType: 'application/json', body: '{"ok":true}' }));
    await offlineContext.route('**/api/playback/**', r => r.fulfill({ contentType: 'application/json', body: '{"ok":true}' }));
    const offlinePage = await offlineContext.newPage();
    await offlinePage.goto(base + '/dj');
    await offlinePage.evaluate(() => navigator.serviceWorker.ready);
    await offlinePage.reload();
    await offlineContext.setOffline(true);
    await offlinePage.reload();
    assert.equal(await offlinePage.locator('.main-area').isVisible(), true);
    console.log('Offline app shell reload OK');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
