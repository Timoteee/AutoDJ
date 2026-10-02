const { PreloadGate } = require('../lib/preload-gate');

describe('PreloadGate', () => {
  let gate;

  beforeEach(() => {
    gate = new PreloadGate({ preDownloadCount: 3, preloadTimeoutMs: 10000 });
  });

  test('ready immediately when enough tracks cached', async () => {
    // Manually seed the cache with 3 items
    gate._cached.add('a');
    gate._cached.add('b');
    gate._cached.add('c');
    const result = await gate.waitUntilReady([{ youtubeId: 'a' }, { youtubeId: 'b' }, { youtubeId: 'c' }, { youtubeId: 'd' }]);
    expect(result).toBe('ready');
    expect(gate.getState().status).toBe('ready');
  });

  test('ready when cache fills progressively', async () => {
    const waitPromise = gate.waitUntilReady([
      { youtubeId: 'a' },
      { youtubeId: 'b' },
      { youtubeId: 'c' },
    ]);
    // Should not be ready yet
    expect(gate.getState().status).toBe('waiting');

    // Fill cache one by one
    gate.onCacheUpdated('a', ['a']);
    gate.onCacheUpdated('b', ['a', 'b']);
    gate.onCacheUpdated('c', ['a', 'b', 'c']);

    const result = await waitPromise;
    expect(result).toBe('ready');
    expect(gate.getState().cached).toBe(3);
  });

  test('timeout after waiting', async () => {
    const fastGate = new PreloadGate({ preDownloadCount: 3, preloadTimeoutMs: 100 });
    const result = await fastGate.waitUntilReady([
      { youtubeId: 'a' },
      { youtubeId: 'b' },
      { youtubeId: 'c' },
    ]);
    expect(result).toBe('timeout');
    expect(fastGate.getState().status).toBe('timeout');
  });

  test('getState returns correct shape', () => {
    const state = gate.getState();
    expect(state).toHaveProperty('required');
    expect(state).toHaveProperty('cached');
    expect(state).toHaveProperty('downloading');
    expect(state).toHaveProperty('failed');
    expect(state).toHaveProperty('status');
  });

  test('reset clears state', () => {
    gate._cached.add('a');
    gate._cached.add('b');
    gate._status = 'ready';
    gate._settled = true;
    gate.reset();
    const state = gate.getState();
    expect(state.cached).toBe(0);
    expect(state.status).toBe('waiting');
  });

  test('unrelated cached ids do not satisfy the requested tracks', async () => {
    const fastGate = new PreloadGate({ preDownloadCount: 1, preloadTimeoutMs: 80 });
    fastGate.seedCache(['other']);
    const result = await fastGate.waitUntilReady([{ youtubeId: 'needed' }]);
    expect(result).toBe('timeout');
  });

  test('times out as soon as the required tracks can no longer succeed', async () => {
    const slow = new PreloadGate({ preDownloadCount: 2, preloadTimeoutMs: 30000 });
    const pending = slow.waitUntilReady([{ youtubeId: 'a' }, { youtubeId: 'b' }]);
    slow.markFailed('a');
    const result = await Promise.race([
      pending,
      new Promise(resolve => setTimeout(() => resolve('still-waiting'), 400))
    ]);
    expect(result).toBe('timeout');
  });

  test('keeps waiting while another requested track can still finish', async () => {
    const slow = new PreloadGate({ preDownloadCount: 1, preloadTimeoutMs: 30000 });
    const pending = slow.waitUntilReady([{ youtubeId: 'a' }, { youtubeId: 'b' }]);
    slow.markFailed('a');
    expect(slow.getState().status).toBe('waiting');
    slow.onCacheUpdated('b', ['b']);
    expect(await pending).toBe('ready');
  });

  test('local and temp tracks count as ready', async () => {
    const result = await gate.waitUntilReady([
      { type: 'local', title: 'a' },
      { type: 'temp', title: 'b' },
      { type: 'local', title: 'c' },
    ]);
    expect(result).toBe('ready');
  });

  test('onCacheUpdated removes from failed set', () => {
    gate._failed.add('borked');
    gate.onCacheUpdated('borked', ['new-cache']);
    expect(gate._failed.has('borked')).toBe(false);
  });
});