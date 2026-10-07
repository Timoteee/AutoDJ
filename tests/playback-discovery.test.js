const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const os = require('node:os');
const { effectiveProvider, recommend } = require('../lib/ai-recommendations');
const { discover } = require('../lib/discovery-recommendations');
const { downloadYouTube } = require('../lib/youtube-downloader');
const UI = require('../ui-resilience');
test('missing selected AI key falls back to a configured provider', () => {
  expect(effectiveProvider({ aiProvider: 'openai', openrouterKey: 'test' })).toBe('openrouter');
  expect(effectiveProvider({ aiProvider: 'openai', openaiKey: 'test', openrouterKey: 'test' })).toBe('openai');
  expect(effectiveProvider({})).toBeNull();
});
test('AI validates shape and reports provider errors', async () => {
  const config = { aiProvider: 'openai', openrouterKey: 'test' };
  await expect(recommend(config, {}, async () => ({ ok: false, status: 401 }))).rejects.toThrow('openrouter');
  await expect(recommend(config, {}, async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"not":"an array"}' } }] }) }))).rejects.toThrow('array');
});
test('Last.fm suggestions fall back from missing similar tracks to artist tracks', async () => {
  const recommendations = await discover({ artist: 'Alicia Keys', title: 'Un-Thinkable', key: 'test' }, async url => {
    const method = url.searchParams.get('method');
    return { ok: true, json: async () => method === 'track.getsimilar' ? { similartracks: { track: [] } }
      : method === 'artist.getsimilar' ? { similarartists: { artist: [{ name: 'Sade' }] } }
      : { toptracks: { track: [{ name: 'Test song', artist: { name: url.searchParams.get('artist') } }] } } };
  });
  expect(recommendations.map(track => track.artist)).toEqual(['Alicia Keys', 'Sade']);
});
test('manual track names become valid discovery seeds', () => {
  expect(UI.seedTitle("Alicia Keys - Un-Thinkable (I'm Ready) Remix feat. Drake (Official Audio)", 'Alicia Keys')).toBe("Un-Thinkable (I'm Ready)");
});
test('Last.fm milliseconds are converted to seconds in browser metadata', async () => {
  const source = fs.readFileSync('engine.js', 'utf8').match(/async function getTrackInfo\(artist, track\) \{[\s\S]*?\n  \}/)[0];
  const context = { lfm: async () => ({ track: { duration: '278000' } }) };
  vm.runInNewContext(source, context);
  expect((await context.getTrackInfo('Alicia Keys', 'Test')).duration).toBe(278);
});
test('local downloader confines returned files and uses bounded shell-free execution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autodj-download-test-'));
  try {
    const result = await downloadYouTube('AEZLbq5o4AE', root, { execFileImpl: (binary, args, options, callback) => {
      expect(options).toMatchObject({ timeout: 90000, shell: false, windowsHide: true });
      const output = args[args.indexOf('-o') + 1].replace('%(ext)s', 'm4a');
      fs.writeFileSync(output, Buffer.alloc(1200));
      callback(null, output);
    } });
    expect(result.size).toBe(1200);
    await expect(downloadYouTube('AEZLbq5o4AE', root, { execFileImpl: (binary, args, options, cb) => cb(null, 'C:/outside.m4a') })).rejects.toThrow('failed');
    expect(await downloadYouTube('../invalid', root)).toBeNull();
  } finally { for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file)); fs.rmdirSync(root); }
});
