'use strict';

/**
 * SourcePipeline v7 — unified interface for all AutoDJ music sources.
 *
 * Features:
 *  1. Instance registry with health scoring
 *  2. Circuit breaker (3 consecutive fails → disabled for 5 min)
 *  3. Proxy injection for all fetch calls
 *  4. Health scoring: score = weighted(latency 30%, errorRate 40%, age 30%)
 *     - Healthy  > 0.7
 *     - Degraded 0.3–0.7
 *     - Down     < 0.3
 *  5. Instances sorted by health score for selection
 *
 * Self-contained — no dependency on server.js. Accepts a `config` object.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const SOURCE_KEYS = ['metube', 'invidious', 'piped', 'dab', 'jamendo', 'squid'];

const MUSIC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CIRCUIT_OPEN_MS = 5 * 60 * 1000; // 5 min
const CONSECUTIVE_FAIL_LIMIT = 3;

const HEALTH_WEIGHTS = { latency: 0.3, errorRate: 0.4, age: 0.3 };

const HEALTHY_THRESHOLD = 0.7;
const DEGRADED_THRESHOLD = 0.3;

const MAX_REASONABLE_TRACK_SEC = 600; // 10 min max

// ─── Helpers (self-contained) ─────────────────────────────────────────────────

/** Minimal structured logger — tags match existing server.js conventions. */
function log(tag, ...args) {
  const msg = args.map(a => String(a)).join(' ');
  console.log(`[AutoDJ][SourcePipeline][${tag}]`, ...args);
}

/** Browser-like request headers for music-source APIs. */
function musicHeaders(more = {}) {
  return { 'User-Agent': MUSIC_UA, Accept: 'application/json, */*', ...more };
}

/** Parse various duration formats to seconds. (Mirrors parseDurationToSeconds from server.js.) */
function parseDurationToSeconds(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  const colonMatch = s.match(/^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/);
  if (colonMatch) {
    const h = colonMatch[3] !== undefined ? parseInt(colonMatch[1]) : 0;
    const m = colonMatch[3] !== undefined ? parseInt(colonMatch[2]) : parseInt(colonMatch[1]);
    const sec = colonMatch[3] !== undefined ? parseInt(colonMatch[3]) : parseInt(colonMatch[2]);
    return h * 3600 + m * 60 + sec;
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 10) return null;
  if (n > 100000 && n < 1e12) return Math.round(n / 1000);
  if (n > 36000) return null;
  return Math.round(n);
}

/** Normalize a possibly-millisecond duration to seconds, clamped. */
function normalizeTrackDurationSeconds(duration, durationMs) {
  let sec = null;
  if (durationMs != null) sec = parseDurationToSeconds(durationMs);
  if (sec == null && duration != null) sec = parseDurationToSeconds(duration);
  if (sec == null || sec < 1) return 0;
  return Math.min(sec, MAX_REASONABLE_TRACK_SEC);
}

/** Filter out YouTube -Topic channels from search results. */
function filterTopicResults(results, config) {
  if (!config || config.filterTopicChannels === false) return results;
  return results.filter(r => {
    const author = (r.author || '').replace(/\s*-\s*Topic\s*$/i, '').trim();
    const wasTopic = author.length < (r.author || '').length;
    if (wasTopic) log('Search', `Filtered -Topic: "${r.author}" — "${r.title}"`);
    return !wasTopic;
  });
}

/** Sleep helper. */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Internal State ──────────────────────────────────────────────────────────

/** @type {Map<string, SourceState>} */
const sources = new Map();

/** @type {Array<{ url: string, index: number }>} */
let proxyPool = [];
let proxyIndex = 0;

/**
 * @typedef {Object} InstanceRecord
 * @property {string} url
 * @property {number} healthScore  — 0..1 composite
 * @property {number} latency      — last measured latency (ms)
 * @property {number} errorRate    — ratio of fails / total attempts (0..1)
 * @property {number} totalCalls
 * @property {number} failedCalls
 * @property {number} lastTest     — Date.now() of last test
 * @property {number} consecutiveFailures
 * @property {number|null} circuitOpenUntil — null = not open
 * @property {string} status       — 'Healthy' | 'Degraded' | 'Down'
 */

/**
 * @typedef {Object} SourceState
 * @property {string} name
 * @property {Map<string, InstanceRecord>} instances  — keyed by url
 * @property {Array<string>} instanceOrder  — insertion order
 */

