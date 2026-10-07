'use strict';
function effectiveProvider(config) {
  const ready = { openai: !!config.openaiKey, anthropic: !!config.anthropicKey, openrouter: !!config.openrouterKey, opencode: !!config.opencodeKey };
  return ready[config.aiProvider] ? config.aiProvider : ['openrouter', 'openai', 'anthropic', 'opencode'].find(provider => ready[provider]) || null;
}
async function recommend(config, input, fetchImpl = fetch) {
  const provider = effectiveProvider(config);
  if (!provider) throw new Error('No AI provider key configured; use Last.fm suggestions or add a key');
  const prompt = `Recommend 5 songs for DJ mix flow. Return ONLY a JSON array of {title,artist,reason}. Context: ${JSON.stringify(input)}`;
  const providers = {
    openai: { base: 'https://api.openai.com/v1', key: config.openaiKey, model: 'gpt-4o-mini' },
    openrouter: { base: config.openrouterBaseUrl || 'https://openrouter.ai/api/v1', key: config.openrouterKey, model: config.openrouterModel || 'openrouter/auto' },
    opencode: { base: config.opencodeBaseUrl || 'https://api.opencode.ai/v1', key: config.opencodeKey, model: config.opencodeModel || 'opencode-model' },
  };
  let url, headers, body;
  if (provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages';
    headers = { 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
    body = { model: 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] };
  } else {
    const selected = providers[provider];
    url = selected.base.replace(/\/+$/, '') + '/chat/completions';
    headers = { Authorization: `Bearer ${selected.key}`, 'Content-Type': 'application/json' };
    body = { model: selected.model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] };
  }
  const r = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${provider} recommendation request failed (HTTP ${r.status}); check provider credentials, model and credits`);
  const data = await r.json();
  const text = provider === 'anthropic' ? data.content?.[0]?.text : data.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${provider} returned no recommendations`);
  const parsed = JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim());
  if (!Array.isArray(parsed)) throw new Error('AI recommendations must be an array');
  return parsed.filter(track => typeof track?.title === 'string' && track.title.trim() && typeof track.artist === 'string' && track.artist.trim())
    .slice(0, 5).map(track => ({ title: track.title.trim(), artist: track.artist.trim(), reason: String(track.reason || '') }));
}
module.exports = { effectiveProvider, recommend };
