'use strict';

function initialData(html) {
  const marker = /(?:var\s+ytInitialData|window\["ytInitialData"\]|ytInitialData)\s*=\s*/g;
  const match = marker.exec(html);
  if (!match) throw new Error('YouTube search metadata unavailable');
  const start = html.indexOf('{', marker.lastIndex);
  if (start < 0) throw new Error('YouTube search metadata malformed');
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error('YouTube search metadata truncated');
}

function parseSearch(html, limit = 8) {
  const data = initialData(html);
  if (!data.contents) throw new Error('YouTube search response has no contents');
  const text = value => value?.simpleText || value?.runs?.map(run => run.text || '').join('') || '';
  const pending = [data.contents], hits = [], seen = new Set();
  let visited = 0;
  while (pending.length && hits.length < limit && visited++ < 50000) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    const video = node.videoRenderer;
    if (video && /^[\w-]{11}$/.test(video.videoId) && !seen.has(video.videoId)) {
      seen.add(video.videoId);
      const duration = text(video.lengthText);
      const parts = duration.split(':').map(Number);
      const seconds = duration && parts.every(Number.isFinite) ? parts.reduce((sum, part) => sum * 60 + part, 0) : 0;
      // Live streams and scheduled videos have no finite music-track duration.
      if (seconds > 0 && seconds <= 600) hits.push({
        videoId: video.videoId,
        title: text(video.title),
        author: text(video.ownerText || video.longBylineText || video.shortBylineText),
        lengthSeconds: seconds,
        artwork: `https://img.youtube.com/vi/${video.videoId}/mqdefault.jpg`,
        _source: 'youtube',
      });
    }
    // Reverse preserves the displayed search ranking with a stack.
    for (const value of Object.values(node).reverse()) pending.push(value);
  }
  return hits;
}

async function searchYouTube(query, { fetchImpl = fetch } = {}) {
  const url = new URL('https://www.youtube.com/results');
  url.searchParams.set('search_query', query);
  url.searchParams.set('hl', 'en');
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(8000),
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!response.ok) throw new Error(`YouTube search HTTP ${response.status}`);
  const html = await response.text();
  if (html.length > 5_000_000) throw new Error('YouTube search response too large');
  return parseSearch(html);
}
module.exports = { parseSearch, searchYouTube };
