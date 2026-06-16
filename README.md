<div align="center">

```
 ▄▄▄· ▄• ▄▌▄▄▄▄▄      ·▄▄▄▄  ▄▄  
▐█ ▀█ █▪██▌•██  ▪     ██▪ ██ ▀▄ █·
▄█▀▀█ █▌▐█▌ ▐█.▪ ▄█▀▄ ▐█· ▐█▌▐▀▀▄ 
▐█ ▪▐▌▐█▄█▌ ▐█▌·▐█▌.▐▌██. ██ ▐█•█▌
 ▀  ▀  ▀▀▀  ▀▀▀  ▀█▄▀▪▀▀▀▀▀• .▀  ▀
```

**v6.0.0** — "Signal & Flow" Redesign — Fully responsive SPA, reworked backend, configurable crossfade, new Discovery engine, complete design overhaul.

[![Node](https://img.shields.io/badge/node-22%2B-brightgreen?style=flat-square&logo=node.js)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/docker-ready-2496ED?style=flat-square&logo=docker)](https://docker.com)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)]()

</div>

---

## What is AutoDJ?

AutoDJ is the DJ that never clocks out. You seed it with an artist or a mood, it discovers similar tracks, finds working copies across half a dozen music sources, downloads them to a local cache, and crossfades between two virtual decks — endlessly. No cloud service, no subscription, no monthly bill.

Open the **DJ Console** to control the mix. Put the **Now Playing** display on a second screen or a TV. Close the console tab — the music keeps going. The server runs independently.

| Page | URL | What it does |
|------|-----|--------------|
| DJ Console | `/dj` | 4-page SPA: Decks A/B (Console), Queue, Discovery, System Settings — Signal & Flow design |
| Now Playing | `/display` | Full-screen display with artwork, 24-band VU meter, synced lyrics, RSS marquee, relay audio |

---

## Quick Start

### Docker (recommended)

```bash
docker compose up -d
open http://localhost:3000/dj
```

### Node.js (no Docker)

```bash
node --version   # must be v22+
npm install
node server.js
# Open http://localhost:3000/dj
```

No database. No build step. First-time: open Settings, add a Last.fm API key (free), set a seed artist on the Discover tab, and play.

---

## Music Sources

AutoDJ searches six sources in priority order. Each track is downloaded to a local cache so stream URLs never expire mid-song.

| Source | Type | API key needed? | Status |
|--------|------|-----------------|--------|
| **MeTube** | Sidecar container | No | Best reliability — uses native YouTube-dl. Auto-falls back to other sources on failure. |
| **Invidious** | YouTube proxy | No | 3 verified-working public instances |
| **Piped** | YouTube proxy | No | 1 verified-working public instance |
| **DAB** | Direct download | No | 2 instances (Cloudflare-blocked from some networks) |
| **Jamendo** | Royalty-free music | Free client ID | Optional — great for copyright-safe discovery |
| **Squid** | Squid-based proxy | No | Experimental |

**MeTube retry logic:** When a download fails (video locked, topic unavailable, error page), the system automatically marks that video ID as failed, cleans up the placeholder file, and falls through to alternative sources like Invidious or Piped. If alternative video IDs are provided, it tries those next. Failed IDs get a 30-minute cooldown before being retried.

---

## Features

### Signal & Flow Design System
Complete visual overhaul with `#ffb3ac` (signal red) and `#a6e6ff` (electric blue) accents, dark layered surfaces (`#0e0e0e` → `#353534`), and responsive 12-column grid. Inter for body, JetBrains Mono for labels, Space Grotesk for headlines.

### Two Virtual Decks
Real-time waveform, BPM display with tap button, VU meters, cue points, reverse, loop, crossfader. Smart Fade Analysis scans the waveform to find the quietest point before each transition. Deck A glows signal red, Deck B glows flow blue.

### Configurable Crossfade
Crossfade duration adjustable from 1-10 seconds in Settings, or via the FADE (S) spinbutton on Console. Smart Fade mode detects optimal fade points automatically.

### 4-Page Single Page App
- **Console** — Dual decks with transport controls, crossfader, BPM tap, session timer, system stats dashboard
- **Queue** — Track list with drag-reorder, search/add, file/folder upload, shuffle, AI refill, mode selector (Local First / Online First / Shuffle Mix / Local Only / Online Only)
- **Discovery** — Search across all sources, Mood Engine (CHILL/ENERGY/DEEP presets), AI Recommendation panel
- **Settings** — API credentials, playback config, source priority drag-reorder, RSS feed, display messages, live log viewer

### Queue Engine
Drag to reorder. Source badges show where each track came from. Queue persists across page reloads with backup file for crash safety. Unified search hits every source at once. Queue limit caps total tracks. New `POST /api/queue/reorder` endpoint for server-side reordering.

### Persistent Playback
The display page is a dedicated audio player. Close the DJ console — playback keeps going. The server auto-advances: `advanceTrack()`, `preCacheNextTrack()`, playback timer, SSE broadcasts. Queue and track index survive server restarts.

### Discovery
- **Last.fm** (free) — similar artists and genre-tagged recommendations
- **Spotify** (free credentials) — artist top tracks, recommendations from any seed track
- **AI** (optional) — describe a mood in plain English. Supports Claude, GPT, OpenCode Zen, and OpenRouter with any compatible model

### Now Playing Display
Full-screen: large artwork, track info, animated orbs, synced lyrics, mega progress bar with fade zone marker, next-up preview, live clock, marquee (RSS headlines + custom messages), visualizer bars.

### Session Controls
Set a session duration (hours) and queue limit. Mix tab shows remaining time and queue count. Session auto-stops when time expires.

### Listener Tracking
See every device connected to the display: IP, browser, OS, device type, page, connection duration. Auto-refreshes every 5 seconds.

### PWA Ready
Installable as a standalone app. Manifest, service worker with app shell caching, icons.

### OpenCode Zen + OpenRouter
Pre-configured model dropdown with curated options for free-tier and paid models. OpenRouter supports any OpenAI-compatible endpoint — bring your own base URL and model name.

---

## First-Time Setup

1. Open `http://localhost:3000/dj`
2. Go to **Settings** tab
3. Add a **Last.fm API key** (free at [last.fm/api](https://www.last.fm/api))
4. Optionally add Spotify, Jamendo, or AI provider keys
5. Click **Save Settings**
6. Go to **Discover** tab, enter a seed artist, click **Start Discovery**
7. Go to **Mix** tab and press play

---

## Docker Configuration

### Custom port
```yaml
ports:
  - "8080:3000"   # access at http://localhost:8080
```

### Mount music library
```yaml
volumes:
  - /mnt/nas/music:/music:ro
  - ./config.json:/app/config.json
```

### Environment variables (all optional)
```bash
LASTFM_API_KEY=your_key
SPOTIFY_CLIENT_ID=your_id
SPOTIFY_CLIENT_SECRET=your_secret
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
OPENCODE_API_KEY=oc_...
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=openrouter/auto
METUBE_URL=http://metube:8081
METUBE_DOWNLOADS_DIR=/metube_downloads
PORT=3000
```

---

## Tips

- Put `/display` on a second screen in fullscreen (F11). Updates live over SSE.
- Persistent playback: open the display page, enable audio, then close the DJ tab.
- Name local files `Artist - Title.mp3` for automatic metadata parsing.
- Temp uploads are ephemeral — auto-deleted when the queue clears.
- When a source fails, AutoDJ falls through to the next one. Check Settings > Test Sources if nothing plays.

---

## Troubleshooting

**Nothing plays / searches fail** — Music source instances go down. Try a different network or VPN. Check Settings > Test Sources to see which are up.

**Display shows "Enable Audio" but no sound** — Browsers require a click to start audio. Re-enable after page refresh.

**Docker build errors** — Run `docker compose build --no-cache` to clear stale layers.

**No audio from local files** — Click play on deck A once to unlock browser autoplay.

**MeTube downloads but audio never plays** — The file was likely a placeholder for a locked/blocked video. AutoDJ detects this, discards it, and tries other sources automatically.

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/config` | Get current config |
| POST | `/api/config` | Update config |
| GET | `/api/youtube/search?q=` | Unified search across all sources |
| GET | `/api/system/stats` | CPU / RAM / disk / temp / session / queue |
| GET | `/api/status` | Full system status (version, memory, session, queue, sources, cache) |
| POST | `/api/cache/download` | Download track to local cache (supports `altIds` for fallback) |
| GET | `/api/cache/stream/:id` | Stream cached audio (range requests) |
| GET | `/api/lyrics?title=&artist=` | Get synced lyrics from LRCLIB |
| GET | `/api/nowplaying/stream` | SSE stream for live state |
| POST | `/api/playback/start` | Start auto-advance engine |
| POST | `/api/playback/stop` | Stop playback |
| POST | `/api/playback/next` | Advance to next track |
| POST | `/api/playback/skip` | Skip current track |
| POST | `/api/playback/trackinfo` | Get detailed track metadata |
| POST | `/api/queue/reorder` | Reorder queue items `{from, to}` |
| POST | `/api/queue/remove/:index` | Remove track at index |
| POST | `/api/queue/clear` | Clear queue |
| GET | `/api/discovery/seeds` | Seed genres/artists from config |
| GET | `/api/discovery/trending` | Trending tracks from Jamendo |
| GET | `/api/discovery/recommendations?seed=` | AI-powered recommendations |
| GET | `/api/local/scan` | Scan music directories |
| POST | `/api/ai/recommend` | AI-powered recommendations (supports Anthropic, OpenAI, OpenCode, OpenRouter) |
| GET | `/api/test/sources` | Test all music source reachability |
| GET | `/api/listeners` | Connected listener stats |
| GET | `/api/logs` | Server log ring buffer |
| GET | `/api/rss` | RSS feed for marquee |

---

## File Structure

```
├── server.js          Express backend (routes, sources, cache, auto-advance, SSE)
├── engine.js          Browser audio engine (WebAudio, crossfade, waveform, WebRTC)
├── dj.html            4-page SPA (Console, Queue, Discovery, Settings) — inline JS + TailwindCSS
├── display.html       Now-playing display (VU meter, lyrics, marquee, album art, WebRTC)
├── sw.js              Service worker (app shell caching)
├── manifest.json      PWA manifest
├── css/shared.css     Shared baseline styles
├── package.json       Dependencies (express, cors, multer, compression)
├── Dockerfile         node:22-alpine
├── docker-compose.yml Mounts music/, cache/, config.json
├── config.json        Runtime config (populated via Settings UI)
├── HANDOFF.md         Full project handoff (architecture, changelog, API ref)
└── .env.example       Environment variable template
```

---

<div align="center">

Built with Node.js · Express · Web Audio API · Last.fm · Spotify · Invidious · Piped · DAB · LRCLIB · Anthropic / OpenAI / OpenCode / OpenRouter

*Point it at a song. Walk away. Come back to a perfect mix.*

</div>
