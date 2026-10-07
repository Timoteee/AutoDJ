'use strict';
const fs = require('node:fs');
class ListeningHistory {
  constructor(file) {
    this.file = file;
    this.events = []; this.likes = [];
    try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); this.events = (Array.isArray(data) ? data : data.events || []).slice(-1000); this.likes = Array.isArray(data.likes) ? data.likes.slice(-2000) : []; } catch { /* New or damaged history starts empty. */ }
  }
  record(track) {
    if (!track.artist || !track.title) return;
    if (track.eventId && this.events.some(e => e.eventId === track.eventId)) return;
    this.events.push({ eventId: String(track.eventId || '').slice(0,100), artist: String(track.artist).slice(0,200), title: String(track.title).slice(0,300), videoId: String(track.videoId || ''), listenRatio: Math.max(0, Math.min(1, Number(track.listenRatio) || 0)), skipped: !!track.skipped, time: Date.now() });
    this.events = this.events.slice(-1000);
    this.save();
  }
  save() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ events: this.events, likes: this.likes }));
    fs.renameSync(this.file + '.tmp', this.file);
  }
  key(t) { return `${String(t.artist || '').toLowerCase()}::${String(t.title || '').toLowerCase()}`; }
  setLike(track, liked) {
    const key = this.key(track);
    this.likes = this.likes.filter(t => this.key(t) !== key);
    if (liked && track.artist && track.title) this.likes.push({ artist: String(track.artist).slice(0,200), title: String(track.title).slice(0,300), videoId: String(track.videoId || '').slice(0,100) });
    this.likes = this.likes.slice(-2000); this.save();
  }
  seeds(now = Date.now()) {
    const artists = new Map();
    for (const t of this.likes) {
      const key = t.artist.toLowerCase(), entry = artists.get(key) || { artist:t.artist,title:t.title,score:0 };
      entry.score += 2; artists.set(key,entry);
    }
    for (const e of this.events) {
      const key = e.artist.toLowerCase();
      const entry = artists.get(key) || { artist: e.artist, title: e.title, score: 0 };
      const recency = Math.exp(-Math.max(0, now - e.time) / (30 * 86400000));
      entry.score += (e.skipped ? -.7 : e.listenRatio) * recency;
      if (!e.skipped && e.listenRatio > .5) entry.title = e.title;
      artists.set(key, entry);
    }
    return [...artists.values()].filter(e => e.score > .2).sort((a,b) => b.score-a.score).slice(0,3);
  }
}
module.exports = { ListeningHistory };
