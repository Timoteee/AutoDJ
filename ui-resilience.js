/* Small shared helpers; usable even when storage or the server is unavailable. */
(function (root) {
  const UI = {
    seedTitle(title, artist = '') {
      let clean = String(title || '');
      if (artist && clean.toLowerCase().startsWith(artist.toLowerCase() + ' - ')) clean = clean.slice(artist.length + 3);
      return clean.replace(/\s*\((?:official\s+)?(?:audio|video|lyric[s]?(?:\s+video)?)\)\s*/ig, ' ')
        .replace(/\s+remix\s+feat\..*$/i, '').trim();
    },
    readPreference(key) {
      try { return root.localStorage.getItem(key); } catch { return null; }
    },
    writePreference(key, value) {
      try { root.localStorage.setItem(key, value); } catch { /* Session theme still works. */ }
    },
    async requestJSON(url, options = {}) {
      const response = await root.fetch(url, {
        ...options,
        signal: options.signal || AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      return response.json();
    },
  };
  root.AutoDJUI = UI;
  if (root.addEventListener && root.navigator?.serviceWorker) {
    root.addEventListener('load', () => {
      root.navigator.serviceWorker.register('/sw.js').catch(error => {
        console.warn('[AutoDJ] Offline caching unavailable:', error.message);
      });
    });
  }
  if (typeof module !== 'undefined') module.exports = UI;
})(typeof window !== 'undefined' ? window : globalThis);
