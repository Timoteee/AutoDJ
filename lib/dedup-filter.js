const { sanitizeDuration } = require('./duration-sanitizer');

// --------------- Levenshtein distance ---------------

function levenshtein(a, b) {
  const an = a.length;
  const bn = b.length;
  if (an === 0) return bn;
  if (bn === 0) return an;

  // Use two rows to save memory
  let prev = new Array(bn + 1);
  let curr = new Array(bn + 1);

  for (let j = 0; j <= bn; j++) prev[j] = j;

  for (let i = 1; i <= an; i++) {
    curr[0] = i;
    for (let j = 1; j <= bn; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,        // insertion
        prev[j] + 1,             // deletion
        prev[j - 1] + cost       // substitution
      );
    }
    // swap rows
    [prev, curr] = [curr, prev];
  }

  return prev[bn];
}

// --------------- Title similarity ---------------

function similarity(a, b) {
  if (!a || !b) return 0;
  const na = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const nb = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!na || !nb) return 0;
  return 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
}

// --------------- DedupFilter class ---------------

class DedupFilter {
  constructor(config = {}) {
    this.enabled = config.enabled !== undefined ? config.enabled : true;
    this.historyWindow = config.historyWindow || 200;
    this.artistSpacing = config.artistSpacing || 5;
    this.titleSimilarityThreshold = config.titleSimilarityThreshold || 0.85;

    /** @type {string[]} Queue of played videoIds (most recent at end) */
    this._history = [];
  }

  /**
   * Set the played history (array of videoIds).
   * @param {string[]} history
   */
  setHistory(history) {
    this._history = Array.isArray(history) ? history.slice() : [];
  }

  /**
   * Check if a track is a duplicate in the given queue.
   * @param {{ videoId: string, artist?: string, title?: string }} track
   * @param {Array<{ videoId: string, artist?: string, title?: string }>} queue
   * @returns {{ isDuplicate: boolean, reason: string | null }}
   */
  isDuplicate(track, queue) {
    if (!this.enabled) return { isDuplicate: false, reason: null };

    // 1. Exact videoId match in queue
    const queueMatch = queue.find(t => t && t.videoId === track.videoId);
    if (queueMatch) {
      return { isDuplicate: true, reason: 'Already in queue (exact videoId match)' };
    }

    // 2. videoId in play history
    const historyMatch = this._history.includes(track.videoId);
    if (historyMatch) {
      return { isDuplicate: true, reason: 'Recently played (videoId in history)' };
    }

    // 3. Same artist within the last artistSpacing positions
    if (track.artist && queue.length > 0) {
      // Slice from BEFORE trackIndex if trackIndex known, otherwise last N
      const recentQueue = queue.slice(-this.artistSpacing);
      const artistMatch = recentQueue.some(
        t => t && t.artist && t.artist.toLowerCase().trim() === track.artist.toLowerCase().trim()
      );
      if (artistMatch) {
        return {
          isDuplicate: true,
          reason: `Same artist "${track.artist}" within last ${this.artistSpacing} queue positions`,
        };
      }
    }

    // 4. Title similarity above threshold
    if (track.title && queue.length > 0) {
      const titleMatch = queue.some(t => {
        if (!t || !t.title) return false;
        return similarity(track.title, t.title) > this.titleSimilarityThreshold;
      });
      if (titleMatch) {
        return {
          isDuplicate: true,
          reason: `Title too similar to another track in queue (threshold: ${this.titleSimilarityThreshold})`,
        };
      }
    }

    return { isDuplicate: false, reason: null };
  }

  /**
   * Filter a batch of tracks before adding to queue.
   * Returns tracks that are not duplicates, preserving order.
   * @param {Array<{ videoId: string, artist?: string, title?: string }>} tracks
   * @param {Array<{ videoId: string, artist?: string, title?: string }>} queue
   * @returns {Array<{ videoId: string, artist?: string, title?: string }>}
   */
  filterTracks(tracks, queue) {
    if (!this.enabled) return tracks.slice();

    const workingQueue = queue.slice();

    return tracks.filter(track => {
      const result = this.isDuplicate(track, workingQueue);
      if (!result.isDuplicate) {
        // Treat it as added, so subsequent tracks in the batch see it
        workingQueue.push(track);
        return true;
      }
      return false;
    });
  }

  /**
   * After a track plays, add it to history (respecting the historyWindow).
   * @param {string} videoId
   */
  addPlayed(videoId) {
    this._history.push(videoId);
    if (this._history.length > this.historyWindow) {
      this._history = this._history.slice(-this.historyWindow);
    }
  }

  /**
   * Scan the queue for duplicate groups.
   * @param {Array<{ videoId: string, artist?: string, title?: string }>} queue
   * @returns {Array<{ original: object, duplicates: object[] }>}
   */
  findDuplicates(queue) {
    const groups = [];
    const seen = new Set();

    for (let i = 0; i < queue.length; i++) {
      const track = queue[i];
      if (!track) continue;
      if (seen.has(i)) continue;

      const duplicates = [];

      for (let j = i + 1; j < queue.length; j++) {
        const other = queue[j];
        if (!other) continue;
        if (seen.has(j)) continue;

        // Compare the two tracks
        const result = this._compareTracks(track, other);
        if (result) {
          duplicates.push(other);
          seen.add(j);
        }
      }

      if (duplicates.length > 0) {
        groups.push({ original: track, duplicates });
      }
    }

    return groups;
  }

  /**
   * Internal comparison used by findDuplicates.
   * Returns true if `other` is considered a duplicate of `track`.
   * @param {{ videoId?: string, artist?: string, title?: string }} track
   * @param {{ videoId?: string, artist?: string, title?: string }} other
   * @returns {boolean}
   */
  _compareTracks(track, other) {
    // Exact videoId
    if (track.videoId && other.videoId && track.videoId === other.videoId) {
      return true;
    }

    // Same artist
    if (
      track.artist &&
      other.artist &&
      track.artist.toLowerCase() === other.artist.toLowerCase()
    ) {
      return true;
    }

    // Title similarity
    if (track.title && other.title) {
      return similarity(track.title, other.title) > this.titleSimilarityThreshold;
    }

    return false;
  }
}

module.exports = { DedupFilter, levenshtein, similarity };