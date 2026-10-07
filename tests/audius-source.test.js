const { normalizeTracks, resolveAudius } = require('../lib/audius-source');
afterEach(() => vi.unstubAllGlobals());
test('Audius IDs stay distinct and exclude gated/unavailable tracks', () => {
  const track = { id: 'ABC123', title: 'Nokia remix', user: { name: 'Artist' }, duration: 198, is_streamable: true };
  const hits = normalizeTracks([track, { ...track, is_stream_gated: true }, { ...track, is_streamable: false }, { ...track, duration: 3600 }]);
  expect(hits).toEqual([expect.objectContaining({ videoId: 'audius:ABC123', _source: 'audius', lengthSeconds: 198 })]);
});
test('Audius resolves validated tracks to owned stream URLs', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ is_streamable: true }] }) }));
  await expect(resolveAudius('audius:ABC123')).resolves.toBe('https://api.audius.co/v1/tracks/ABC123/stream?app_name=AutoDJ');
  await expect(resolveAudius('audius:../../config')).rejects.toThrow('Invalid');
});
test('Audius rejects gated streams', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ is_stream_gated: true }] }) }));
  await expect(resolveAudius('audius:ABC123')).rejects.toThrow('gated');
});
