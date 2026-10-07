'use strict';
const BASE = 'https://api.audius.co/v1';
const validID = id => /^[a-zA-Z0-9]+$/.test(String(id));
function normalizeTracks(data) {
  if (!Array.isArray(data)) throw new Error('Invalid Audius search response');
  return data.filter(t => validID(t.id) && t.is_streamable !== false && !t.is_stream_gated && !t.is_delete && !t.is_unlisted && t.duration > 0 && t.duration <= 600)
    .slice(0, 8).map(t => ({ videoId: `audius:${t.id}`, title: t.title || 'Unknown', author: t.user?.name || 'Unknown', lengthSeconds: t.duration,
      artwork: t.artwork?.['480x480'] || t.artwork?.['150x150'] || '', _source: 'audius' }));
}
async function searchAudius(query) {
  const url = new URL(`${BASE}/tracks/search`);
  url.searchParams.set('query', query);
  url.searchParams.set('limit', '30');
  url.searchParams.set('app_name', 'AutoDJ');
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Audius search HTTP ${r.status}`);
  return normalizeTracks((await r.json()).data);
}
async function resolveAudius(id) {
  const trackID = String(id).replace(/^audius:/, '');
  if (!validID(trackID)) throw new Error('Invalid Audius track ID');
  const r = await fetch(`${BASE}/tracks/${trackID}?app_name=AutoDJ`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Audius track HTTP ${r.status}`);
  const data = (await r.json()).data;
  const track = Array.isArray(data) ? data[0] : data;
  if (!track || track.is_streamable === false || track.is_stream_gated || track.is_delete) throw new Error('Audius track is unavailable or gated');
  return `${BASE}/tracks/${trackID}/stream?app_name=AutoDJ`;
}
module.exports = { searchAudius, resolveAudius, normalizeTracks };
