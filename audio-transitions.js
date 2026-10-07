(function(root) {
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  function analyze(samples, sampleRate) {
    const step = Math.max(1, Math.round(sampleRate * .05));
    const energy = [];
    for (let i = 0; i < samples.length; i += step) {
      let sum = 0; const end = Math.min(i + step, samples.length);
      for (let j = i; j < end; j++) sum += samples[j] * samples[j];
      energy.push(Math.sqrt(sum / (end - i)));
    }
    const duration = samples.length / sampleRate;
    const rms = Math.sqrt(energy.reduce((s, e) => s + e * e, 0) / (energy.length || 1));
    const threshold = Math.max(.003, rms * .04);
    const first = energy.findIndex(e => e > threshold);
    let last = energy.length - 1;
    while (last >= 0 && energy[last] <= threshold) last--;
    const intro = first < 0 ? 0 : Math.min(5, first * .05);
    const end = last < 0 ? duration : Math.max(duration - 5, Math.min(duration, (last + 1) * .05));
    const tail = energy.slice(Math.max(0, Math.floor((end - 8) / .05)), Math.ceil(end / .05));
    const tailRms = Math.sqrt(tail.reduce((s, e) => s + e * e, 0) / (tail.length || 1));
    // Positive energy changes estimate pulse periodicity; ambiguous material stays unaligned.
    const onset = energy.map((e, i) => Math.max(0, e - (energy[i - 1] || e)));
    let best = 0, lag = 0;
    for (let k = 7; k <= 20; k++) {
      let dot = 0, aa = 0, bb = 0;
      for (let i = k; i < onset.length; i++) { dot += onset[i] * onset[i-k]; aa += onset[i] ** 2; bb += onset[i-k] ** 2; }
      const score = dot / (Math.sqrt(aa * bb) || 1);
      if (score > best) { best = score; lag = k; }
    }
    if (Math.max(...onset) < rms * .03) best = 0;
    const beatPeriod = lag * .05;
    const waveform = [];
    const chunk = Math.max(1,Math.ceil(energy.length/1200));
    for (let i=0;i<energy.length;i+=chunk) {
      const slice = energy.slice(i,i+chunk);
      waveform.push(Math.sqrt(slice.reduce((sum,v)=>sum+v*v,0)/slice.length));
    }
    let phase = 0, peak = 0;
    for (let i = 0; i < Math.min(onset.length, 200); i++) if (onset[i] > peak) { peak = onset[i]; phase = i * .05; }
    return { duration, intro, end, rms, tailRms, beatPeriod, beatPhase: phase, beatConfidence: best, waveform };
  }
  function plan(outgoing, incoming, duration, fallback = 6) {
    const end = Math.min(duration, outgoing?.end || duration);
    const ratio = outgoing?.rms > 0 ? outgoing.tailRms / outgoing.rms : 1;
    let overlap = clamp(ratio < .6 ? 9 : ratio > 1.1 ? 3 : 6, 3, 10);
    if (!outgoing || !incoming) overlap = clamp(fallback, 3, 10);
    overlap = Math.min(overlap, Math.max(.5, duration / 4));
    let start = Math.max(0, end - overlap);
    const compatible = outgoing?.beatConfidence > .75 && incoming?.beatConfidence > .75
      && outgoing.beatPeriod > 0 && Math.abs(outgoing.beatPeriod - incoming.beatPeriod) / outgoing.beatPeriod < .08;
    if (compatible) {
      const aligned = outgoing.beatPhase + Math.round((start - outgoing.beatPhase) / outgoing.beatPeriod) * outgoing.beatPeriod;
      start = clamp(aligned, Math.max(0, start - .5), end - .5);
    }
    return { start, overlap: end - start, cue: incoming?.intro || 0, beatAligned: !!compatible };
  }
  function gains(progress) { const t = clamp(progress, 0, 1); return [Math.cos(t * Math.PI / 2), Math.sin(t * Math.PI / 2)]; }
  const api = { analyze, plan, gains };
  root.AudioTransitions = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
