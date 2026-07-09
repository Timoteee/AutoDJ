/**
 * AIScout — AI-powered proxy/source recommendation.
 *
 * When downloads start failing at scale, scouts the frontier for:
 *   - Public proxy endpoints (HTTP/SOCKS5) that bypass regional restrictions
 *   - Alternative Invidious/Piped instances
 *
 * Uses the same provider chain as server.js: Anthropic → OpenRouter → OpenAI → OpenCode.
 */

const PROXY_SCOUT_PROMPT = `You are an expert network engineer. I need working proxy endpoints and alternative streaming instance URLs.

Region: {region}
Failed sources: {failedSources}

Based on current internet infrastructure, recommend:
1. 5 public proxy endpoints (HTTP or SOCKS5) that work for bypassing regional content restrictions to access YouTube/Invidious/Piped.
2. 3 alternative Invidious or Piped instances that are likely up and accessible.

Return JSON ONLY — no markdown, no code fences, no explanation:
{{
  "proxies": [
    {{"url": "socks5://1.2.3.4:1080", "type": "socks5", "region": "us", "reliability": 8, "setupCommands": ["export ALL_PROXY=socks5://1.2.3.4:1080"]}},
    {{"url": "http://5.6.7.8:3128", "type": "http", "region": "de", "reliability": 7, "setupCommands": ["export HTTP_PROXY=http://5.6.7.8:3128"]}}
  ],
  "altInstances": [
    {{"url": "https://invidious.example.com", "type": "invidious", "reliability": 7}},
    {{"url": "https://piped.example.com", "type": "piped", "reliability": 8}}
  ]
}}`;

const AUTO_SCOUT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between auto-scouts

class AIScout {
  /**
   * @param {Object} config
   * @param {string} [config.anthropicKey]
   * @param {string} [config.openaiKey]
   * @param {string} [config.opencodeKey]
   * @param {string} [config.openrouterKey]
   * @param {string} [config.openrouterBaseUrl]
   * @param {string} [config.aiProvider]  — used only for /api/ai/recommend; scouts probe all available keys
   * @param {string} [config.region]      — ISO country code from geo IP
   */
  constructor(config = {}) {
    this.anthropicKey = config.anthropicKey || '';
    this.openaiKey = config.openaiKey || '';
    this.opencodeKey = config.opencodeKey || '';
    this.openrouterKey = config.openrouterKey || '';
    this.openrouterBaseUrl = (config.openrouterBaseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    this.opencodeBaseUrl = (config.opencodeBaseUrl || 'https://api.opencode.ai/v1').replace(/\/+$/, '');
    this.opencodeModel = config.opencodeModel || 'opencode-model';
    this.openrouterModel = config.openrouterModel || 'openrouter/auto';
    this.region = config.region || 'unknown';

    /** @type {number|null} timestamp of last auto-scout */
    this._lastAutoScout = null;
  }

  /**
   * Try each available provider in order until one returns valid JSON.
   * Order: Anthropic → OpenRouter → OpenAI → OpenCode.
   * @param {string} prompt
   * @returns {Promise<Object|null>}
   */
  async _callAI(prompt) {
    // 1) Anthropic
    if (this.anthropicKey) {
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': this.anthropicKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 2048,
            messages: [{ role: 'user', content: prompt }]
          }),
          signal: AbortSignal.timeout(30000)
        });
        if (r.ok) {
          const d = await r.json();
          const text = (d.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
          return JSON.parse(text);
        }
      } catch (_) { /* fall through */ }
    }

    // 2) OpenRouter
    if (this.openrouterKey) {
      try {
        const r = await fetch(`${this.openrouterBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.openrouterKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/Timoteee/AutoDJ',
            'X-Title': 'AutoDJ'
          },
          body: JSON.stringify({
            model: this.openrouterModel,
            messages: [{ role: 'user', content: prompt }]
          }),
          signal: AbortSignal.timeout(30000)
        });
        if (r.ok) {
          const d = await r.json();
          const text = (d.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
          return JSON.parse(text);
        }
      } catch (_) { /* fall through */ }
    }

    // 3) OpenAI
    if (this.openaiKey) {
      try {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.openaiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }]
          }),
          signal: AbortSignal.timeout(30000)
        });
        if (r.ok) {
          const d = await r.json();
          const text = (d.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
          return JSON.parse(text);
        }
      } catch (_) { /* fall through */ }
    }

    // 4) OpenCode
    if (this.opencodeKey) {
      try {
        const r = await fetch(`${this.opencodeBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.opencodeKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: this.opencodeModel,
            messages: [{ role: 'user', content: prompt }]
          }),
          signal: AbortSignal.timeout(30000)
        });
        if (r.ok) {
          const d = await r.json();
          const text = (d.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
          return JSON.parse(text);
        }
      } catch (_) { /* fall through */ }
    }

    return null;
  }

  /**
   * Scout for proxy candidates and alternative instances.
   *
   * @param {Array<{source: string, error: string, url?: string}>} failedSources — sources that recently failed
   * @param {string[]} failedVideoIds — video IDs that failed to download
   * @returns {Promise<{proxies: Array, altInstances: Array}>}
   */
  async scoutProxies(failedSources = [], failedVideoIds = []) {
    const failedSummary = failedSources
      .map(s => `${s.source}${s.url ? ` (${s.url})` : ''}: ${s.error || 'unknown error'}`)
      .join('\n');

    const prompt = PROXY_SCOUT_PROMPT
      .replace('{region}', this.region)
      .replace('{failedSources}', failedSummary || 'none reported');

    try {
      const result = await this._callAI(prompt);
      if (!result || (!result.proxies && !result.altInstances)) {
        return { proxies: [], altInstances: [] };
      }
      return {
        proxies: Array.isArray(result.proxies) ? result.proxies : [],
        altInstances: Array.isArray(result.altInstances) ? result.altInstances : []
      };
    } catch (_) {
      return { proxies: [], altInstances: [] };
    }
  }

  /**
   * Check whether we should auto-trigger a scout based on recent download stats.
   * Auto-scouts fire at most once per 30 minutes (anti-spam).
   *
   * @param {{total: number, failed: number}} downloadStats
   * @returns {boolean}
   */
  shouldAutoScout(downloadStats) {
    if (!downloadStats || downloadStats.total < 10) return false;

    // Anti-spam: only auto-scout once per 30 min
    if (this._lastAutoScout && (Date.now() - this._lastAutoScout) < AUTO_SCOUT_COOLDOWN_MS) {
      return false;
    }

    // If >50% of last 20 downloads failed → trigger
    const failedRate = downloadStats.failed / Math.max(1, downloadStats.total);
    if (failedRate > 0.5) {
      this._lastAutoScout = Date.now();
      return true;
    }

    return false;
  }

  /** Reset the auto-scout cooldown (e.g. after a manual scout). */
  resetCooldown() {
    this._lastAutoScout = null;
  }
}

module.exports = { AIScout };