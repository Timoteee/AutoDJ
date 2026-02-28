# AutoDJ v4.0

Web-based dual-deck DJ console with auto-mixing, multi-source track discovery, and a live display page.

## Quick Start

```bash
npm install
node server.js
```

Open `http://localhost:3000`. Default login: `admin` / `adminroot123`.

## Features

- **Dual decks** with waveform viz, BPM detection, smart fade points, auto-crossfade
- **Multi-source music** — Monochrome HiFi, Piped, Invidious, DAB/Zozoki (10+ instances, health-checked)
- **Discovery** — Last.fm similar tracks, MusicBrainz, Discogs, AI recommendations
- **Playlists** — save/load/delete named playlists
- **Song requests** — listeners submit from display page, DJ approves
- **Keyboard shortcuts** — Space, A/B, arrows, Q, Esc, ?
- **Display page** (`/display`) — live now-playing with blurred background art, recently played, RSS marquee
- **Dual audio relay** — display mirrors DJ crossfading via Web Audio API
- **Health monitoring** — all music sources tested with latency tracking in Settings

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3000) |
| `LASTFM_API_KEY` | Last.fm API key for discovery |
| `SPOTIFY_CLIENT_ID` | Spotify (optional) |
| `SPOTIFY_CLIENT_SECRET` | Spotify (optional) |
| `ANTHROPIC_API_KEY` | AI recommendations |
| `OPENAI_API_KEY` | AI alternative |
| `MUSIC_DIR` | Local music path |

## Docker

```bash
docker build -t autodj .
docker run -p 3000:3000 -v ./playlists:/app/playlists -v ./music:/app/music autodj
```

## API

- `GET /api/health` — uptime, listeners, instance status
- `GET /api/search/all?q=...` — unified multi-source search
- `POST /api/requests` — song request
- `GET /api/nowplaying/stream` — SSE playback state

## License

MIT