// ─── Health Score Engine ──────────────────────────────────────────────────────

/**
 * Compute composite health score (0..1).
 *
 * score = latencyWeight * latencyNorm + errorRateWeight * errorRateNorm + ageWeight * ageNorm
 *
 * - latencyNorm: exponential decay, 200ms → ~0.9, 2000ms → ~0.5, 10000ms → ~0.1
 * - errorRateNorm:  1 - errorRate
 * - ageNorm:        linear decay from 1→0 over 24 h
 */
function computeHealthScore(record) {
  const now = Date.now();

  // Latency component: exponential decay
  //   0 ms → 1.0,  200 ms → ~0.9,  2000 ms → ~0.5,  10000 ms → ~0.12
  const lat = Math.max(0, record.latency || 200);
  const latencyNorm = Math.exp(-lat / 3000);

  // Error-rate component
  const errorRateNorm = 1 - (record.errorRate || 0);

  // Age component: freshness in last 24 h
  const ageMs = record.lastTest ? Math.max(0, now - record.lastTest) : 24 * 3600 * 1000;
  const ageHours = ageMs / (3600 * 1000);
  const ageNorm = Math.max(0, 1 - ageHours / 24);

  const score =
    HEALTH_WEIGHTS.latency * latencyNorm +
    HEALTH_WEIGHTS.errorRate * errorRateNorm +
    HEALTH_WEIGHTS.age * ageNorm;

  return Math.max(0, Math.min(1, score));
}

function classifyHealth(score) {
  if (score > HEALTHY_THRESHOLD) return 'Healthy';
  if (score >= DEGRADED_THRESHOLD) return 'Degraded';
  return 'Down';
}

