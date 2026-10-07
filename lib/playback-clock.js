function playbackSnapshot(track, playing, updatedAt, now = Date.now()) {
  if (!track) return null;
  const baseline = Math.max(0, Number(track.elapsed) || 0);
  let elapsed = baseline + (playing ? Math.max(0, now - updatedAt) / 1000 : 0);
  if (Number.isFinite(track.duration) && track.duration > 0) elapsed = Math.min(track.duration, elapsed);
  return { ...track, elapsed };
}
module.exports = { playbackSnapshot };
