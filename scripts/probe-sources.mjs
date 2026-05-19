/**
 * One-off probe: hit each configured source with real queries (no server).
 * Run: node scripts/probe-sources.mjs
 */
const UA = { 'User-Agent': 'AutoDJ-source-probe/1' };
const timeout = (ms) => AbortSignal.timeout(ms);

async function probe(name, url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: timeout(15000), headers: UA });
    const ms = Date.now() - t0;
    const ct = r.headers.get('content-type') || '';
    let detail = '';
    if (r.ok && ct.includes('json')) {
      const d = await r.json();
      if (Array.isArray(d)) detail = `videos=${d.length}`;
      else if (d.items) detail = `items=${d.items?.length ?? 0}`;
      else if (d.tracks) detail = `tracks=${Array.isArray(d.tracks) ? d.tracks.length : 'obj'}`;
      else if (d.results) detail = `results=${d.results.length}`;
      else detail = `keys=${Object.keys(d).slice(0, 6).join(',')}`;
    } else detail = ct.slice(0, 30);
    console.log(`${name}\t${r.status}\t${ms}ms\t${detail}`);
  } catch (e) {
    console.log(`${name}\tERR\t\t${e.message}`);
  }
}

const q1 = encodeURIComponent('Drake Good Ones Go');
const q2 = encodeURIComponent('Kashif Stone Love');

console.log('\n=== Query: Drake Good Ones Go ===\n');
await probe('dab-q', `https://dabmusic.xyz/api/search?q=${q1}&type=track&limit=3`);
await probe('dab-yeet-q', `https://dab.yeet.su/api/search?q=${q1}&type=track&limit=3`);
await probe('hifi-wolf', `https://wolf.qqdl.site/search/?query=${q1}&type=track&limit=3`);
await probe('piped-kavin', `https://pipedapi.kavin.rocks/search?q=${q1}&filter=videos`);
await probe('piped-adminforge', `https://pipedapi.adminforge.de/search?q=${q1}&filter=videos`);
await probe('piped-yt', `https://api.piped.yt/search?q=${q1}&filter=videos`);
await probe('inv-nadeko', `https://inv.nadeko.net/api/v1/search?q=${q1}&type=video`);
await probe('inv-yewtu', `https://yewtu.be/api/v1/search?q=${q1}&type=video`);

console.log('\n=== Query: Kashif Stone Love ===\n');
await probe('dab-q2', `https://dabmusic.xyz/api/search?q=${q2}&type=track&limit=3`);
await probe('piped-kavin2', `https://pipedapi.kavin.rocks/search?q=${q2}&filter=videos`);
await probe('inv-nadeko2', `https://inv.nadeko.net/api/v1/search?q=${q2}&type=video`);

console.log('\n=== Extra Piped / Invidious instances ===\n');
const extras = [
  ['piped-leptons', `https://pipedapi.leptons.xyz/search?q=${q1}&filter=videos`],
  ['piped-privacy', `https://piped-api.privacy.com.de/search?q=${q1}&filter=videos`],
  ['inv-nerdvpn', `https://invidious.nerdvpn.de/api/v1/search?q=${q1}&type=video`],
  ['inv-pixora', `https://inv.thepixora.com/api/v1/search?q=${q1}&type=video`],
];
for (const [n, u] of extras) await probe(n, u);
