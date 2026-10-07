'use strict';
const { parseSearch } = require('./youtube-search');
async function validateProbe(source, response) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (source === 'youtube') { parseSearch(await response.text()); return; }
  if (source === 'metube') return;
  const data = await response.json();
  const valid = source === 'invidious' ? Array.isArray(data)
    : source === 'piped' ? Array.isArray(data.items)
    : source === 'audius' ? Array.isArray(data.data)
    : source === 'jamendo' ? Array.isArray(data.results) && data.headers?.status !== 'failed'
    : source === 'dab' ? Array.isArray(data.tracks || data.results || data) : true;
  if (!valid) throw new Error('Invalid search response');
}
module.exports = { validateProbe };
