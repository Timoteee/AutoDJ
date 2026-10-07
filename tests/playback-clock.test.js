const { playbackSnapshot } = require('../lib/playback-clock');
test('headless metadata keeps time without restarting the relay on unrelated broadcasts', () => {
  const track = { title: 'Song', duration: 200, elapsed: 12 };
  expect(playbackSnapshot(track, true, 1000, 6000).elapsed).toBe(17);
  expect(track.elapsed).toBe(12);
  expect(playbackSnapshot(track, true, 1000, 300000).elapsed).toBe(200);
});
test('paused snapshots preserve the last audible position', () => {
  expect(playbackSnapshot({ elapsed: 12 }, false, 1000, 6000).elapsed).toBe(12);
  expect(playbackSnapshot(null, true, 1000, 6000)).toBeNull();
});
