/**
 * RetryManager — background retry for failed downloads.
 *
 * State machine:
 *   QUEUED -> DOWNLOADING -> COMPLETED
 *                           -> FAILED -> RETRYING(attempt 1, 30s) -> DOWNLOADING ...
 *                                                                   -> EXHAUSTED
 *
 * Backoff defaults: [30000, 300000] (30s, 5min)
 * After exhaustion: manual re-add via retry() resets attempts=0
 */

class RetryManager {
  constructor(config = {}) {
    this.maxAttempts = config.maxAttempts ?? 2;
    this.backoff = config.backoff ?? [30000, 300000]; // ms
    this.pollInterval = config.pollInterval ?? 15000;

    /** @type {Map<string, RetryEntry>} */
    this._entries = new Map();
    this._timer = null;
    this._onRetry = null;   // async (entry) => { ... }
    this._onStatus = null;  // (videoId, status, attempt) => { ... }
  }

  /**
   * Register a download for retry tracking.
   */
  register(videoId, title, artist, source) {
    if (this._entries.has(videoId)) return;
    this._entries.set(videoId, {
      videoId,
      title: title || videoId,
      artist: artist || '',
      source: source || 'auto',
      attempt: 0,
      maxAttempts: this.maxAttempts,
      nextRetry: Date.now(),
      backoff: [...this.backoff],
      status: 'queued'
    });
    this._ensurePolling();
  }

  /**
   * Called on download fail — schedules retry.
   */
  onDownloadFailed(videoId) {
    const entry = this._entries.get(videoId);
    if (!entry) return;
    entry.attempt++;
    if (entry.attempt >= entry.maxAttempts) {
      entry.status = 'exhausted';
      entry.nextRetry = 0;
      if (this._onStatus) this._onStatus(videoId, 'exhausted', entry.attempt);
      return;
    }
    const delayMs = entry.backoff[Math.min(entry.attempt - 1, entry.backoff.length - 1)] || 30000;
    entry.nextRetry = Date.now() + delayMs;
    entry.status = 'retrying';
    if (this._onStatus) this._onStatus(videoId, 'retrying', entry.attempt);
  }

  /**
   * Called on download success — removes from retry list.
   */
  onDownloadSuccess(videoId) {
    this._entries.delete(videoId);
    if (this._onStatus) this._onStatus(videoId, 'completed', 0);
  }

  /**
   * Manually retry an exhausted track.
   */
  retry(videoId) {
    const entry = this._entries.get(videoId);
    if (!entry) return false;
    entry.attempt = 0;
    entry.nextRetry = Date.now();
    entry.status = 'queued';
    this._ensurePolling();
    return true;
  }

  /**
   * Set the retry callback — called when a retry is due.
   * Callback: async (entry) => { ... }
   */
  setRetryHandler(fn) { this._onRetry = fn; }

  /**
   * Set status update callback.
   * Callback: (videoId, status, attempt) => { ... }
   */
  setStatusHandler(fn) { this._onStatus = fn; }

  /**
   * Get all retry entries.
   */
  getEntries() {
    return Array.from(this._entries.values());
  }

  /**
   * Get entries by status.
   */
  getByStatus(status) {
    return this.getEntries().filter(e => e.status === status);
  }

  /**
   * Clear completed/exhausted entries.
   */
  clearCompleted() {
    for (const [id, e] of this._entries) {
      if (e.status === 'completed' || e.status === 'exhausted') {
        this._entries.delete(id);
      }
    }
  }

  /**
   * Remove a specific entry.
   */
  remove(videoId) {
    this._entries.delete(videoId);
  }

  /**
   * Start/stop the polling timer.
   */
  _ensurePolling() {
    if (this._timer) return;
    this._timer = setInterval(() => this._poll(), this.pollInterval);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _poll() {
    const now = Date.now();
    let hasPending = false;
    for (const entry of this._entries.values()) {
      if ((entry.status === 'queued' || entry.status === 'retrying') && entry.nextRetry <= now) {
        entry.status = 'downloading';
        if (this._onRetry) {
          this._onRetry(entry).catch(() => {});
        }
        hasPending = true;
      }
      if (entry.status === 'queued' || entry.status === 'retrying') {
        hasPending = true;
      }
    }
    if (!hasPending && this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

module.exports = { RetryManager };