import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const UI = require('../ui-resilience');
afterEach(() => vi.unstubAllGlobals());
describe('browser failure handling', () => {
  it('display clock works before initial server state arrives', () => {
    const html = fs.readFileSync('display.html', 'utf8');
    const clock = html.match(/function updateClock\(\) \{[\s\S]*?\n\}/)[0];
    const elements = {};
    const context = { window: {}, document: { getElementById: id => elements[id] ||= {} } };
    expect(() => vm.runInNewContext(clock + '; updateClock();', context)).not.toThrow();
    expect(elements.clock.textContent).toBeTruthy();
  });
  it('survives blocked browser storage', () => {
    vi.stubGlobal('localStorage', { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
    expect(UI.readPreference('theme')).toBeNull();
    expect(() => UI.writePreference('theme', 'dark')).not.toThrow();
  });
  it('rejects server errors before parsing them as successful settings', async () => {
    const json = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json }));
    await expect(UI.requestJSON('/api/config')).rejects.toThrow('500');
    expect(json).not.toHaveBeenCalled();
  });
  it('supplies a timeout and preserves POST body', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetch);
    await expect(UI.requestJSON('/api/config', { method: 'POST', body: '{}' })).resolves.toEqual({ ok: true });
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{}', signal: expect.any(AbortSignal) });
  });
  it('propagates malformed JSON and network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('invalid JSON'); } }));
    await expect(UI.requestJSON('/api/config')).rejects.toThrow('invalid JSON');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(UI.requestJSON('/api/config')).rejects.toThrow('offline');
  });
});
