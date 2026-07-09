const { RetryManager } = require('../lib/retry-manager');

describe('RetryManager', () => {
  let manager;

  beforeEach(() => {
    manager = new RetryManager({ maxAttempts: 2, backoff: [30000, 300000], pollInterval: 100 });
  });

  test('register creates entry with queued status', () => {
    manager.register('vid1', 'Song A', 'Artist A', 'invidious');
    const entries = manager.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('queued');
    expect(entries[0].videoId).toBe('vid1');
  });

  test('onDownloadFailed schedules first retry', () => {
    manager.register('vid1', 'Test', 'Artist', 'invidious');
    manager.onDownloadFailed('vid1');

    const entry = manager.getEntries()[0];
    expect(entry.attempt).toBe(1);
    expect(entry.status).toBe('retrying');
    expect(entry.nextRetry).toBeGreaterThan(Date.now());
  });

  test('exhausted after maxAttempts retries', () => {
    manager.register('vid1', 'Test', 'Artist', 'invidious');
    manager.onDownloadFailed('vid1'); // attempt 1
    manager.onDownloadFailed('vid1'); // attempt 2 = maxAttempts -> exhausted

    const entry = manager.getEntries()[0];
    expect(entry.attempt).toBe(2);
    expect(entry.status).toBe('exhausted');
  });

  test('onDownloadSuccess removes entry', () => {
    manager.register('vid1', 'Test', 'Artist', 'invidious');
    expect(manager.getEntries()).toHaveLength(1);
    manager.onDownloadSuccess('vid1');
    expect(manager.getEntries()).toHaveLength(0);
  });

  test('manual retry resets counter', () => {
    manager.register('vid1', 'Test', 'Artist', 'invidious');
    manager.onDownloadFailed('vid1'); // attempt 1
    manager.onDownloadFailed('vid1'); // attempt 2 -> exhausted

    const retried = manager.retry('vid1');
    expect(retried).toBe(true);

    const entry = manager.getEntries()[0];
    expect(entry.attempt).toBe(0);
    expect(entry.status).toBe('queued');
  });

  test('manual retry returns false for unknown videoId', () => {
    expect(manager.retry('unknown')).toBe(false);
  });

  test('status callbacks fire correctly', () => {
    const statuses = [];
    manager.setStatusHandler((videoId, status, attempt) => {
      statuses.push({ videoId, status, attempt });
    });

    manager.register('vid1', 'Test', 'Artist', 'invidious');
    manager.onDownloadFailed('vid1');
    manager.onDownloadFailed('vid1');

    expect(statuses).toHaveLength(2);
    expect(statuses[0].status).toBe('retrying');
      expect(statuses[1].status).toBe('exhausted');
  });

  test('success callback fires', () => {
    const statuses = [];
    manager.setStatusHandler((videoId, status) => statuses.push({ videoId, status }));

    manager.register('vid1', 'Test', 'Artist', 'invidious');
    manager.onDownloadSuccess('vid1');

    expect(statuses).toHaveLength(1);
    expect(statuses[0].status).toBe('completed');
  });

  test('getByStatus filters correctly', () => {
    manager.register('vid1', 'Test', 'Artist', 'invidious');
    manager.register('vid2', 'Test 2', 'Artist', 'invidious');
    manager.onDownloadFailed('vid1');

    expect(manager.getByStatus('queued')).toHaveLength(1);
    expect(manager.getByStatus('retrying')).toHaveLength(1);
  });

  test('clearCompleted removes exhausted entries', () => {
    manager.register('vid1', 'Test', 'Artist', 'invidious');
    manager.register('vid2', 'Test 2', 'Artist', 'invidious');
    manager.onDownloadFailed('vid1');
    manager.onDownloadFailed('vid1'); // exhausted

    manager.clearCompleted();
    expect(manager.getEntries()).toHaveLength(1); // vid2 still queued
  });

  test('remove deletes specific entry', () => {
    manager.register('vid1', 'Test', 'Artist', 'invidious');
    manager.remove('vid1');
    expect(manager.getEntries()).toHaveLength(0);
  });

  test('stop clears polling interval', () => {
    manager.stop();
    // No crash - timer is cleared
    manager.stop(); // should be safe to call twice
  });
});