/**
 * DurationSanitizer — validates and normalizes track durations.
 *
 * Rules:
 *   "1000:30"   -> null    (YT livestream placeholder)
 *   "abc"       -> null    (not numeric)
 *   0           -> null    (impossible)
 *   < 10s       -> null    (too short for a track)
 *   > 36000     -> null    (>10h bogus)
 *   350000      -> 350     (ms -> seconds)
 *   "3:45"      -> 225     (MM:SS)
 *   "1:30:15"   -> 5415    (HH:MM:SS)
 *   234         -> 234     (already valid)
 *   null/undefined -> null
 */

const MAX_REASONABLE_SEC = 600; // 10 min (reject standalone seconds > 600)

function sanitizeDuration(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();

  // MM:SS or HH:MM:SS format
  const colonMatch = s.match(/^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/);
  if (colonMatch) {
    const h = colonMatch[3] !== undefined ? parseInt(colonMatch[1]) : 0;
    const m = colonMatch[3] !== undefined ? parseInt(colonMatch[2]) : parseInt(colonMatch[1]);
    const sec = colonMatch[3] !== undefined ? parseInt(colonMatch[3]) : parseInt(colonMatch[2]);
    const total = h * 3600 + m * 60 + sec;
    if (total < 10) return null;
    if (total > 36000) return null; // >10h bogus
    return total;
    return total;
  }

  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;

  // Detect "1000:30" style — contains colon but didn't match MM:SS/HH:MM:SS
  if (s.includes(':') && (n < 10 || n > MAX_REASONABLE_SEC)) return null;

  // Already small and in seconds range
  if (n >= 10 && n <= MAX_REASONABLE_SEC) return Math.round(n);

  // Likely milliseconds (e.g. 350000 = 350s)
  if (n > MAX_REASONABLE_SEC && n < 1e12) {
    const msResult = Math.round(n / 1000);
    if (msResult < 10) return null;  // <10s after ms conversion is invalid
    return msResult;
  }

  // Below 10s is invalid
  if (n < 10) return null;

  // > 10h bogus
  if (n > MAX_REASONABLE_SEC) return null;

  return Math.round(n);
}

function isBadDuration(duration) {
  return duration === null || duration === undefined || (typeof duration === 'number' && !Number.isFinite(duration));
}

function formatDuration(seconds) {
  if (isBadDuration(seconds)) return '---';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function validateTrack(track) {
  if (!track) return track;
  const sanitized = sanitizeDuration(track.duration);
  return {
    ...track,
    duration: sanitized,
    _badDuration: isBadDuration(sanitized)
  };
}

module.exports = {
  sanitizeDuration,
  isBadDuration,
  formatDuration,
  validateTrack,
  MAX_REASONABLE_SEC
};