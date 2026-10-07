'use strict';
async function discover({ artist, title, key, limit = 8 }, fetchImpl = fetch) {
  if (!artist) throw new Error('Choose an artist or queue a track before requesting suggestions');
  if (!key) return [];
  async function lastfm(method, params) {
    const url = new URL('https://ws.audioscrobbler.com/2.0/');
    for (const [name, value] of Object.entries({ method, ...params, api_key: key, format: 'json' })) url.searchParams.set(name, value);
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`Last.fm HTTP ${r.status}`);
    const data = await r.json();
    if (data.error) throw new Error(data.message || `Last.fm error ${data.error}`);
    return data;
  }
  let tracks = [];
  if (title) {
    try { const data = await lastfm('track.getsimilar', { artist, track: title, limit }); tracks = data.similartracks?.track || []; } catch { /* Fall back to artist recommendations. */ }
  }
  if (!tracks.length) {
    const similar = await lastfm('artist.getsimilar', { artist, limit: 3 });
    const artists = [artist, ...(similar.similarartists?.artist || []).map(a => a.name)].slice(0, 3);
    const batches = await Promise.allSettled(artists.map(async name => {
      const data = await lastfm('artist.gettoptracks', { artist: name, limit: 3 });
      return data.toptracks?.track || [];
    }));
    tracks = batches.flatMap(batch => batch.status === 'fulfilled' ? batch.value : []);
  }
  const seen = new Set();
  return tracks.map(track => ({ title: track.name, artist: track.artist?.name || artist, duration: 0, reason: 'Last.fm similar music' }))
    .filter(track => {
      if (!track.title || !track.artist) return false;
      const id = `${track.artist.toLowerCase()}::${track.title.toLowerCase()}`;
      if (seen.has(id) || (track.artist.toLowerCase() === artist.toLowerCase() && track.title.toLowerCase() === (title || '').toLowerCase())) return false;
      seen.add(id); return true;
    }).slice(0, limit);
}
module.exports = { discover };
