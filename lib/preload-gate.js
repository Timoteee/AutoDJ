/**
 * PreloadGate — blocks playback until N tracks are cached.
 *
 * Config:
 *   preDownloadCount (default 3) — tracks needed before unblock
 *   preloadTimeoutMs  (default 120000) — max wait before giving up
 *
 * The gate checks how many of the given tracks are already in the cache
 * (passed as a `cache` array from server). It returns ready immediately
 * if enough are cached, otherwise waits and polls every 1 s.
 */

function trackKey(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  return String(t.youtubeId || t.videoId || t.id || '').trim();
}

class PreloadGate {
  constructor(config = {}) {
    this._preDownloadCount = config.preDownloadCount ?? 3;
    this._preloadTimeoutMs = config.preloadTimeoutMs ?? 120000;

    /** @type {'waiting'|'ready'|'timeout'} */
    this._status = 'waiting';

    /** @type {Set<string>} Cached video IDs — tracks server knows about */
    this._cached = new Set();

    /** @type {Set<string>} Video IDs currently downloading */
    this._downloading = new Set();

    /** @type {Set<string>} Video IDs that failed to download */
    this._failed = new Set();

    /** @type {number} Total tracks required before unblocking */
    this._required = 0;

    /** @type {Array<object>} Tracks currently being waited on */
    this._tracks = [];

    /** @type {boolean} Internal flag so we only resolve once */
    this._settled = false;

    /** @type {(() => void) | null} Resolver for the waiting promise */
    this._resolve = null;

    /** @type {ReturnType<typeof setTimeout> | null} Timeout handle */
    this._timeoutHandle = null;

    /** @type {ReturnType<typeof setInterval> | null} Poll interval handle */
    this._intervalHandle = null;
  }

  /**
   * Start waiting for preload.
   * @param {Array<{youtubeId: string, type: string}>} tracks
   * @returns {Promise<'ready'|'timeout'>}
   */
  async waitUntilReady(tracks) {
    this._tracks = Array.isArray(tracks) ? tracks.slice() : [];
    this._required = this._tracks.length;
    this._status = 'waiting';
    this._settled = false;

    if (this._readyCount() >= Math.min(this._preDownloadCount, this._required || 0) && this._required > 0) {
      this._status = 'ready';
      return 'ready';
    }
    if (this._required === 0) {
      this._status = 'ready';
      return 'ready';
    }
    if (this._impossible()) {
      this._status = 'timeout';
      return 'timeout';
    }

    return new Promise((resolve) => {
      this._resolve = resolve;

      // Set timeout — if we don't reach enough cached tracks in time, give up
      this._timeoutHandle = setTimeout(() => {
        this._settle('timeout');
      }, this._preloadTimeoutMs);

      // Poll every 1 s to re-evaluate cache availability
      this._intervalHandle = setInterval(() => {
        this._checkReady();
      }, 1000);
    });
  }

  /**
   * Called when a download completes — pass the downloaded videoId.
   * @param {string} videoId
   * @param {string[]} cache  Current list of cached video IDs from the server
   */
  seedCache(ids) {
    for (const id of ids || []) {
      if (id) this._cached.add(String(id));
    }
  }

  markDownloading(videoId) {
    if (videoId) this._downloading.add(String(videoId));
  }

  markFailed(videoId) {
    if (!videoId) return;
    this._downloading.delete(String(videoId));
    this._failed.add(String(videoId));
    this._checkReady();
  }

  onCacheUpdated(videoId, cache) {
    for (const id of cache || []) {
      if (id) this._cached.add(String(id));
    }
    if (videoId) {
      this._cached.add(String(videoId));
      this._downloading.delete(String(videoId));
      this._failed.delete(String(videoId));
    }

    this._checkReady();
  }

  /**
   * Get current state snapshot.
   * @returns {{ required: number, cached: number, downloading: number, failed: number, status: string }}
   */
  getState() {
    const cached = this._tracks.length ? this._readyCount() : this._cached.size;
    return {
      required: this._required,
      cached,
      downloading: this._downloading.size,
      failed: this._failed.size,
      status: this._status,
    };
  }

  /**
   * Reset for next use.
   */
  reset() {
    this._cleanupTimers();
    this._status = 'waiting';
    this._cached.clear();
    this._downloading.clear();
    this._failed.clear();
    this._required = 0;
    this._tracks = [];
    this._settled = false;
    this._resolve = null;
  }

  // ---- Internal helpers ----

  /** @private */
  _isReadyTrack(t) {
    if (!t) return false;
    if (t.type === 'local' || t.type === 'temp' || t.cached === true) return true;
    const id = trackKey(t);
    return !!(id && this._cached.has(id));
  }

  _readyCount() {
    return (this._tracks || []).filter(t => this._isReadyTrack(t)).length;
  }

  _checkReady() {
    if (this._settled) return;

    const needed = Math.min(this._preDownloadCount, this._required);
    if (needed > 0 && this._readyCount() >= needed) {
      this._settle('ready');
      return;
    }
    if (this._impossible()) this._settle('timeout');
  }

  /**
   * True when failed or uncacheable tracks make the required count unreachable.
   * @private
   */
  _impossible() {
    const needed = Math.min(this._preDownloadCount, this._required);
    if (needed <= 0 || !this._tracks.length) return false;
    let hopeful = 0;
    for (const t of this._tracks) {
      if (this._isReadyTrack(t)) { hopeful++; continue; }
      const id = trackKey(t);
      if (!id || this._failed.has(id)) continue;
      hopeful++;
    }
    return hopeful < needed;
  }

  /** @private */
  _settle(result) {
    if (this._settled) return;
    this._settled = true;
    this._status = result;
    this._cleanupTimers();
    if (this._resolve) {
      this._resolve(result);
      this._resolve = null;
    }
  }

  /** @private */
  _cleanupTimers() {
    if (this._timeoutHandle) {
      clearTimeout(this._timeoutHandle);
      this._timeoutHandle = null;
    }
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
    }
  }
}

module.exports = { PreloadGate };