<div align="center">

```
 ▄▄▄· ▄• ▄▌▄▄▄▄▄      ·▄▄▄▄  ▄▄  
▐█ ▀█ █▪██▌•██  ▪     ██▪ ██ ▀▄ █·
▄█▀▀█ █▌▐█▌ ▐█.▪ ▄█▀▄ ▐█· ▐█▌▐▀▀▄ 
▐█ ▪▐▌▐█▄█▌ ▐█▌·▐█▌.▐▌██. ██ ▐█•█▌
 ▀  ▀  ▀▀▀  ▀▀▀  ▀█▄▀▪▀▀▀▀▀• .▀  ▀
```

**v4.4 — OpenCode Zen, persistent queue, Spotify-inspired UI, light/dark mode, PWA support, full codebase audit + security hardening.**

[![Node](https://img.shields.io/badge/node-22%2B-brightgreen?style=flat-square&logo=node.js)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/docker-ready-2496ED?style=flat-square&logo=docker)](https://docker.com)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)]()

</div>

---

## What is AutoDJ?

You play one song. AutoDJ figures out the rest.

It discovers similar tracks via Last.fm and Spotify, finds them on YouTube/Invidious/Piped/DAB/HiFi, downloads each track to a local cache, analyzes it for the best fade point, and crossfades between two virtual decks — automatically, continuously, without you touching anything. Drop it on a second screen, point it at a TV, and walk away.

**Persistent playback:** Close the DJ console tab — the Now Playing display keeps playing. The server auto-advances the queue independently.

Two pages:

| Page | URL | Who it's for |
|------|-----|--------------|
| **DJ Console** | `/dj` | You — full mixer, decks, queue control, settings |
| **Now Playing** | `/display` | Everyone else — big beautiful now-playing screen with relay audio |

---

## Quick Start

### Docker (recommended)

```bash
docker compose up -d
open http://localhost:3000/dj
```

### Node.js (no Docker)

```bash
node --version  # must be v22+
npm install
node server.js
# Open http://localhost:3000/dj
```

No database. No build step. First-time setup: open Settings, add a Last.fm API key (free), set a seed artist on the Discover tab, and play.

---

## Features

### 🎛️ DJ Console
Two virtual decks with real-time waveform, BPM display, VU meters, cue points, and a crossfader. Live deck glows red. Smart Fade Analysis scans the waveform to find the quietest fade point before each transition.

### 📋 Queue Engine
Drag-to-reorder queue with source badges. Queue persists across page reloads. Unified search lets you search all music sources at once. Queue limit setting caps total tracks.

### 🔍 Music Sources
Six lanes tried in priority order: **Invidious** → **Piped** → **DAB** → **Jamendo** (optional) → **HiFi** → **MeTube** (sidecar). YouTube -Topic channels filtered by default (toggle in Settings). All downloads cached locally so stream URLs never expire mid-track.

### 🧠 Discovery
- **Last.fm** (free) — similar artists, genre-tagged recommendations
- **Spotify** (free credentials) — artist top tracks, recommendations seeded from any track
- **AI** (optional Claude/GPT/OpenCode/OpenCode Zen) — describe a mood in plain English

### 📺 Now Playing Display
Full-screen display with large artwork, track info, animated orbs, lyrics (synced LRC), mega progress bar with fade zone marker, next-up preview, live clock, marquee (RSS headlines + custom messages), and side visualizer bars.

### 🔊 Persistent Playback
The display page acts as a dedicated audio player. Close the DJ console — audio keeps going. The server runs an auto-advance engine: `advanceTrack()`, `preCacheNextTrack()`, playback timer. SSE broadcasts `play`/`stop` commands. Queue and track index persist to disk.

### 🎨 Spotify-Inspired UI
Green accent palette (`#1db954`). Light/dark mode with system preference detection and manual toggle (saved to localStorage). Smooth CSS transitions between themes. Responsive layout for mobile.

### ⏱️ Session Controls
Set a session duration (hours) and queue limit (tracks) in Settings. Mix tab shows live indicators: remaining session time and queue count/limit. Session auto-stops when time expires.

### 📱 PWA Ready
Installable as a standalone app. Manifest, service worker with app shell caching, icons, and PWA meta tags on both pages.

### 📊 System Stats
Live stat cards on the Mix tab: CPU, RAM, Disk, Temp Storage, Session, Queue — polled every 3 seconds.

### 👥 Listener Tracking
**Listeners tab** shows every device connected to the Now Playing display: IP, browser (Chrome/Firefox/Safari/Edge), OS (Windows/macOS/Linux/Android/iOS), device type (mobile/tablet/desktop), page, and connection duration. Auto-refreshes every 5 seconds.

### 🎵 OpenCode Zen Integration
Pre-configured model dropdown with categorized optgroups: **Free tier** (DeepSeek V4 Flash, MiniMax M2.5, GPT-5 Nano, Big Pickle), **GPT Series** (5.5 Pro through GPT-5), **Claude** (Opus/Sonnet/Haiku), **Other** (Gemini, GLM, Kimi, Qwen, MiniMax). Set base URL to `https://opencode.ai/zen/v1` for Zen models.

### 🆕 v4.4 UI Improvements
- **NEXT UP card** in Mix tab — prominent card for the next track with Play Now and Cue B buttons
- **Now Playing card** in Mix tab — shows current track artwork, title, artist, elapsed timer
- **Queue "Play Now"** — each queue row has a direct play button
- **Search thumbnails** — online search results show small thumbnail images with bold titles
- **Layout fixes** — responsive sidebar, scrollbar styles, overflow handling
- **Download dedup** — server-side dedup prevents concurrent cache-download of the same `videoId`
- **Settings scrolling** — long settings forms scroll within the panel instead of overflowing
- **Display/DJ queue sync** — trackIndex passed client→server for consistent skip behavior

### 🔒 Security Hardening (v4.4 audit)
- **Path traversal fix** — `/api/local/stream` uses `path.resolve()` before validation
- **SSRF protection** — `/api/piped/relay` and `/api/rss` reject private IPs, protocol-relative URLs, embedded credentials
- **Rate limiting** — in-memory limiter on download, search, AI, and upload endpoints
- **WebRTC auth** — signaling endpoints gated by same-origin check
- **Path leak fix** — `/api/local/scan` returns relative paths instead of absolute server paths
- **Content-type mapping** — proper extension mapping for ogg, flac, wav, aac
- **playedIds pruning** — capped at 2000 entries to prevent unbounded array growth
- **Config parse warnings** — malformed config.json now surfaces error in logs

---

## First-Time Setup

1. Open `http://localhost:3000/dj`
2. Go to **Settings** tab
3. Add a **Last.fm API key** (free at [last.fm/api](https://www.last.fm/api)) — enables Discovery
4. Optionally add **Spotify**, **Jamendo**, **Anthropic/OpenAI/OpenCode Zen** keys
5. Click **Save Settings**
6. Go to **Discover** tab, enter a seed artist, click **Start Discovery**
7. Go to **Mix** tab and press ▶

---

## API Reference (Key Endpoints)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/config` | Get current config |
| POST | `/api/config` | Update config |
| GET | `/api/youtube/search?q=` | Unified search across all sources |
| GET | `/api/system/stats` | CPU / RAM / disk / temp / session / queue |
| POST | `/api/cache/download` | Download track to local cache |
| GET | `/api/cache/stream/:id` | Stream cached audio (range requests) |
| GET | `/api/lyrics?title=&artist=` | Get synced lyrics from LRCLIB |
| GET | `/api/nowplaying/stream` | SSE stream for live state |
| POST | `/api/playback/start` | Start auto-advance engine |
| POST | `/api/playback/stop` | Stop playback |
| POST | `/api/playback/next` | Advance to next track |
| POST | `/api/nowplaying/clear` | Clear current track |
| GET | `/api/local/scan` | Scan music directories |

---

## File Structure

```
autodj-v4/
├── server.js          ← Express backend (routes, sources, cache, auto-advance, SSE)
├── engine.js          ← Browser audio engine (WebAudio, crossfade, waveform, BPM, WebRTC)
├── dj.js              ← DJ console UI (queue, decks, settings, theme, playback, WebRTC)
├── dj.html            ← DJ console HTML + CSS (Spotify-inspired, light/dark)
├── display.html       ← Now-playing display (relay audio, lyrics, marquee, theme, WebRTC)
├── sw.js              ← Service worker (app shell caching)
├── manifest.json      ← PWA manifest
├── css/shared.css     ← Shared baseline
├── icons/             ← App icons (SVG + 192/512 PNG)
├── package.json       ← Dependencies (express, cors, multer, fast-xml-parser)
├── Dockerfile         ← node:22-alpine
├── docker-compose.yml ← Mounts music/, cache/, config.json
├── config.json        ← Runtime config (populated via Settings UI)
├── HANDOFF.md         ← Project handoff document (full API ref, architecture, history)
└── scripts/           ← Probe/utility scripts
```

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
OPENCODE_BASE_URL=https://api.opencode.ai/v1
PORT=3000
MUSIC_DIR=/path/to/music
METUBE_URL=http://metube:8081
METUBE_DOWNLOADS_DIR=/metube_downloads
```

---

## Tips

- **Put `/display` on a second screen** in fullscreen (`F11`). Updates live over SSE.
- **Persistent playback:** Open the display page, enable audio, then close the DJ tab. The display keeps playing.
- **Name files `Artist - Title.mp3`** for automatic metadata parsing.
- **Smart Fade** works best on tracks with natural outros. Set crossfade to 2-3s for hard cuts.
- **Temp uploads** are ephemeral — auto-deleted when queue clears.
- **Theme toggle** in the topbar — cycles light/dark. Respects system preference by default.
- **WebRTC Share Audio** — stream audio to the display page over WebRTC (experimental, same-LAN only).

---

## Troubleshooting

**Nothing plays / searches fail** — Invidious/Piped instances may be down. Try a different network or VPN. Check Settings → Test Sources.

**Display shows "Enable Audio" but no sound** — Browser requires a user gesture. Click the button. Audio must be re-enabled after page refresh.

**Docker build errors** — Run `docker compose build --no-cache` to clear stale layers.

**No audio from local files** — Click ▶ on deck A once to unlock browser autoplay.

---

<div align="center">

Built with Node.js · Express · Web Audio API · Last.fm · Spotify · Invidious · Piped · DAB · LRCLIB · Anthropic / OpenAI / OpenCode

*Point it at a song. Walk away. Come back to a perfect mix.*

</div>
