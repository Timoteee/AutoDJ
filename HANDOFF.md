# AutoDJ v6.0.0 — Signal & Flow Redesign

## What Changed

### v6.0.0 (MVP Release)
- **Complete frontend redesign** — "Signal & Flow" design system with `#ffb3ac` (signal red) and `#a6e6ff` (electric blue) primary colors
- **Responsive layout** — Fixed sidebar, top bar, 12-column grid, mobile bottom-nav fallback
- **4-page SPA** — Console (dual-deck DJ), Queue Management, Discovery Engine, System Settings
- **Backend fixes** — Config atomicity, queue backup, input validation, rate limiting, error middleware
- **New API endpoints** — `GET /api/status`, `GET /api/discovery/seeds`, `GET /api/discovery/trending`, `GET /api/discovery/recommendations`, `POST /api/queue/reorder`, `POST /api/playback/skip`, `POST /api/playback/trackinfo`
- **Display page redesign** — Full-screen now-playing with album art, VU meters, queue, RSS marquee
- **Crossfade duration** — Configurable via `crossfadeSeconds` (1-10s, default 3s)
- **Engine.js unchanged** — Audio engine, waveform, BPM detection, crossfade, WebRTC all intact
- **Removed dead code** — `dj.js` (88KB) replaced by inline JS in `dj.html`
- **npm dependencies unchanged** — Express, CORS, compression, multer, fast-xml-parser

## Architecture

### Frontend
- `dj.html` (2237 lines) — Main SPA with TailwindCSS CDN + custom design system
- `display.html` (1245 lines) — Public now-playing display page
- `engine.js` (487 lines) — Client-side Audio Engine (unchanged)

### Backend
- `server.js` (1831 lines) — Express server with all API routes, middleware, config management

## API Endpoints

### Core
- `GET /` → redirects to `/dj`
- `GET /display` → now-playing display
- `GET /engine.js` → client audio engine
- `GET /sw.js` → service worker

### Playback
- `POST /api/playback/start|stop|next`
- `POST /api/playback/event` — track ended events
- `POST /api/playback/played` — mark track as played
- `POST /api/playback/trackinfo` — get detailed track info
- `POST /api/playback/skip` — skip current track

### Queue
- `GET /api/queue` — get current queue
- `POST /api/queue` — set queue
- `POST /api/queue/remove/:index` — remove track at index
- `POST /api/queue/clear` — clear queue
- `POST /api/queue/reorder` — reorder {from, to}

### Discovery
- `GET /api/discovery/seeds` — seed genres/artists/tags
- `GET /api/discovery/trending` — trending from Jamendo
- `GET /api/discovery/recommendations?seed=xxx` — AI recommendations

### Cache
- `POST /api/cache/download` — download single track
- `POST /api/cache/downloadBatch` — batch download
- `GET /api/cache/stream/:id` — stream cached audio
- `POST /api/cache/verify` — verify cached file
- `GET /api/cache/list` — list cached files
- `GET /api/cache/cleanup` — clean old cache

### Now Playing / SSE
- `GET /api/nowplaying` — get current state
- `POST /api/nowplaying/update` — broadcast update
- `GET /api/nowplaying/stream` — SSE real-time feed

### Config
- `GET /api/config` — get all config
- `POST /api/config` — save config

### System
- `GET /api/status` — full system status (v6 new)
- `GET /api/system/stats` — system resource stats
- `GET /api/test/sources` — test all music sources
- `GET /api/logs` — server log ring buffer
- `GET /api/listeners` — connected listeners

### Video/Search
- `GET /api/youtube/search?q=...` — search YouTube
- `GET /api/piped/relay` — Piped relay
- `GET /api/spotify/:endpoint` — Spotify API proxy
- `GET /api/lastfm` — Last.fm API proxy

### Local Files
- `POST /api/temp/upload` — upload files
- `GET /api/temp/list` — list temp uploads
- `GET /api/local/scan` — scan music directory
- `GET /api/local/stream/:id` — stream local file
- `GET /api/lyrics?artist=...&title=...` — get lyrics
- `GET /api/rss` — RSS feed for marquee

## Design System

```
--signal: #ffb3ac     (primary red)
--flow:   #a6e6ff     (secondary blue)
--bg:     #131313      (dark background)
--surface: #0e0e0e    (lowest surface)
--surface-highest: #353534 (highest surface)
--text: #f0eee9       (main text)
--text-muted: #8a8882 (muted text)
```

## Deployment

```bash
npm install
npm start
# → http://localhost:3000
```

## Credits

- Redesign proposal by Timo T (original design mockups in `stitch_autodj_dashboard_ui/` and sibling directories)
- Implementation by Hermes Agent (Nous Research)
