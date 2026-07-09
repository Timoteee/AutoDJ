# AutoDJ v7.0.0 — Source & Download System Redesign

## What Changed

### v7.0.0 (Full System Overhaul)

**New Core Modules:**
- `lib/source-pipeline.js` — Unified source management with health scoring, circuit breakers, proxy rotation
- `lib/duration-sanitizer.js` — Robust duration parsing and validation
- `lib/dedup-filter.js` — Intelligent duplicate detection (videoId, artist spacing, title similarity)
- `lib/preload-gate.js` — Preload blocking to prevent playback gaps
- `lib/retry-manager.js` — Background retry system with configurable attempts
- `lib/ai-scout.js` — AI-powered proxy/source discovery
- `lib/ai-curator.js` — AI-powered playlist curation with taste learning
- `worker.js` — Standalone yt-dlp worker process

**New V7 Features:**
- **Source Health Monitoring** — Real-time health scoring across all instances (MeTube, Invidious, Piped, DAB, Jamendo, Squid)
- **Circuit Breaker** — Auto-disable failing instances for 5 minutes after 3 consecutive failures
- **Proxy Pool Rotation** — Round-robin proxy selection with fresh proxy injection per request
- **Duration Sanitization** — Handles YT livestream placeholders (1000:30), ms values, MM:SS, HH:MM:SS formats
- **Preload Gate** — Blocks playback until N tracks are cached (configurable, default 3)
- **Background Retry** — Auto-retry failed downloads 2 times with exponential backoff (30s, 5min)
- **Manual Retry** — User can manually retry failed downloads from UI
- **Playlist Deduplication** — Prevents duplicates via videoId, artist spacing (5 tracks), title similarity (85%)
- **AI Scout** — Auto-discover proxies and alternative instances when failure rate >50%
- **AI Curator** — Generate flow-aware playlists based on taste profile
- **Failed Downloads Page** — Dedicated UI page to view and retry failed downloads

**New API Endpoints:**
- `GET /api/sources/health` — Source health summary
- `POST /api/queue/dedupe` — Find duplicates in queue
- `POST /api/queue/dedupe/remove` — Remove all duplicates
- `GET /api/downloads/retries` — List retry entries
- `POST /api/downloads/retry/:videoId` — Manual retry
- `POST /api/downloads/clear/:videoId` — Clear failed entry
- `POST /api/ai/scout-proxies` — AI proxy discovery
- `POST /api/ai/curate-playlist` — AI playlist generation
- `POST /api/ai/update-profile` — Update taste profile

**UI Updates:**
- Global status bar in Console (sources, preload, retries, curator)
- Preload progress bar with color-coded status (waiting=yellow, ready=green, timeout=red)
- Source health badges on queue items
- Duration warning indicator (amber) for invalid durations
- Retry button on failed queue items
- Dedupe button in Queue page
- AI Curate button in Queue page
- Failed Downloads page (5th sidebar tab)

**Config Additions:**
```json
{
  "preDownloadCount": 3,
  "preloadTimeoutMs": 120000,
  "downloadRetry": {
    "maxAttempts": 2,
    "backoff": [30000, 300000]
  },
  "dedup": {
    "enabled": true,
    "historyWindow": 200,
    "artistSpacing": 5,
    "titleSimilarityThreshold": 0.85
  }
}
"
}

## Architecture

### Frontend
- `dj.html` (~2600 lines) — Main SPA with V7 status bar, preload progress, failed page
- `display.html` (1245 lines) — Public now-playing display page
- `engine.js` (487 lines) — Client-side Audio Engine

### Backend
- `server.js` (~2000 lines) — Express server with V7 module integration
- `worker.js` — Standalone yt-dlp worker (optional, separate process)

### New Modules (lib/)
- `source-pipeline.js` (351 lines) — Source management
- `duration-sanitizer.js` (82 lines) — Duration validation
- `dedup-filter.js` (219 lines) — Duplicate detection
- `preload-gate.js` (140 lines) — Preload gating
- `retry-manager.js` (163 lines) — Retry management
- `ai-scout.js` (240 lines) — AI proxy scouting
- `ai-curator.js` (160 lines) — AI playlist curation

## Testing

79 tests passing across 4 test files:
- `tests/duration-sanitizer.test.js` — 44 tests
- `tests/dedup-filter.test.js` — 17 tests
- `tests/preload-gate.test.js` — 6 tests
- `tests/retry-manager.test.js` — 12 tests

Run tests: `npm test`

## Deployment

### Quick Start
```bash
cd AutoDJ
npm install
npm start  # or npm run dev
# Open http://localhost:3000/dj
```

### Docker (192.168.1.31)
```bash
# Build and run
ssh root@192.168.1.31
cd /root/AutoDJ
git pull
docker compose build
docker compose up -d

# Or with auto-rebuild
docker compose up -d --build
```

### With Worker Process
```bash
# Terminal 1: Main server
npm start

# Terminal 2: Worker (optional)
node worker.js --port=3001 --cacheDir=./cache --proxyFile=./proxies.json
```

## Configuration

### Environment Variables
```bash
PORT=3000
NODE_ENV=production
CACHE_DIR=./cache
LOG_LEVEL=info

# AI Providers (optional)
ANTHROPIC_KEY=your_key
OPENROUTER_KEY=your_key
OPENROUTER_MODEL=openrouter/auto
OPENAI_KEY=your_key
```

### Config File (config.json)
Generated on first run. Key V7 settings:
- `sourcePriority` — Array of preferred sources
- `preDownloadCount` — Tracks to preload before playback
- `downloadRetry` — Retry configuration
- `dedup` — Deduplication settings
- `aiTasteProfile` — Learned taste profile

## File Structure

```
AutoDJ/
├── server.js              # Main Express server
├── dj.html               # Control room SPA
├── display.html          # Now-playing display
├── engine.js             # Audio engine
├── worker.js             # yt-dlp worker (optional)
├── config.json           # Runtime configuration
├── package.json
├── docker-compose.yml
├── lib/
│   ├── source-pipeline.js
│   ├── duration-sanitizer.js
│   ├── dedup-filter.js
│   ├── preload-gate.js
│   ├── retry-manager.js
│   ├── ai-scout.js
│   └── ai-curator.js
├── tests/
│   ├── duration-sanitizer.test.js
│   ├── dedup-filter.test.js
│   ├── preload-gate.test.js
│   └── retry-manager.test.js
└── docs/
    └── superpowers/
        └── specs/
            └── 2026-07-08-autodj-source-download-redesign.md
```

## Known Issues & Limitations

1. **Region-locked content** — Trinidad IP blocks some YouTube content. Use proxy rotation.
2. **Download success rate** — MeTube fallback chain helps but proxies needed for some regions.
3. **Queue preload** — Only preloads when session starts, not continuously.
4. **AI features** — Require API keys (Anthropic, OpenRouter, OpenAI).
5. **yt-dlp worker** — Optional. Server can download without it using fallback methods.

## Migration from v6

No migration needed. v7 modules are additive:
- Existing v6 functionality preserved
- New V7 features opt-in via config
- Tests verify backward compatibility

## Next Steps

1. Monitor download success rates with new retry system
2. Tune preload count based on network speed
3. Add more sources (Spotify via API, SoundCloud)
4. Expand AI curation with genre/BPM analysis
5. Add user preferences for source ordering
