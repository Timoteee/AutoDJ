const { parseSearch, searchYouTube } = require('../lib/youtube-search');
const fs = require('node:fs');
const vm = require('node:vm');
const video = (id, title = 'Drake — Test', length = '3:21') => ({ videoRenderer: { videoId: id, title: { runs: [{ text: title }] }, ownerText: { runs: [{ text: 'Drake' }] }, lengthText: { simpleText: length } } });
const html = contents => '<script>var ytInitialData = ' + JSON.stringify({ contents }) + ';</script>';
test('parses ranked finite tracks with braces and escaped quotes in titles', () => {
  const result = parseSearch(html([video('abcdefghijk', 'Drake {"title"}'), video('12345678901')]));
  expect(result.map(r => r.videoId)).toEqual(['abcdefghijk', '12345678901']);
  expect(result[0]).toMatchObject({ title: 'Drake {"title"}', author: 'Drake', lengthSeconds: 201, _source: 'youtube' });
});
test('rejects consent pages and malformed responses', () => {
  expect(() => parseSearch('<html>Consent required</html>')).toThrow('metadata unavailable');
  expect(() => parseSearch('var ytInitialData = {')).toThrow('truncated');
});
test('filters invalid IDs, duplicate results, live streams and long videos', () => {
  expect(parseSearch(html([video('invalid'), video('abcdefghijk'), video('abcdefghijk'), video('12345678901', 'Live', ''), video('aaaaaaaaaaa', 'Long', '1:30:00')]))).toHaveLength(1);
});
test('reports no matches only for valid empty search contents', () => {
  expect(parseSearch(html([]))).toEqual([]);
});
test('rejects HTTP errors and safely encodes query text', async () => {
  let requested;
  await expect(searchYouTube('Drake & Future', { fetchImpl: async url => { requested = url; return { ok: false, status: 429 }; } })).rejects.toThrow('429');
  expect(requested.searchParams.get('search_query')).toBe('Drake & Future');
});
test('Topic filtering does not discard artists with trailing spaces', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const fn = server.match(/function filterTopicResults\(results\) \{[\s\S]*?\n\}/)[0];
  const context = { config: { filterTopicChannels: true }, log() {}, hits: [{ author: 'Artist ' }, { author: 'Artist - Topic' }] };
  vm.runInNewContext(fn + '; filtered = filterTopicResults(hits);', context);
  expect(context.filtered).toEqual([{ author: 'Artist ' }]);
});
