'use strict';

/**
 * SourcePipeline v7 — unified interface for all AutoDJ music sources.
 */

const SOURCE_KEYS = ['metube', 'invidious', 'piped', 'dab', 'jamendo', 'squid'];
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_TIMEOUT = 300000;
const HEALTH_WEIGHTS = { latency: 0.3, errorRate: 0.4, age: 0.3 };
const HEALTH_THRESHOLDS = { healthy: 0.7, degraded: 0.3 };

// Global pipeline instance (will be replaced by server.js)
let globalPipeline = null;

function getPipeline() {
  if (!globalPipeline) {
    globalPipeline = new SourcePipeline();
  }
  return globalPipeline;
}

function setPipeline(p) {
  globalPipeline = p;
}

class SourcePipeline {
  constructor(config = {}) {
    this.config = config;
    this.instances = {};
    this.proxyPool = config.proxyPool || [];
    this.proxyIndex = 0;
    this._initDefaultSources();
  }

  _initDefaultSources() {
    const defaults = {
      invidious: [
        'https://invidious.snopyta.org',
        'https://vid.puffyan.us',
        'https://yewtu.be',
        'https://invidious.kavin.rocks',
        'https://inv.nadeko.net',
        'https://invidious.nerdvpn.de'
      ],
      piped: [
        'https://piped.kavin.rocks',
        'https://piped.privacydev.net',
        'https://pipedapi.kavin.rocks',
        'https://piped.tokhmi.xyz',
        'https://piped.video',
        'https://pipedapi.syncpunditfx.de'
      ],
      dab: ['https://dab.4tni.rocks'],
      jamendo: ['https://api.jamendo.com'],
      metube: ['http://metube:8081'],
      squid: []
    };
    for (const [source, urls] of Object.entries(defaults)) {
      if (!this.instances[source]) this.instances[source] = {};
      for (const url of urls) {
        this.instances[source][url] = { health: 1.0, latency: 0, errors: 0, lastCheck: 0, circuitOpenUntil: 0 };
      }
    }
  }

  registerSource(name, instanceUrls) {
    if (!this.instances[name]) this.instances[name] = {};
    for (const url of instanceUrls) {
      if (!this.instances[name][url]) {
        this.instances[name][url] = { health: 1.0, latency: 0, errors: 0, lastCheck: 0, circuitOpenUntil: 0 };
      }
    }
  }

  getHealthyInstances(name) {
    if (!this.instances[name]) return [];
    const now = Date.now();
    return Object.entries(this.instances[name])
      .filter(([url, stats]) => stats.circuitOpenUntil <= now && stats.health >= HEALTH_THRESHOLDS.degraded)
      .sort((a, b) => b[1].health - a[1].health)
      .map(([url]) => url);
  }

  async testAll() {
    const results = {};
    for (const [source, instances] of Object.entries(this.instances)) {
      results[source] = {};
      for (const [url, stats] of Object.entries(instances)) {
        if (stats.circuitOpenUntil > Date.now()) {
          results[source][url] = { status: 'circuit_open', health: stats.health };
          continue;
        }
        const start = Date.now();
        try {
          const r = await fetch(`${url}/api/v1/trending/music?type=video&sort=weekly`, { method: 'GET', timeout: 5000 });
          const latency = Date.now() - start;
          this.markInstance(url, r.ok, latency);
          results[source][url] = { status: r.ok ? 'ok' : 'failed', latency, health: this.instances[source][url].health };
        } catch (e) {
          const latency = Date.now() - start;
          this.markInstance(url, false, latency);
          results[source][url] = { status: 'failed', error: e.message, latency, health: this.instances[source][url].health };
        }
      }
    }
    return results;
  }

  markInstance(url, ok, latency = 0) {
    for (const [source, instances] of Object.entries(this.instances)) {
      if (instances[url]) {
        const stats = instances[url];
        stats.lastCheck = Date.now();
        stats.latency = latency;
        if (ok) stats.errors = 0;
        else {
          stats.errors++;
          if (stats.errors >= CIRCUIT_BREAKER_THRESHOLD) {
            stats.circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_TIMEOUT;
          }
        }
        const errorRate = Math.min(1, stats.errors / 10);
        const latencyScore = Math.max(0, 1 - (latency / 10000));
        const ageScore = Math.min(1, (Date.now() - stats.lastCheck) / 86400000);
        stats.health = (HEALTH_WEIGHTS.latency * latencyScore + HEALTH_WEIGHTS.errorRate * (1 - errorRate) + HEALTH_WEIGHTS.age * (1 - ageScore));
        return;
      }
    }
  }

  getHealthSummary() {
    const summary = {};
    const now = Date.now();
    for (const [source, instances] of Object.entries(this.instances)) {
      let healthy = 0, degraded = 0, down = 0;
      for (const [url, stats] of Object.entries(instances)) {
        if (stats.circuitOpenUntil > now) down++;
        else if (stats.health >= HEALTH_THRESHOLDS.healthy) healthy++;
        else if (stats.health >= HEALTH_THRESHOLDS.degraded) degraded++;
        else down++;
      }
      summary[source] = { healthy, degraded, down, total: healthy + degraded + down };
    }
    return summary;
  }

