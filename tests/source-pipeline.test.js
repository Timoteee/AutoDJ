const { SourcePipeline, SOURCE_KEYS } = require('../lib/source-pipeline');

describe('SourcePipeline', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('empty sourcePriority falls back to the default order', () => {
    const pipeline = new SourcePipeline({ sourcePriority: [] });
    expect(pipeline.getSourcePriority()).toEqual(SOURCE_KEYS);
  });

  test('a non-empty priority is kept', () => {
    const pipeline = new SourcePipeline({ sourcePriority: ['jamendo', 'dab'] });
    expect(pipeline.getSourcePriority()).toEqual(['jamendo', 'dab']);
  });

  test('circuit opens after three consecutive failures', () => {
    const pipeline = new SourcePipeline({ sourcePriority: ['invidious'] });
    const url = pipeline.getHealthyInstances('invidious')[0];
    expect(url).toBeTruthy();
    pipeline.markInstance(url, false, 100);
    pipeline.markInstance(url, false, 100);
    pipeline.markInstance(url, false, 100);
    expect(pipeline.getHealthyInstances('invidious')).not.toContain(url);
  });

  test('testAll probes each source with its own search URL', async () => {
    const calls = [];
    vi.stubGlobal('fetch', async (url) => {
      calls.push(String(url));
      return { ok: true, json: async () => {
        if (String(url).includes('/api/v1/search')) return [];
        if (String(url).includes('audius')) return { data: [] };
        if (String(url).includes('filter=videos')) return { items: [] };
        return { results: [] };
      }, text: async () => 'var ytInitialData = {"contents":[]};' };
    });
    const pipeline = new SourcePipeline({ sourcePriority: [] });
    await pipeline.testAll();
    expect(calls.some(url => url.includes('/api/v1/search?q=test'))).toBe(true);
    expect(calls.some(url => url.includes('/search?q=test&filter=videos'))).toBe(true);
    expect(calls.some(url => url.includes('/api/search?q=test'))).toBe(true);
    expect(calls.some(url => url.includes('/api/v1/trending'))).toBe(false);
  });

  test('health report lists instance rows', () => {
    const pipeline = new SourcePipeline({});
    const report = pipeline.getHealthReport();
    expect(report.sources.invidious.total).toBeGreaterThan(0);
    expect(report.instances.some(row => row.source === 'piped' && row.url && row.status)).toBe(true);
  });
  test('manual tests retry open circuits and reject HTML API responses', async () => {
    const pipeline = new SourcePipeline({});
    const url = pipeline.getHealthyInstances('invidious')[0];
    for (let i = 0; i < 3; i++) pipeline.markInstance(url, false);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('HTML instead of JSON'); }, text: async () => '<html>Access denied</html>' }));
    const report = await pipeline.testAll({ force: true });
    expect(report.invidious[url].status).toBe('failed');
    expect(report.invidious[url].error).toContain('HTML');
    expect(fetch.mock.calls.some(([request]) => String(request).startsWith(url))).toBe(true);
  });
  test('untested instances are not reported as up', () => {
    const report = new SourcePipeline({}).getHealthReport();
    expect(report.sources.youtube.healthy).toBe(0);
    expect(report.instances.find(row => row.source === 'youtube').status).toBe('untested');
  });
});
