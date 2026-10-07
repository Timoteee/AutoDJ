import { test, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

test('listening identifiers work on a plain HTTP LAN origin', () => {
  const context = { crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } };
  vm.runInNewContext(fs.readFileSync('ui-resilience.js', 'utf8'), context);
  const ids = Array.from({ length: 50 }, () => context.AutoDJUI.createEventId());
  expect(new Set(ids).size).toBe(50);
  expect(ids.every(id => /^[a-f0-9-]{36}$/.test(id))).toBe(true);
});

test('a pending download cannot publish playback after a stop or client reset', async () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const fn = source.slice(source.indexOf('async function advanceTrack()'), source.indexOf('\n}', source.indexOf('async function advanceTrack()')) + 2);
  let resolveDownload;
  const state = { queue: [{ youtubeId: 'aaaaaaaaaaa', title: 'Test' }], trackIndex: -1 };
  const commands = [];
  const context = { config: {}, sharedState: state, audioCache: [], fs, PORT: 3000, AbortSignal,
    playbackRevision: 0, fetch: () => new Promise(resolve => { resolveDownload = resolve; }),
    log() {}, broadcastCommand: (...args) => commands.push(args), saveQueueToDisk() {},
    preloadUpcoming() {}, sseClients: new Map([[1, {}]]), stopPlayback() {} };
  vm.runInNewContext(fn, context);
  const pending = context.advanceTrack();
  state.nowPlaying = null;
  state.sessionActive = false;
  resolveDownload({ ok: true, json: async () => ({ url: '/audio.mp3' }) });
  await expect(pending).resolves.toBe(false);
  expect(commands).toEqual([]);
});
