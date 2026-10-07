const { analyze, plan, gains } = require('../audio-transitions');
const { DownloadQueue } = require('../lib/download-queue');
test('detects bounded leading/trailing silence from actual PCM', () => {
  const sr = 1000, samples = new Float32Array(sr * 30);
  for (let i = sr * 2; i < sr * 28; i++) samples[i] = Math.sin(i * .1) * .2;
  const profile = analyze(samples, sr);
  expect(profile.intro).toBeCloseTo(2, 1);
  expect(profile.end).toBeCloseTo(28, 1);
  expect(profile.rms).toBeGreaterThan(.1);
  expect(plan(profile, profile, 30).start).toBeLessThan(28);
});
test('quiet tails get longer overlaps, dense tails get shorter overlaps', () => {
  expect(plan({ rms: .2, tailRms: .05 }, {}, 180).overlap).toBe(9);
  expect(plan({ rms: .2, tailRms: .3 }, {}, 180).overlap).toBe(3);
  expect(plan(null, null, 4).overlap).toBeLessThanOrEqual(1);
});
test('equal-power fades preserve power in both directions', () => {
  for (const t of [0, .25, .5, .75, 1]) {
    const [a, b] = gains(t); expect(a*a + b*b).toBeCloseTo(1, 8);
    expect(gains(1-t)[0]).toBeCloseTo(b, 8);
  }
});
test('beat alignment requires confidence and compatible pulse rates', () => {
  const profile = { rms: .2, tailRms: .2, beatConfidence: .9, beatPeriod: .5, beatPhase: .2 };
  expect(plan(profile, profile, 180).beatAligned).toBe(true);
  expect(plan(profile, { ...profile, beatConfidence: .2 }, 180).beatAligned).toBe(false);
  expect(plan(profile, { ...profile, beatPeriod: .8 }, 180).beatAligned).toBe(false);
});
test('background downloads deduplicate work and bound concurrency even after failure', async () => {
  let active = 0, max = 0; const calls = [];
  const queue = new DownloadQueue(async t => {
    calls.push(t); active++; max = Math.max(max, active);
    await new Promise(r => setTimeout(r, 10)); active--; if (t === 'b') throw Error('provider down');
  }, 2);
  const first = queue.add('a', 'a'); expect(queue.add('a', 'a')).toBe(first);
  await Promise.all([first, queue.add('b', 'b'), queue.add('c', 'c')]);
  expect(calls).toEqual(['a', 'b', 'c']); expect(max).toBe(2); expect(queue.jobs.size).toBe(0);
});
