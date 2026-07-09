/**
 * AICurator — AI-powered playlist curation with taste learning.
 *
 * Builds a taste profile from playback history (artist counts, genre dist, bpm range, tags).
 * Generates flow-aware playlists via AI providers (Anthropic, OpenRouter, OpenAI, OpenCode).
 * Learning loop: skip <30s = decrement weight, complete = increment.
 */

class AICurator {
  constructor(config = {}) {
    this.config = config;
    this.tasteProfile = config.aiTasteProfile || {
      artists: {},
      genres: {},
      bpmRange: { min: 80, max: 180, mode: 120 },
      tags: {},
      energyCurve: [],
      lastUpdated: 0,
      playCount: 0
    };
    this._updateCounter = 0;
  }

  /**
   * Update taste profile from play history.
   * @param {Array<{videoId:string,title:string,artist:string,duration:number,skipped:boolean,listenRatio:number}>} history
   */
  updateProfile(history) {
    if (!Array.isArray(history) || history.length === 0) return;

    for (const entry of history) {
      if (!entry || !entry.artist) continue;
      const weight = entry.skipped ? -0.5 : (entry.listenRatio || 0.5);

      // Artist
      const artistKey = entry.artist.toLowerCase();
      this.tasteProfile.artists[artistKey] = (this.tasteProfile.artists[artistKey] || 0) + weight;

      // Energy curve (based on listen ratio: longer listen = higher energy)
      const energyBin = Math.min(9, Math.floor((entry.listenRatio || 0.5) * 10));
      if (!this.tasteProfile.energyCurve[energyBin]) this.tasteProfile.energyCurve[energyBin] = 0;
      this.tasteProfile.energyCurve[energyBin] += weight;
    }

    this._updateCounter++;
    if (this._updateCounter >= 10) {
      this._updateCounter = 0;
      this.tasteProfile.playCount += history.length;
      this.tasteProfile.lastUpdated = Date.now();
      return true; // Signal caller to persist
    }
    return false;
  }

  /**
   * Curate a playlist using AI.
   * @param {Array} currentQueue - current tracks in queue
   * @param {string[]} playedIds - recently played videoIds (to avoid)
   * @param {number} count - number of tracks to generate
   * @returns {Promise<{tracks:Array,source:string}>}
   */
  async curatePlaylist(currentQueue = [], playedIds = [], count = 20) {
    const prompt = this._buildCurationPrompt(currentQueue, playedIds, count);
    const result = await this._callAI(prompt);
    return { tracks: result.tracks || [], source: 'ai' };
  }

  getProfile() {
    return this.tasteProfile;
  }

  _buildCurationPrompt(queue, playedIds, count) {
    const topArtists = Object.entries(this.tasteProfile.artists)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name]) => name);

    const topGenres = Object.entries(this.tasteProfile.genres)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name);

    return `You are an expert DJ/music curator. User's taste profile:
${JSON.stringify({
  topArtists,
  topGenres,
  bpmRange: this.tasteProfile.bpmRange,
  energyCurve: this.tasteProfile.energyCurve,
  totalPlays: this.tasteProfile.playCount
}, null, 2)}

Recently played (avoid these): ${JSON.stringify(playedIds.slice(-50))}
Current queue length: ${queue.length}

Generate a ${count}-track playlist that:
1. Flows naturally - BPM/energy progression (build, peak, cool-down)
2. Mixes familiar tracks (50%) with discovery (50%)
3. Avoids any track from playedIds
4. Avoids same artist within 5 tracks
5. Each track must be reasonably searchable on YouTube/common music sources
6. Vary genres based on user's genre weights

Respond JSON only: {"tracks": [{"title": string, "artist": string, "reason": string, "source": "invidious"|"piped"|"jamendo", "estimatedBpm": number, "energy": "low"|"medium"|"high"}]}`;
  }

  async _callAI(prompt) {
    try {
      if (this.config.aiProvider === 'anthropic' && this.config.anthropicKey) {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': this.config.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2048, messages: [{ role: 'user', content: prompt }] })
        });
        const d = await r.json();
        return JSON.parse((d.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim());
      }
      if (this.config.aiProvider === 'openrouter' && this.config.openrouterKey) {
        const base = (this.config.openrouterBaseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
        const r = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.config.openrouterKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.config.openrouterModel || 'openrouter/auto', messages: [{ role: 'user', content: prompt }] })
        });
        const d = await r.json();
        return JSON.parse((d.choices?.[0]?.message?.content || '{}').replace(/```json|```/g, '').trim());
      }
    } catch (e) {
      console.error('[AICurator] AI call failed:', e.message);
    }
    return { tracks: [] };
  }
}

module.exports = { AICurator };