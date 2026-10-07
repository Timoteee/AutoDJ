import { describe, it, expect, vi } from 'vitest';
import vm from 'node:vm';
import fs from 'node:fs';
const source = fs.readFileSync('sw.js', 'utf8');
function worker({ fetch = vi.fn(), cached } = {}) {
  const handlers = {};
  const cache = { addAll: vi.fn().mockResolvedValue(), put: vi.fn().mockResolvedValue(), match: vi.fn().mockResolvedValue(cached) };
  const caches = { open: vi.fn().mockResolvedValue(cache), keys: vi.fn().mockResolvedValue(['autodj-v7-shell', 'another-app', 'autodj-v8-shell']), delete: vi.fn().mockResolvedValue(true) };
  vm.runInNewContext(source, { self: { location: { origin: 'http://localhost' }, clients: { claim: vi.fn() }, skipWaiting: vi.fn(), addEventListener: (name, fn) => { handlers[name] = fn; } }, caches, fetch, URL, Response });
  return { handlers, caches, cache };
}
describe('offline shell', () => {
  it('pre-caches existing assets and surfaces install failures', async () => {
    const { handlers, cache } = worker();
    let promise;
    handlers.install({ waitUntil(p) { promise = p; } });
    await promise;
    for (const url of cache.addAll.mock.calls[0][0]) {
      if (!['/dj', '/display', '/display/nano'].includes(url)) expect(fs.existsSync('.' + url)).toBe(true);
    }
    cache.addAll.mockRejectedValue(new Error('asset missing'));
    handlers.install({ waitUntil(p) { promise = p; } });
    await expect(promise).rejects.toThrow('asset missing');
  });
  it('removes only old AutoDJ caches', async () => {
    const { handlers, caches } = worker();
    let promise;
    handlers.activate({ waitUntil(p) { promise = p; } });
    await promise;
    expect(caches.delete.mock.calls).toEqual([['autodj-v7-shell'], ['autodj-v8-shell']]);
  });
  it('does not intercept API, POST, range, or foreign requests', () => {
    const { handlers } = worker();
    for (const [url, method, headers] of [
      ['http://localhost/api/config', 'GET', {}], ['http://localhost/dj', 'POST', {}],
      ['http://localhost/dj', 'GET', { range: 'bytes=0-99' }], ['https://other.test/dj', 'GET', {}],
    ]) {
      const respondWith = vi.fn();
      handlers.fetch({ request: new Request(url, { method, headers }), respondWith });
      expect(respondWith).not.toHaveBeenCalled();
    }
  });
  it('uses cached pages offline and returns 503 on a cache miss', async () => {
    for (const cached of [undefined, new Response('cached page')]) {
      const { handlers } = worker({ fetch: vi.fn().mockRejectedValue(new Error('offline')), cached });
      let promise;
      handlers.fetch({ request: new Request('http://localhost/dj'), respondWith(p) { promise = p; } });
      expect((await promise).status).toBe(cached ? 200 : 503);
    }
  });
  it('refreshes cached CSS from the network', async () => {
    const { handlers, cache } = worker({ fetch: vi.fn().mockResolvedValue(new Response('new styles')) });
    let promise;
    handlers.fetch({ request: new Request('http://localhost/css/console.css'), respondWith(p) { promise = p; } });
    expect(await (await promise).text()).toBe('new styles');
    expect(cache.put).toHaveBeenCalledOnce();
  });
});
