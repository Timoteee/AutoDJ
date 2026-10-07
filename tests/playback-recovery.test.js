const { isAudioHeader } = require('../lib/audio-file');
const { RetryManager } = require('../lib/retry-manager');
const { alternativeCandidates } = require('../lib/alternate-source');
test('valid binary WebM is accepted while HTML is rejected', () => {
  const webm = Buffer.alloc(16); Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(webm);
  expect(isAudioHeader(webm)).toBe(true);
  expect(isAudioHeader(Buffer.from('<!DOCTYPE html><html>403</html>'))).toBe(false);
});
test.each(['ID3', 'OggS', 'fLaC', 'RIFF'])('recognizes %s audio headers', header => {
  const buf = Buffer.alloc(16); buf.write(header); expect(isAudioHeader(buf)).toBe(true);
});
test('interrupted downloads return to the retry queue after restart', () => {
  const retry = new RetryManager();
  try {
    retry.load([{ videoId: 'interrupted', status: 'downloading', nextRetry: 0 }]);
    expect(retry.getEntries()[0].status).toBe('queued');
  } finally { retry.stop(); }
});
test('alternate uploads preserve song identity and exclude remixes and unrelated artists', () => {
  const hits = [
    { videoId: 'aaaaaaaaaaa', title: 'Future - I Serve the Base (Audio)', author: 'Future' },
    { videoId: 'bbbbbbbbbbb', title: 'Future - I Serve the Base Remix', author: 'Future' },
    { videoId: 'ccccccccccc', title: 'I Serve the Base', author: 'Other artist' },
    { videoId: 'ddddddddddd', title: 'Future - I Serve the Base (Lyrics)', author: 'Lyrics channel' },
  ];
  expect(alternativeCandidates(hits, { videoId: 'aaaaaaaaaaa', title: 'I Serve the Base', artist: 'Future' }).map(t => t.videoId)).toEqual(['ddddddddddd']);
});
