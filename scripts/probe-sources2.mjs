const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Accept: 'application/json,*/*' };
const timeout = (ms) => AbortSignal.timeout(ms);

async function probe(name, url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: timeout(18000), headers: UA });
    const ms = Date.now() - t0;
    const ct = r.headers.get('content-type') || '';
    let detail = '';
    if (r.ok && ct.includes('json')) {
      const d = await r.json();
      if (Array.isArray(d)) detail = `arr=${d.length}`;
      else if (d.items) detail = `items=${d.items?.length ?? 0}`;
      else if (d.tracks) detail = `tracks=${Array.isArray(d.tracks) ? d.tracks.length : 'obj'}`;
      else if (d.results) detail = `results=${d.results.length}`;
      else detail = `keys=${Object.keys(d).slice(0, 8).join(',')}`;
    } else detail = (await r.text()).slice(0, 80).replace(/\s+/g, ' ');
    console.log(`${name}\t${r.status}\t${ms}ms\t${detail}`);
  } catch (e) {
    console.log(`${name}\tERR\t\t${e.cause?.code || ''} ${e.message}`);
  }
}

const q = encodeURIComponent('Drake Good Ones Go');
console.log('Query:', decodeURIComponent(q), '\n');

const pipedBases = [
  'https://pipedapi.privacyredirect.com',
  'https://pipedapi.syncpundit.com',
  'https://pipedapi.moomoo.me',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.r4fo.com',
  'https://pipedapi.osl.vi.no',
  'https://api-piped.privacy.com.de',
  'https://pipedapi.in.projectsegfau.lt',
];

const invBases = [
  'https://inv.thepixora.com',
  'https://invidious.protokolla.fi',
  'https://invidious.flokinet.to',
  'https://inv.based.directory',
  'https://invidious.privacyredirect.com',
  'https://vid.puffyan.us',
  'https://invidious.0011.lt',
];

for (const b of pipedBases) {
  await probe('piped ' + b.replace('https://', ''), `${b}/search?q=${q}&filter=videos`);
}
console.log('');
for (const b of invBases) {
  await probe('inv ' + b.replace('https://', ''), `${b}/api/v1/search?q=${q}&type=video`);
}

console.log('\nDAB with browser UA:');
await probe('dab', `https://dabmusic.xyz/api/search?q=${q}&type=track&limit=3`);
