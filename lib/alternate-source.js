const normalize = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function alternativeCandidates(hits, { videoId, title, artist, filterTopic = false }) {
  const name = normalize(String(title || '').replace(/\((?:official\s+)?(?:audio|video|lyrics?)\)/ig, ''));
  const performer = normalize(artist);
  const song = name.startsWith(performer + ' ') ? name.slice(performer.length + 1) : name;
  if (!song || !performer) return [];
  return hits.filter(hit => {
    if (hit.videoId === videoId || !/^[\w-]{11}$/.test(hit.videoId || '')) return false;
    if (filterTopic && /\s*-\s*Topic\s*$/i.test(hit.author || '')) return false;
    const candidate = normalize(hit.title);
    if (!candidate.includes(song) || !normalize(hit.author + ' ' + hit.title).includes(performer)) return false;
    return !['remix', 'slowed', 'sped', 'cover', 'live', 'instrumental'].some(tag => candidate.split(' ').includes(tag) && !name.split(' ').includes(tag));
  }).slice(0, 2);
}
module.exports = { alternativeCandidates };
