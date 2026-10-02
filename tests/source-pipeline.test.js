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
      return { ok: true };
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
});