  getSourcePriority() {
    return this.config.sourcePriority || SOURCE_KEYS;
  }

  setProxyPool(proxies) {
    this.proxyPool = proxies || [];
    this.proxyIndex = 0;
  }

  getNextProxy() {
    if (this.proxyPool.length === 0) return '';
    const p = this.proxyPool[this.proxyIndex % this.proxyPool.length];
    this.proxyIndex++;
    return typeof p === 'string' ? p : p.url;
  }
}

// Standalone functions that use the global pipeline
function registerSource(name, urls) { getPipeline().registerSource(name, urls); }
function getHealthyInstances(name) { return getPipeline().getHealthyInstances(name); }
function testAll() { return getPipeline().testAll(); }
function markInstance(url, ok, latency) { getPipeline().markInstance(url, ok, latency); }
function getHealthSummary() { return getPipeline().getHealthSummary(); }
function getSourcePriority() { return getPipeline().getSourcePriority(); }
function setProxyPool(proxies) { getPipeline().setProxyPool(proxies); }
function getNextProxy() { return getPipeline().getNextProxy(); }

// Utility functions
function filterTopicResults(results) {
  return results.filter(t => !t.title?.toLowerCase().includes('- topic'));
}

function musicHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AutoDJ/7.0',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9'
  };
}

function normalizeTrackDurationSeconds(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  const colonMatch = s.match(/^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/);
  if (colonMatch) {
    const [, h, m, sec] = colonMatch;
    const total = (parseInt(h) * 3600) + (parseInt(m) * 60) + (parseInt(sec || '0'));
    if (total < 10 || total > 36000) return null;
    return total;
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 10) return null;
  if (n > 100000 && n < 1e12) return Math.round(n / 1000);
  if (n > 36000) return null;
  return Math.round(n);
}

function invidiousInstances() {
  return ['https://invidious.snopyta.org', 'https://vid.puffyan.us', 'https://yewtu.be', 'https://invidious.kavin.rocks', 'https://inv.nadeko.net', 'https://invidious.nerdvpn.de'];
}

// Search handlers
const SEARCH_HANDLERS = {
  invidious: async (query, cfg) => {
    const instances = getHealthyInstances('invidious');
    for (const base of instances) {
      try {
        const r = await fetch(`${base}/api/v1/search?q=${encodeURIComponent(query)}&type=video`);
        if (r.ok) {
          const data = await r.json();
          return data.map(t => ({
            type: 'invidious', videoId: t.videoId, title: t.title, artist: t.author,
            duration: t.lengthSeconds, url: `${base}/watch?v=${t.videoId}`,
            thumbnail: t.videoThumbnails?.[t.videoThumbnails.length - 1]?.url
          }));
        }
      } catch (e) {}
    }
    return [];
  },
  piped: async (query, cfg) => {
    const instances = getHealthyInstances('piped');
    for (const base of instances) {
      try {
        const r = await fetch(`${base}/search?q=${encodeURIComponent(query)}&filter=music_songs`);
        if (r.ok) {
          const data = await r.json();
          return data.items.map(t => ({
            type: 'piped', videoId: t.url.split('=').pop(), title: t.title,
            artist: t.uploaderName, duration: t.duration, url: t.url, thumbnail: t.thumbnail
          }));
        }
      } catch (e) {}
    }
    return [];
  },
  dab: async (query, cfg) => {
    const instances = getHealthyInstances('dab');
    for (const base of instances) {
      try {
        const r = await fetch(`${base}/api/search?query=${encodeURIComponent(query)}&type=track`);
        if (r.ok) {
          const data = await r.json();
          return data.results.map(t => ({
            type: 'dab', videoId: t.id, title: t.title, artist: t.artist.name,
            duration: t.duration, url: t.url, thumbnail: t.artwork
          }));
        }
      } catch (e) {}
    }
    return [];
  },
  jamendo: async (query, cfg) => {
    try {
      const r = await fetch(`https://api.jamendo.com/v3.0/tracks/?client_id=${cfg.jamendoKey || 'auto'}&search=${encodeURIComponent(query)}&limit=20`);
      if (r.ok) {
        const data = await r.json();
        return data.results.map(t => ({
          type: 'jamendo', videoId: String(t.id), title: t.name, artist: t.artist_name,
          duration: t.duration, url: t.audio, thumbnail: t.album_image
        }));
      }
    } catch (e) {}
    return [];
  },
  metube: async () => [],
  squid: async () => []
};

module.exports = {
  SourcePipeline,
  setPipeline,
  registerSource,
  getHealthyInstances,
  testAll,
  markInstance,
  getHealthSummary,
  getSourcePriority,
  setProxyPool,
  getNextProxy,
  filterTopicResults,
  musicHeaders,
  normalizeTrackDurationSeconds,
  invidiousInstances,
  SEARCH_HANDLERS,
  SOURCE_KEYS
};
