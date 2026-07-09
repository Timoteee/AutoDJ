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
    this._required = tracks.length;
    this._status = 'waiting';
    this._settled = false;

    // Check immediately whether we have enough cached tracks
    if (this._cached.size >= Math.min(this._preDownloadCount, this._required)) {
      this._status = 'ready';
      return 'ready';
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
  onCacheUpdated(videoId, cache) {
    // Track what's in the cache
    for (const id of cache) {
      this._cached.add(id);
    }
    // Remove from downloading set
    this._downloading.delete(videoId);
    // Remove from failed set if it was there
    this._failed.delete(videoId);

    this._checkReady();
  }

  /**
   * Get current state snapshot.
   * @returns {{ required: number, cached: number, downloading: number, failed: number, status: string }}
   */
  getState() {
    return {
      required: this._required,
      cached: this._cached.size,
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
    this._settled = false;
    this._resolve = null;
  }

  // ---- Internal helpers ----

  /** @private */
  _checkReady() {
    if (this._settled) return;

    const needed = Math.min(this._preDownloadCount, this._required);
    if (this._cached.size >= needed) {
      this._settle('ready');
    }
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