function recomputeInstance(record) {
  record.healthScore = computeHealthScore(record);
  record.status = classifyHealth(record.healthScore);
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

function isCircuitOpen(record) {
  if (record.circuitOpenUntil == null) return false;
  if (Date.now() >= record.circuitOpenUntil) {
    record.circuitOpenUntil = null;
    record.consecutiveFailures = 0;
    recomputeInstance(record);
    return false;
  }
  return true;
}

function recordFailure(record) {
  record.totalCalls = (record.totalCalls || 0) + 1;
  record.failedCalls = (record.failedCalls || 0) + 1;
  record.consecutiveFailures = (record.consecutiveFailures || 0) + 1;
  record.errorRate = record.totalCalls > 0
    ? Math.min(1, record.failedCalls / record.totalCalls)
    : 0;

  // Trip circuit breaker
  if (record.consecutiveFailures >= CONSECUTIVE_FAIL_LIMIT) {
    record.circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
    log('Circuit', `Opened for ${record.url} (${record.consecutiveFailures} consecutive fails) — retry in ${CIRCUIT_OPEN_MS / 1000}s`);
  }

  recomputeInstance(record);
}

function recordSuccess(record, latencyMs) {
  record.totalCalls = (record.totalCalls || 0) + 1;
  record.consecutiveFailures = 0;
  record.latency = typeof latencyMs === 'number' && latencyMs >= 0 ? latencyMs : record.latency || 0;
  record.lastTest = Date.now();
  record.failedCalls = record.failedCalls || 0;
  record.errorRate = record.totalCalls > 0
    ? Math.min(1, record.failedCalls / record.totalCalls)
    : 0;
  recomputeInstance(record);
}

// ─── Proxy ────────────────────────────────────────────────────────────────────

/**
 * Create a proxy-agent-compatible options object or headers for a fetch call.
 *
 * If the proxy is a URL string, returns { proxy: url }.
 * If the proxy is an object with a url property, returns { proxy: proxy.url }.
 * Otherwise returns empty object (direct fetch).
 */
function proxyOptions(proxy) {
  if (!proxy) return {};
  const url = typeof proxy === 'string' ? proxy : (proxy?.url || '');
  if (!url) return {};
  // Node 18+ undici supports proxy via a custom dispatcher; for simplicity
  // we inject an X-Forwarded-For style header so downstream proxies can route.
  // The actual proxy handling is left to the caller (fetch wrapper).
  return { __proxyUrl: url };
}

/**
 * Wrapper around global fetch that injects proxy headers.
 * This does NOT do actual proxy routing — it marks the request so that
 * the caller can route through a proxy dispatcher. In the standard Node.js
 * fetch (undici), you'd use a ProxyAgent. Here we keep it simple: we add
 * the proxy URL as a custom option and let the search handlers pass it
 * through if they have proxy-aware fetch logic.
 */
async function proxiedFetch(url, options = {}) {
  const proxy = getNextProxy();
  const headers = { ...musicHeaders(), ...options.headers };

  if (proxy) {
    const pUrl = typeof proxy === 'string' ? proxy : (proxy?.url || '');
    if (pUrl) {
      headers['X-Proxy-Url'] = pUrl;
      // Add X-Forwarded-For with a randomized suffix for basic rotation
      headers['X-Forwarded-For'] = `10.0.0.${Math.floor(Math.random() * 255)}`;
    }
  }

  const fetchOpts = {
    ...options,
    headers,
    signal: options.signal || AbortSignal.timeout(15000),
  };

  return fetch(url, fetchOpts);
}

// ─── Source Registry ──────────────────────────────────────────────────────────

/**
 * Register (or re-register) a source type with initial instance URLs.
 *
 * @param {string} name  — source key, e.g. 'invidious', 'piped', 'dab'
 * @param {string[]|object[]} instancesConfig  — array of URLs or config objects
 */
function registerSource(name, instancesConfig) {
  const existing = sources.get(name);
  const instances = new Map();
  const instanceOrder = [];

  for (const cfg of (instancesConfig || [])) {
    const url = typeof cfg === 'string' ? cfg : (cfg?.url || '');
    if (!url) continue;

    instanceOrder.push(url);

    if (existing && existing.instances.has(url)) {
      // Preserve existing health data
      instances.set(url, existing.instances.get(url));
    } else {
      const record = {
        url,
        healthScore: 0.5,
        latency: 0,
        errorRate: 0,
        totalCalls: 0,
        failedCalls: 0,
        lastTest: 0,
        consecutiveFailures: 0,
        circuitOpenUntil: null,
        status: 'Unknown',
      };
      recomputeInstance(record);
      instances.set(url, record);
    }
  }

  sources.set(name, { name, instances, instanceOrder });
  log('Registry', `Registered source "${name}" with ${instanceOrder.length} instance(s)`);
}

/**
 * Get instances for a source, sorted by health score descending,
 * excluding circuit-open instances.
 *
 * @param {string} name
 * @returns {Array<{url: string, healthScore: number, status: string, latency: number}>}
 */
function getHealthyInstances(name) {
  const source = sources.get(name);
  if (!source) return [];

  const available = [];
  for (const url of source.instanceOrder) {
    const record = source.instances.get(url);
    if (!record) continue;
    if (isCircuitOpen(record)) continue;
    available.push({
      url: record.url,
      healthScore: record.healthScore,
      status: record.status,
      latency: record.latency,
    });
  }

  // Sort descending by health score
  available.sort((a, b) => b.healthScore - a.healthScore);
  return available;
}

// ─── Instance Health Updates ──────────────────────────────────────────────────

/**
 * Mark an instance result — updates health score and circuit breaker state.
 *
 * @param {string} url  — instance URL
 * @param {boolean} ok  — true if the call succeeded
 * @param {number} [latency]  — response time in ms
 */
function markInstance(url, ok, latency) {
  // Find which source owns this URL
  for (const [, source] of sources) {
    const record = source.instances.get(url);
    if (record) {
      if (ok) {
        recordSuccess(record, latency);
      } else {
        recordFailure(record);
      }
      return;
    }
  }

  // URL not registered yet — add it to a best-guess source (falls back to first)
  // In practice this shouldn't happen if registerSource is called first.
  log('Health', `markInstance: unknown URL "${url}" — ignoring`);
}

// ─── Test All Instances ──────────────────────────────────────────────────────

/**
 * Test all registered instances by fetching their root / health endpoint.
 *
 * @returns {Promise<Array<{url: string, ok: boolean, latency: number, source: string}>>}
 */
async function testAll() {
  const results = [];

  for (const [name, source] of sources) {
    for (const url of source.instanceOrder) {
      const start = Date.now();
      let ok = false;

      try {
        const res = await proxiedFetch(url, {
          signal: AbortSignal.timeout(10000),
        });
        ok = res.ok || res.status < 500;
        const latency = Date.now() - start;
        markInstance(url, ok, latency);
        results.push({ url, ok, latency, source: name });
        log('Probe', `${url} → ${ok ? 'OK' : `HTTP ${res.status}`} (${latency}ms)`);
      } catch (err) {
        const latency = Date.now() - start;
        markInstance(url, false);
        results.push({ url, ok: false, latency, source: name, error: err.message });
        log('Probe', `${url} → FAIL (${err.message})`);
      }
    }
  }

  return results;
}

// ─── Health Summary ──────────────────────────────────────────────────────────

/**
 * Return aggregate health per source.
 *
 * @returns {Object<string, {healthy: number, degraded: number, down: number, total: number}>}
 */
function getHealthSummary() {
  const summary = {};

  for (const [name, source] of sources) {
    let healthy = 0;
    let degraded = 0;
    let down = 0;

    for (const record of source.instances.values()) {
      const status = classifyHealth(record.healthScore);
      if (status === 'Healthy') healthy++;
      else if (status === 'Degraded') degraded++;
      else down++;
    }

    summary[name] = {
      healthy,
      degraded,
      down,
      total: source.instances.size,
    };
  }

  return summary;
}

// ─── Source Priority ─────────────────────────────────────────────────────────

/**
 * Get ordered source keys respecting config.sourcePriority.
 *
 * @returns {string[]}
 */
function getSourcePriority(config) {
  if (Array.isArray(config?.sourcePriority) && config.sourcePriority.length > 0) {
    const valid = config.sourcePriority.filter(s => SOURCE_KEYS.includes(s));
    const missing = SOURCE_KEYS.filter(s => !config.sourcePriority.includes(s));
    return [...valid, ...missing];
  }
  return [...SOURCE_KEYS];
}

// ─── Proxy Pool ───────────────────────────────────────────────────────────────

/**
 * Set the pool of proxy URLs (round-robin).
 *
 * @param {Array<string|{url: string}>} proxies
 */
function setProxyPool(proxies) {
  proxyPool = (proxies || []).filter(p => {
    if (typeof p === 'string') return p.trim().length > 0;
    return p?.url?.trim()?.length > 0;
  });
  proxyIndex = 0;
  log('Proxy', `Pool set with ${proxyPool.length} proxy/proxies`);
}

/**
 * Get next proxy URL via round-robin.
 *
 * @returns {string|{url: string}|null}
 */
function getNextProxy() {
  if (proxyPool.length === 0) return null;
  const proxy = proxyPool[proxyIndex % proxyPool.length];
  proxyIndex = (proxyIndex + 1) % proxyPool.length;
  return proxy;
}

// ─── Invidious Instance Helper ───────────────────────────────────────────────

/**
 * Return Invidious instance list with user-configured redirector first.
 */
function invidiousInstances(config) {
  const u = config?.invidiousRedirector && String(config.invidiousRedirector).trim();
  const source = sources.get('invidious');
  const base = source ? [...source.instanceOrder] : [];
  const extra = u ? [u] : [];
  return [...extra, ...base];
}

// ─── SEARCH_HANDLERS (proxy-injected) ───────────────────────────────────────

/**
 * Search handlers for each music source.
 *
 * Each handler accepts (query, config) and returns a Promise resolving to
 * an array of unified track objects, or null if the source couldn't serve.
 *
 * Unified track shape:
 *   { videoId, title, author, lengthSeconds, artwork, _source, _instance }
 */
const SEARCH_HANDLERS = {

  /** Invidious search */
  invidious: async (q, cfg) => {
    const instances = getHealthyInstances('invidious');
    if (instances.length === 0) {
      // Fallback: use raw URLs from config
      const raw = invidiousInstances(cfg);
      for (const url of raw) {
        try {
          const start = Date.now();
          const r = await proxiedFetch(`${url}/api/v1/search?q=${encodeURIComponent(q)}&type=video`, {
            signal: AbortSignal.timeout(9000),
          });
          if (!r.ok) { markInstance(url, false); continue; }
          const d = await r.json();
          markInstance(url, true, Date.now() - start);
          if (Array.isArray(d) && d.length > 0) {
            const vids = d.filter(i => (i.type === 'video' || i.lengthSeconds) && (i.videoId || i.video_id));
            const rows = (vids.length ? vids : d).slice(0, 8);
            if (rows.length > 0) {
              log('Search', `Invidious ${url}: ${rows.length}`);
              return rows.slice(0, 5).map(i => ({
                videoId: i.videoId || i.video_id || '',
                title: i.title || i.videoId || 'Unknown',
                author: i.author || i.authorName || i.uploaderName || i.authorId || 'Unknown',
                lengthSeconds: normalizeTrackDurationSeconds(i.lengthSeconds, null),
                artwork: `https://img.youtube.com/vi/${i.videoId || i.video_id || ''}/mqdefault.jpg`,
                _source: 'invidious',
                _instance: url,
              }));
            }
          }
        } catch (e) { markInstance(url, false); }
      }
      return null;
    }

    for (const inst of instances) {
      try {
        const start = Date.now();
        const r = await proxiedFetch(`${inst.url}/api/v1/search?q=${encodeURIComponent(q)}&type=video`, {
          signal: AbortSignal.timeout(9000),
        });
        if (!r.ok) { markInstance(inst.url, false); continue; }
        const d = await r.json();
        markInstance(inst.url, true, Date.now() - start);
        if (Array.isArray(d) && d.length > 0) {
          const vids = d.filter(i => (i.type === 'video' || i.lengthSeconds) && (i.videoId || i.video_id));
          const rows = (vids.length ? vids : d).slice(0, 8);
          if (rows.length > 0) {
            log('Search', `Invidious ${inst.url}: ${rows.length}`);
            return rows.slice(0, 5).map(i => ({
              videoId: i.videoId || i.video_id || '',
              title: i.title || i.videoId || 'Unknown',
              author: i.author || i.authorName || i.uploaderName || i.authorId || 'Unknown',
              lengthSeconds: normalizeTrackDurationSeconds(i.lengthSeconds, null),
              artwork: `https://img.youtube.com/vi/${i.videoId || i.video_id || ''}/mqdefault.jpg`,
              _source: 'invidious',
              _instance: inst.url,
            }));
          }
        }
      } catch (e) { markInstance(inst.url, false); }
    }
    return null;
  },

  /** Piped search */
  piped: async (q, cfg) => {
    const instances = getHealthyInstances('piped');
    for (const inst of instances) {
      try {
        const r = await proxiedFetch(`${inst.url}/search?q=${encodeURIComponent(q)}&filter=videos`, {
          signal: AbortSignal.timeout(9000),
        });
        if (!r.ok) { markInstance(inst.url, false); continue; }
        const d = await r.json();
        markInstance(inst.url, true);
        const raw = d.items || [];
        const items = raw.filter(i => {
          const ty = (i.type || '').toLowerCase();
          return ty === 'stream' || ty === 'video' || (!!i.url && (ty === '' || ty === 'scheduledstream'));
        }).slice(0, 8);
        const mapped = items.map(i => {
          let vid = i.videoId || '';
          if (!vid && i.url) {
            const m = String(i.url).match(/[?&]v=([^&]+)/);
            if (m) vid = m[1];
            else if (String(i.url).startsWith('/watch?v=')) vid = i.url.replace('/watch?v=', '').split('&')[0];
          }
          return { ...i, _vid: vid };
        }).filter(i => i._vid);
        if (mapped.length > 0) {
          log('Search', `Piped ${inst.url}: ${mapped.length}`);
          return mapped.slice(0, 5).map(i => ({
            videoId: i._vid,
            title: i.title || 'Unknown',
            author: i.uploaderName || i.uploader || i.author || 'Unknown',
            lengthSeconds: normalizeTrackDurationSeconds(i.duration, null),
            artwork: `https://img.youtube.com/vi/${i._vid}/mqdefault.jpg`,
            _source: 'piped',
            _instance: inst.url,
          }));
        }
      } catch (e) { markInstance(inst.url, false); }
    }
    return null;
  },

  /** DAB (Digital Audio Broadcasting) search */
  dab: async (q, cfg) => {
    const instances = getHealthyInstances('dab');
    for (const inst of instances) {
      for (const qp of ['q', 'query']) {
        try {
          const start = Date.now();
          const r = await proxiedFetch(`${inst.url}/search?${qp}=${encodeURIComponent(q)}&type=track&limit=5`, {
            signal: AbortSignal.timeout(8000),
          });
          if (!r.ok) continue;
          const ct = r.headers.get('content-type') || '';
          if (!ct.includes('json')) continue;
          const d = await r.json();
          const tracks = d.tracks || d.results || (Array.isArray(d) ? d : []);
          if (tracks.length > 0) {
            markInstance(inst.url, true, Date.now() - start);
            const mapped = tracks.slice(0, 5).map(t => ({
              videoId: t.id || t.trackId || '',
              title: t.title || t.name || 'Unknown',
              author: (typeof t.artist === 'object' ? t.artist?.name : t.artist) || t.artistName || 'Unknown',
              lengthSeconds: normalizeTrackDurationSeconds(t.duration, t.duration_ms || t.durationMs),
              artwork: (typeof t.album === 'object' ? t.album?.cover : null) || t.albumCover || t.cover || '',
              _source: 'dab',
              _instance: inst.url,
            }));
            log('Search', `DAB ${inst.url} (${qp}=): ${tracks.length}`);
            return mapped;
          }
          markInstance(inst.url, true, Date.now() - start);
        } catch (e) { markInstance(inst.url, false); }
      }
    }
    return null;
  },

  /** Jamendo search (API key from config) */
  jamendo: async (q, cfg) => {
    if (cfg?.jamendoClientId) {
      try {
        const r = await proxiedFetch(
          `https://api.jamendo.com/v3.1/tracks/?client_id=${encodeURIComponent(cfg.jamendoClientId)}&format=json&limit=8&search=${encodeURIComponent(q)}`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (r.ok) {
          const d = await r.json();
          const results = d.results || [];
          if (results.length > 0) {
            log('Search', `Jamendo: ${results.length}`);
            return results.slice(0, 5).map(t => ({
              videoId: `jamendo:${t.id}`,
              title: t.name || 'Unknown',
              author: t.artist_name || 'Unknown',
              lengthSeconds: normalizeTrackDurationSeconds(parseFloat(t.duration), null) || 0,
              artwork: t.image || t.album_image || '',
              _source: 'jamendo',
              _instance: 'https://api.jamendo.com/v3.1',
            }));
          }
        }
      } catch (e) { /* Jamendo is a single endpoint — no circuit tripping */ }
    }
    return null;
  },

  /** Squid proxy-based search */
  squid: async (q, cfg) => {
    const list = Array.isArray(cfg?.squidProxies) ? cfg.squidProxies : [];
    for (const px of list) {
      if (!px || !px.name || !px.searchUrlTemplate || !px.streamUrlTemplate) continue;
      try {
        const url = px.searchUrlTemplate.split('{query}').join(encodeURIComponent(q));
        const hdr = { ...musicHeaders(), Accept: 'application/json, */*' };
        if (px.headers && typeof px.headers === 'object') Object.assign(hdr, px.headers);
        const r = await proxiedFetch(url, {
          signal: AbortSignal.timeout(15000),
          headers: hdr,
        });
        if (!r.ok) continue;
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('json')) continue;
        const raw = await r.json();
        const arr = Array.isArray(raw) ? raw : (raw.results || raw.tracks || raw.items || raw.data?.tracks || raw.data || []);
        if (!Array.isArray(arr) || !arr.length) continue;
        const rows = [];
        for (const t of arr.slice(0, 8)) {
          const id = t.id ?? t.trackId ?? t.track_id ?? t.uri;
          if (id == null || id === '') continue;
          const encId = encodeURIComponent(String(id));
          rows.push({
            videoId: `squid:${px.name}:${encId}`,
            title: t.title || t.name || 'Unknown',
            author: (typeof t.artist === 'object' ? (t.artist?.name || '') : t.artist) || t.artistName || t.uploader || 'Unknown',
            lengthSeconds: normalizeTrackDurationSeconds(t.duration, t.duration_ms || t.durationMs),
            artwork: (typeof t.album === 'object' ? t.album?.cover : null) || t.albumCover || t.cover || '',
            _source: 'squid',
            _instance: px.baseUrl || (() => { try { return new URL(px.searchUrlTemplate).origin; } catch (_) { return ''; } })(),
          });
          if (rows.length >= 5) break;
        }
        if (rows.length) { log('Search', `squid/${px.name} → ${rows.length}`); return rows; }
      } catch (e) { log('Search', `squid/${px.name} err: ${e.message}`); }
    }
    return null;
  },

  /** MeTube search — no search endpoint, so returns null */
  metube: async (_q, _cfg) => null,
};

// ─── Module Exports ──────────────────────────────────────────────────────────


module.exports = {
  SourcePipeline,
  // Core registry
  registerSource,
  getHealthyInstances,
  testAll,
  markInstance,
  getHealthSummary,
  getSourcePriority,

  // Search handlers
  SEARCH_HANDLERS,

  // Proxy pool
  setProxyPool,
  getNextProxy,

  // Utility (for external stream resolution etc.)
  filterTopicResults,
  musicHeaders,
  normalizeTrackDurationSeconds,
  invidiousInstances,
  proxiedFetch,
  SOURCE_KEYS,
};
