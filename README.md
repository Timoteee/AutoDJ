<div align="center">

```
 ▄▄▄· ▄• ▄▌▄▄▄▄▄      ·▄▄▄▄  ▄▄  
▐█ ▀█ █▪██▌•██  ▪     ██▪ ██ ▀▄ █·
▄█▀▀█ █▌▐█▌ ▐█.▪ ▄█▀▄ ▐█· ▐█▌▐▀▀▄ 
▐█ ▪▐▌▐█▄█▌ ▐█▌·▐█▌.▐▌██. ██ ▐█•█▌
 ▀  ▀  ▀▀▀  ▀▀▀  ▀█▄▀▪▀▀▀▀▀• .▀  ▀
```

**Intelligent local DJ engine with crossfading, AI queuing, live display, and full Docker support.**

[![Node](https://img.shields.io/badge/node-20%2B-brightgreen?style=flat-square&logo=node.js)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/docker-ready-2496ED?style=flat-square&logo=docker)](https://docker.com)
[![Last.fm](https://img.shields.io/badge/last.fm-free%20API-D51007?style=flat-square)](https://last.fm/api)
[![Spotify](https://img.shields.io/badge/spotify-optional-1DB954?style=flat-square&logo=spotify)](https://developer.spotify.com)

</div>

---

## What is AutoDJ?

You play one song. AutoDJ figures out the rest.

It discovers similar tracks via Last.fm and Spotify, finds them on YouTube, analyzes each track for the best fade point, and crossfades between two virtual decks — automatically, continuously, without you touching anything. Drop it on a second screen, point it at a TV, and walk away.

It has two pages:

| Page | URL | Who it's for |
|------|-----|--------------|
| **DJ Console** | `/dj` | You — full mixer, decks, queue control |
| **Now Playing** | `/display` | Everyone else — big beautiful now-playing screen |

---

## Quick Start

### Docker (recommended)

```bash
# 1. Extract and enter the folder
unzip autodj-v2.4.zip && cd autodj-v2.4

# 2. Drop your music in (optional)
mkdir -p music
cp /your/music/*.mp3 music/

# 3. Launch
docker compose up -d

# 4. Open the DJ console
open http://localhost:3000/dj
```

### Node.js (no Docker)

```bash
npm install
node server.js
```

Requires Node 18+. That's it — no database, no build step, no config required to start.

---

## Features

### 🎛️ DJ Console

Two full virtual decks with real-time waveform visualization and VU meters. Each deck shows the current track's title, artist, album, genre tags, BPM, and remaining time. A crossfader sits between them — drag it manually or let AutoDJ handle it.

**Smart Fade Analysis** — before a track ends, AutoDJ scans its waveform to find the quietest low-energy section in the final stretch. That's where the crossfade starts. The result is a transition that feels intentional rather than abrupt.

**BPM Detection** — live BPM is calculated from the audio waveform and displayed on each deck so you can eyeball compatibility before committing to a mix.

**Cue Points** — mark any position on a track and snap back to it on demand.

### 📋 Queue Engine

The queue shows every track coming up with source badges (LOCAL · TEMP · ONLINE · AUTO), drag-to-reorder handles, and per-track metadata. Queue modes:

- **Local First → Online** — burn through your library, then auto-fill from the internet
- **Online First → Local** — start with discoveries, end with your own tracks
- **Shuffle Mix** — interleave local and online tracks randomly
- **Local Only** — never touch the internet
- **Online Only** — full auto-DJ from seed artist

### 🎵 Music Sources

**Local files** — drag and drop audio files or entire folders directly into the browser. Supports MP3, FLAC, WAV, OGG, M4A, AAC, OPUS, WMA. AutoDJ parses `Artist - Title.mp3` filenames automatically.

**Temp Upload** — upload files that are held in server temp storage for the duration of the session. They're automatically deleted when the queue clears or the server stops. Useful for one-off tracks you don't want to add to your permanent library.

**Server library scan** — point AutoDJ at a folder on the server (e.g. a mounted NAS drive) and it will scan and index everything.

### 🔍 Discovery

**Last.fm** (free) — finds similar artists, genre-tagged tracks, and tracks similar to what's currently playing. The seed tags from your first track are used to keep the entire session genre-coherent.

**Spotify** (free credentials) — search tracks, pull an artist's top songs, or generate Spotify recommendations seeded from any track. Results are matched to YouTube for playback.

**AI Intelligence** (optional) — describe a mood or vibe in plain English and get curated track recommendations from Claude or GPT. "Late night coastal drive" or "high energy but not aggressive" both work. The AI sees your current track, recent history, and genre tags before responding.

### 📺 Now Playing Display

A full-screen display page built for a second monitor or TV. Shows:

- Large track title and artist in bold display type
- Auto-detected genre badge
- Mega progress bar with a yellow **fade zone** marker showing exactly when the crossfade will trigger
- Time elapsed and time remaining countdown
- Next up track preview
- Live clock with date
- Animated side visualizer bars

A scrolling marquee runs across the bottom — fully customizable with your own messages in the Settings tab. Defaults include a rotating set of DJ commentary lines. The marquee pauses on hover.

### 📊 System Stats

Four live stat cards on the Mix tab, polled every 3 seconds:

- **CPU** — usage percentage, core count, model name. Turns red above 85%.
- **RAM** — used/total, process memory footprint. Turns red above 85%.
- **Disk** — used percentage, free space remaining.
- **Temp Queue** — file count, total size of temp uploads, server uptime and platform.

---

## API Keys

Enter all keys in the **Settings tab** — no file editing required. Keys are saved to `config.json` and persist across restarts.

| Service | Cost | Get it |
|---------|------|--------|
| Last.fm | Free | [last.fm/api/account/create](https://www.last.fm/api/account/create) |
| Spotify | Free | [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) |
| Anthropic (Claude) | Paid | [console.anthropic.com](https://console.anthropic.com) |
| OpenAI (GPT) | Paid | [platform.openai.com](https://platform.openai.com) |

You only **need** Last.fm for full auto-DJ. Everything else is optional.

---

## File Structure

```
autodj/
├── server.js          # Express backend — API proxy, file streaming, SSE, system stats
├── dj.html            # DJ Console — mixer, decks, queue, library, discovery, settings
├── display.html       # Now Playing — public display screen
├── engine.js          # Audio engine — Web Audio API, BPM analysis, crossfade, waveform
├── dj.js              # DJ UI logic — queue management, playback, temp uploads
├── package.json
├── Dockerfile
├── docker-compose.yml
├── config.json        # Generated on first save — holds your API keys
└── music/             # Drop local tracks here
```

---

## Docker Configuration

### Using a different port

```yaml
# docker-compose.yml
ports:
  - "8080:3000"   # access at http://localhost:8080
```

### Mounting a music library

```yaml
volumes:
  - /mnt/nas/music:/music:ro      # NAS or external drive
  - ./config.json:/app/config.json
```

### Pre-loading API keys via environment

```bash
# .env
LASTFM_API_KEY=your_key_here
SPOTIFY_CLIENT_ID=your_id
SPOTIFY_CLIENT_SECRET=your_secret
ANTHROPIC_API_KEY=sk-ant-...
```

```bash
docker compose --env-file .env up -d
```

---

## Tips

- **Put `/display` on a TV or second screen** via a browser in fullscreen mode (`F11`). It updates live over SSE — no polling lag.
- **Name your files `Artist - Title.mp3`** for automatic metadata parsing. Works with any separator ` - `.
- **Smart Fade** works best on tracks with a natural outro. For tracks that cut hard, set crossfade duration to 2–3s.
- **Genre Lock** (Settings) keeps auto-discovery from straying too far from the seed genre.
- **Temp uploads are ephemeral by design** — they live in the OS temp directory and are deleted when you clear the queue. Don't use temp for anything you want to keep.
- The **AI queue refill** button works best when you've played a few tracks first, giving the AI enough history context to make good decisions.

---

## Troubleshooting

**Tracks not playing / YouTube not loading**
The app uses Invidious public instances to search YouTube without an API key. These can occasionally be slow or unreachable. Try a different network or VPN if searches consistently fail.

**`ENOENT: no such file or directory, stat '/app/dj.html'`**
Rebuild with `docker compose build --no-cache`. The image has a stale layer.

**`yaml: unmarshal errors` on `docker compose build`**
Your `.dockerignore` file is corrupt. Replace it with the one from this zip — it should contain only plain filenames, one per line, no YAML syntax.

**No audio from local files**
Browser autoplay policies require a user gesture before audio can play. Click the ▶ button on deck A once to unlock playback for the session.

**System stats show N/A**
The `/api/system/stats` endpoint requires the server to be running. Stats are not available in static file mode.

---

<div align="center">

Built with Node.js · Express · Web Audio API · Last.fm · Spotify · YouTube (via Invidious) · Anthropic / OpenAI

*Point it at a song. Walk away. Come back to a perfect mix.*

</div>
