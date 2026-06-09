# AutoDJ v5.0.0 — Project Handoff Document

> **v5.0.0 rework (June 2026):** Dead sources pruned (HiFi removed, Piped/Invidious culled to working only), duration parsing hardened, OpenRouter AI provider added, compression middleware, graceful shutdown, version bumped. See changelog at bottom.

> **For anyone picking this up cold.** Read this fully before touching code.

---

## What Is This?

AutoDJ is a **self-hosted web-based DJ application** that runs as a Node.js server. It has two browser interfaces:

- **`/dj`** — The DJ console: decks A/B, waveforms, crossfader, queue management, discovery engine, settings
- **`/display`** — The now-playing display: full-screen art, track info, animated visuals, lyrics, marquee — meant to be shown on a screen behind the DJ or streamed as an overlay

The core loop: search for a song → it downloads to a local cache → plays from that cached file → auto-advances through the queue → auto-discovers similar tracks via Last.fm. No user accounts, no database. Config lives in `config.json`.

---

## Architecture

```
Browser (dj.html + dj.js)          Browser (display.html)
         │                                    │
         │  REST + SSE                        │  SSE
         ▼                                    ▼
    Node.js Express Server (server.js)
         │
         ├── Music Search: Invidious → Piped → DAB → Jamendo (optional) → HiFi
         ├── Audio Download: fetches from source → saves to ./cache/ (safe filenames)
         ├── Audio Serve: /api/cache/stream/:id (range requests; id may be URL-encoded)
         ├── Lyrics: LRCLIB API → /api/lyrics
         ├── Now Playing SSE: /api/nowplaying/stream (pushes to display)
         ├── Last.fm: /api/lastfm (proxied)
         ├── Spotify: /api/spotify/* (proxied)
         └── AI: /api/ai/recommend (Anthropic / OpenAI)
```

### Key Files

| File | Purpose |
|------|---------|
| `server.js` | All server-side logic: routes, music sources, download cache, lyrics |
| `engine.js` | Client-side audio engine: WebAudio, crossfade, waveform, BPM, Last.fm, ID3 |
| `dj.js` | DJ console UI logic: decks, queue, discovery, settings |
| `dj.html` | DJ console HTML + inline CSS (links `css/shared.css`) |
| `display.html` | Now-playing display HTML + CSS + script |
| `css/shared.css` | Minimal shared baseline (box-sizing, media defaults) |
| `config.json` | Runtime config (API keys, music dirs) — gitignored in production |
| `cache/` | Downloaded audio files (managed automatically) |
| `music/` | Mount point for local music library |

---

## Tech Stack

- **Runtime:** Node.js 22+ (native `fetch` required — do NOT downgrade)
- **Server:** Express 4, Multer, CORS
- **Audio:** Web Audio API (browser-side), `<audio>` elements
- **Streaming:** `stream/promises.pipeline()` + `Readable.fromWeb()` for downloads
- **No database.** All state is in-memory or in `config.json`.
- **No auth.** The `/dj` route is wide open. Add reverse proxy auth if needed.

---

## Music Source Stack (Priority Order)

Unified search (`GET /api/youtube/search`) tries lanes ordered by `config.sourcePriority` (default: invidious → piped → dab → jamendo → hifi). `getHealthy()` rotates instances by recent success/latency.

**Live check (May 2026, from this codebase’s probe scripts):** `inv.thepixora.com` and `yt.chocolatemoo53.com` returned JSON search results for mainstream queries (e.g. Drake, Kashif). `api.piped.private.coffee` search worked; its `/streams/{id}` often **500**s — downloads therefore try **Invidious before Piped**. `dabmusic.xyz` returned Cloudflare interstitial (**403**) to server-side `fetch` (no bypass). **Jamendo** only indexes CC/indie uploads — expect **no** major-label hits (Drake, Kashif, etc.).

All outbound music `fetch` calls use a **Chrome-like `MUSIC_UA`** header (`server.js`) because several CDNs treat non-browser agents harshly.

**Track IDs:** The client field is still named `youtubeId` for history, but values may be **namespaced** (for example `jamendo:123456`) for non-YouTube providers. Cache files use a **sanitized basename** on disk; stream URLs use `encodeURIComponent` so colons survive in paths.

### 1. Invidious (PRIMARY for search — YouTube metadata + `videoId`)
- **Order:** `inv.thepixora.com`, `yt.chocolatemoo53.com`, then fallbacks (`yewtu.be`, `inv.nadeko.net`, …).
- **Search:** `GET /api/v1/search?q=...&type=video`
- **Stream (download):** `GET /api/v1/videos/{id}` → `adaptiveFormats` audio URLs (temporary; always cached server-side)

### 2. Piped (YouTube — search; streams secondary)
- **Order:** `api.piped.private.coffee` first (from official piped-instances list), then legacy public APIs.
- **Search:** `GET /search?q=...&filter=videos`
- **Stream:** `GET /streams/{videoId}` — often blocked or 500; Invidious tried first on cache download.

### 3. DAB Music API
- **Search:** tries `q=` then `query=`; response must be JSON (HTML/CF challenge skipped).
- **Instances:** `https://dabmusic.xyz/api`, `https://dab.yeet.su/api`
- **Stream:** `GET /stream?trackId={id}&quality=5`

### 4. Jamendo (OPTIONAL — indie/CC only)
- **Requires:** `jamendoClientId` / `JAMENDO_CLIENT_ID`
- **Not for:** chart / major-label back catalog.

### 5. HiFi-API (Tidal-style community frontends)
- **Search:** `GET /search/?query={q}&type=track&limit=5`
- **Stream:** `GET /track/?id={id}&quality=LOSSLESS`

### 6. LRCLIB (LYRICS ONLY)
- **Base:** `https://lrclib.net/api`

---

## The Download Cache

This is the critical piece that makes playback work reliably.

**Why it exists:** Piped/Invidious stream URLs expire in minutes. Playing them directly means the audio cuts out mid-song. DAB URLs may also be temporary. Solution: download the full audio file to disk first, then serve it locally.

**How it works:**
1. `POST /api/cache/download` is called by the client when loading a track onto a deck
2. Server resolves stream URL from appropriate source (DAB/HiFi/Piped/Invidious)
3. Downloads full audio file using `pipeline(Readable.fromWeb(response.body), createWriteStream(filepath))`
4. Returns `{ url: "/api/cache/stream/{videoId}" }`
5. Client plays from that local URL — no expiry issues, full range request support
6. When track finishes: `POST /api/cache/played` marks it as played
7. `cleanCache()` deletes the oldest played files once more than 4 played files accumulate

**Cache location:** `./cache/` (created automatically)

**CRITICAL Node.js issue:** Do NOT use `.pipe()` or `response.body.getReader()` for downloading. Use `pipeline()` from `stream/promises`. The old approach caused CVE-2024-24750 memory leaks and silent failures. Current code is correct.

---

## How a Track Plays (Full Flow)

```
User clicks "▶" or queue starts auto-playing
         │
         ▼
loadTrackOnDeck(deck, track)
         │
         ├─ If track.type === 'local' or 'temp':
         │    audio.src = track.url  (local file path or temp upload URL)
         │
         └─ If track.type === 'online' (track.youtubeId set):
              POST /api/cache/download
              {videoId, title, artist, _source, _instance}
                    │
                    ├─ _source === 'dab': fetch from DAB stream endpoint
                    ├─ _source === 'hifi': fetch from HiFi /track/ endpoint
                    └─ fallback: Piped /streams/ → Invidious adaptiveFormats
                    │
                    └─ pipeline(fetch(streamUrl), createWriteStream(cache/ID.mp3))
                          │
                          └─ return { url: "/api/cache/stream/ID" }
                    │
              audio.src = "/api/cache/stream/ID"
              audio.load()
              audio.play()
```

---

## MVP fixes applied (May 2026)

The following were identified in review and **implemented**:

| Area | Change |
|------|--------|
| **Display audio** | `broadcastNP` no longer wraps same-origin `/api/cache/stream/...` URLs in `/api/piped/relay` (Node `fetch` cannot use relative targets). Remote HTTPS streams still use relay. |
| **Relay** | `/api/piped/relay` resolves relative targets against `http://127.0.0.1:${PORT}` when needed. |
| **System stats** | `/api/system/stats` now returns `cpu` (cores, model, optional `percent` from `loadavg` where available), `ram` (with `used`), `disk` (via `fs.statfsSync` when available), `temp` (count + byte size), `uptime`. `dj.js` handles missing CPU/disk gracefully. |
| **Temp delete** | `DELETE /api/temp/file?file=` removes one upload; `GET /api/temp/stream` uses `path.basename` to avoid traversal. |
| **Sources** | DAB: `q` then `query`; HiFi: extra response shapes + `duration_ms`; Piped: accept `video` type and parse `videoId` from `url`; Invidious: `video_id` fallback; Piped/Invidious skip for `jamendo:` ids. |
| **Jamendo** | Optional lane + download; namespaced ids; Settings + topbar indicator. |
| **UI** | Queue tab **Search online**; Settings **Test music sources**; `css/shared.css` added. |
| **Playback** | Background pre-download of next online track after current cache load succeeds. |
| **engine.js** | Removed dead `getPipedAudioUrl`. |
| **Cache files** | `safeCacheBasename()` for on-disk names; logical `id` unchanged. |

### Post-MVP playback / display pass (May 2026)

| Area | Change |
|------|--------|
| **Display vs DJ audio** | The display page uses its own `<audio id="relay-audio">` decoding the **same stream URL** as the DJ console, not the same DOM element or WebAudio graph. Pausing the DJ deck updates SSE `isPlaying`; the relay **pauses** when `isPlaying` is false so the room does not keep hearing audio after the DJ stopped. |
| **Relay smoothness** | Relay seeks only when drift exceeds ~1.6s (or on track change) to avoid choppy constant `currentTime` writes. `preload="metadata"`; `canplay` still applies an initial sync. |
| **`isPlaying` in SSE** | Derived from real `<audio>` pause state on both decks (`isAnyDeckPlaying()`), not only `DJ.started`. |
| **Crossfade staging** | `loadTrackOnDeck(deck, track, { prepareOnly: true })` loads and buffers the next track **without** calling `play()` until `Engine.crossfade` raises the target deck gain (avoids audibly starting the next cue before the fade). |
| **Buffer wait** | `waitForAudioReady()` after `load()` so crossfade does not start on an empty `HAVE_NOTHING` buffer (fixes “next” / CROSSFADE silent or stuck). |
| **Xfader / queue** | `syncCrossfaderToDeck(deck)` after `advanceQueue` so the audible deck matches the deck that just received the new queue item. |
| **Auto-mix** | `updateDeckUI` guards on finite `duration` / `remain` so bad metadata does not misfire skips or double-load the same deck. |
| **Smart fade** | `detectFadePoint` uses a numeric `dur` throughout; waveform fade marker checks finite duration. |
| **Lyrics** | `/display` parses LRCLIB synced LRC into lines and highlights the active line from interpolated elapsed time. |
| **Queue UI** | Queue tab header **＋ Add / search** (`queueFocusSearch()`); unified search shows **title + artist/uploader** fallbacks and a **Queue** button; main queue rows use `escHtml` with `—` fallbacks; mix “up next” strip uses title/artist fallbacks. |
| **Search API** | Invidious row mapping adds `authorName` / `uploaderName` fallbacks and title fallback from `videoId`. |

**MeTube:** When `METUBE_URL` / shared downloads volume are configured (`docker-compose`), `POST /api/cache/download` already falls back to **MeTube** after direct lanes fail — no extra client toggle; ensure the container and env are set for automatic queue-through.

## Known gaps / backlog

- **Auth:** still none (use reverse proxy for LAN exposure).
- **Windows CPU %:** `os.loadavg()` is often zero; UI shows `—` for CPU % when unknown.
- **More providers:** Internet Archive, paste-URL, etc. — not implemented (Jamendo proves the pattern).
- **WebRTC:** Implemented with REST polling signaling. Works for same-origin only due to STUN-only ICE; TURN server needed for cross-network use.
- **Song verification:** Basic ID3 Levenshtein implemented; acoustic fingerprint (Chromaprint) not yet integrated.

---

## v4.3 Changes (May 2026) — Full Redesign + Persistence + PWA

### Phase 1 — Bug fixes & polish
| Area | Change |
|------|--------|
| **RSS parser** | Replaced fragile regex with `fast-xml-parser`; handles CDATA, Atom, RSS 2.0, namespaces |
| **Marquee mode** | `rss`/`messages`/`both` config toggle in Settings; RSS is primary, messages fallback |
| **-Topic channels** | `filterTopicChannels` config toggle + `filterTopicResults()` on search; also filtered at Invidious/Piped download level |
| **Download logging** | Cache download error logs now include track id |
| **z-index** | `.display` raised from 1→11 so lyrics panel renders above marquee |
| **Lyrics timing** | Widened timing window (`-0.3` to `<t1`); opacity interpolation between LRC lines |
| **Mobile** | `.mix-up-next` changed from `display:none` to `display:block` on all sizes |
| **Clear Now Playing** | `/api/nowplaying/clear` endpoint + buttons on display header & DJ stats bar |
| **Queue dedup** | Server-side `playedIds` array; `POST /api/playback/played` endpoint; dedup check on enqueue |
| **Temp cleanup** | `downloadCounter` — every 25 downloads triggers `cleanTempAfterDownloads()` keeping 5 most recent |

### Phase 2 — Persistent playback (display as player)
| Area | Change |
|------|--------|
| **Server engine** | `advanceTrack()`, `startPlayback()`, `stopPlayback()`, `preCacheNextTrack()`, `playbackTimer` |
| **SSE commands** | `broadcastCommand()` sends `command: 'play'|'stop'` with `url` for the display |
| **Queue persistence** | `queue.json` format changed to `{queue, trackIndex}` with legacy array auto-detection |
| **Display relay** | `<audio id="relay-audio">` — `ended` event reports to `/api/playback/event`; `applyState` handles play/stop commands |
| **DJ integration** | `startPlayback()` calls `POST /api/playback/start`; `advanceQueue()` calls `/api/playback/next`; `loadPersistentQueue()` restores full state |
| **Playback endpoints** | `POST /api/playback/start`, `/stop`, `/next`, `/event`, `/played` |

### Phase 3 — UI redesign (Spotify-inspired)
| Area | Change |
|------|--------|
| **Color system** | New CSS custom properties: Spotify-green accent (`#1db954`), `--surface2/3`, `--radius-sm/md/lg`, `--shadow`, `--transition` |
| **Light/dark mode** | `[data-theme="light"]` overrides all variables; system preference detected via `prefers-color-scheme`; manual toggle saved to `localStorage('autodj-theme')` |
| **Theme toggle** | LIGHT/DARK button in both DJ console topbar and display header; smooth cross-theme transitions |
| **Visual refresh** | Updated deck cards, panels, progress bars, buttons, stat cards — consistent rounded corners, green accents, muted backgrounds |

### Phase 4 — Session controls & queue limits
| Area | Change |
|------|--------|
| **Session duration** | Settings field (hours, 0=unlimited); server tracks `sessionStart` in `sharedState`; auto-stops when expired |
| **Queue limit** | Settings field (tracks, 0=unlimited); server clips queue on `POST /api/queue` |
| **Mix tab indicators** | Two new stat cards: "Session" (remaining time or ∞) and "Queue" (count/limit) — updated every 3s |
| **Enforcement** | `advanceTrack()` checks session expiry before advancing; `POST /api/queue` trims to limit |

### Phase 5 — PWA support
| Area | Change |
|------|--------|
| **Manifest** | `manifest.json` with standalone display, theme colors, icons |
| **Icons** | `icons/icon-192.png` and `icons/icon-512.png` (auto-generated) + `icons/icon.svg` |
| **Service Worker** | Updated with cache-first for app shell, network-first for pages, API/stream skip |
| **Meta tags** | `theme-color` (dark/light), `apple-mobile-web-app-capable`, `viewport-fit=cover` on both pages |

### Phase 5b — OpenCode AI provider + Listener tracking
| Area | Change |
|------|--------|
| **OpenCode AI** | New AI provider option (`opencode`); `opencodeKey` + `opencodeBaseUrl` config fields; Settings UI with key input and optional base URL; uses OpenAI-compatible `/chat/completions` format |
| **Rich listener tracking** | `sseClients` changed from `Set<res>` to `Map<id, {res, info}>` tracking IP, user-agent, page, connection time |
| **Listeners tab** | New tab on DJ console with auto-refreshing table (every 5s) showing connected display clients: ID, IP, browser, OS, device type, page, connection duration |
| **`/api/listeners`** | Now returns per-device details (`browser`, `os`, `isMobile`, `isTablet`, `connectedAgo`) plus total count |

### v4.4 Changes (May 2026) — OpenCode Zen + layout + queue UX + code audit

| Area | Change |
|------|--------|
| **OpenCode Zen models** | Model dropdown replaced with `<select><optgroup>` — Free tier (DeepSeek V4 Flash, MiniMax M2.5, GPT-5 Nano, Big Pickle), GPT Series (5.5 Pro through GPT-5), Claude (Opus/Sonnet/Haiku), Other (Gemini, GLM, Kimi, Qwen, MiniMax). Base URL hint updated to `https://opencode.ai/zen/v1` |
| **Settings scroll** | `.settings-grid` got `max-height:70vh; overflow-y:auto` so long settings forms don't overflow the viewport |
| **Display/DJ queue sync** | `POST /api/playback/next` now sends `trackIndex` in the request; `advanceTrack()` uses `sharedState.trackIndex` — display and DJ stay in sync on manual skip |
| **Random skip + queue dedup** | `downloadingIds` Set prevents batch download from enqueuing the same track twice; `trackIndex` passed through `/api/playback/next` fixing duplicate queue entries |
| **Mix "NEXT UP" card** | Top track in the up-next strip renders as a large prominent card showing title, artist, and "Play Now" button (`playQueueTrack`); remaining tracks as compact list |
| **Lyrics scroll** | Replaced `scrollIntoView()` with `getBoundingClientRect()` + manual `scrollTop` — stops lyrics panel from stealing page scroll |
| **Search thumbnails** | Online search results show small thumbnail images; track titles in bold |
| **Queue "Play Now"** | Each queue row has a "▶ Play Now" button that calls `playQueueTrack` |
| **Page layout** | `overflow-x:hidden` on `<body>`; narrower sidebar (`--sidebar-width: 220px`, reduced padding); responsive breakpoints for smaller screens |
| **Now Playing card** | Mix tab shows current track artwork, title, artist, and elapsed timer when a track is playing |
| **Download dedup** | Server-side `downloadingIds` Set prevents concurrent cache-download of the same `videoId` |

### v4.4 Code Audit Fixes (May 2026)

Four-agent code review identified and fixed the following:

**Critical fixes:**
| Area | Change |
|------|--------|
| **WebRTC broken** | `dj.js:1837,1849` — `engine` → `Engine` (lowercase typo caused ReferenceError on Share Audio button) |
| **Display canplay** | `display.html` — removed duplicate `canplay` event listener (lines 396-401) that caused double seek on track load |
| **Missing stat elements** | `dj.html` — added `#stat-temp-sub` and `#stat-temp-bar` DOM elements that JS wrote to but didn't exist |
| **CSS selector mismatch** | `.mix-up-next { display: block }` → `#mix-up-next` — selector referenced class but element uses ID |
| **Nested @media** | Missing closing `}` before `@media (max-width:480px)` — structurally invalid CSS |
| **Missing shared.css** | `display.html` — added `<link rel="stylesheet" href="/css/shared.css">` for theme variable parity with dj.html |

**Medium fixes:**
| Area | Change |
|------|--------|
| **Lyrics duration bug** | `display.html:792-794` — removed `d > 120` check that incorrectly divided 180s+ tracks by 1000, breaking lyrics lookup |
| **removeMessage broadcast** | `dj.js:1580` — `removeMessage()` now calls `Engine.broadcastNowPlaying({messages})` so display pages stay in sync |
| **Dead settings fields** | Removed `cfg-fade` (Default Crossfade, never wired), `cfg-smartfade` (never wired), `cfg-ai-queue` (never wired), `cfg-genre-lock` (never wired) from Settings HTML |

**Security fixes applied:**
| Area | Change |
|------|--------|
| **Path traversal** | `/api/local/stream` — `path.resolve()` before `startsWith()` check to prevent `../` escape |
| **Open proxy** | `/api/piped/relay` — reject `//` protocol-relative URLs, validate via `new URL()`, block private/reserved IPs (localhost, 10.x, 192.168.x, 172.16.x, .local) |
| **RSS SSRF** | `/api/rss` — validate with `new URL()` (not `startsWith('http')`), block private IPs and URLs with embedded credentials |
| **Rate limiting** | Added in-memory rate limiter middleware applied to `/api/cache/download` (20/min), `/api/cache/downloadBatch` (10/min), `/api/ai/recommend` (20/min), `/api/youtube/search` (30/min), `/api/temp/upload` (10/min) |
| **Local scan path leak** | `/api/local/scan` — replaced `filepath` (absolute path) with `path` (relative to music dir); added try-catch per file |
| **WebRTC auth** | All `/api/webrtc/*` endpoints now require same-origin (validated via `Origin`/`Referer` header) |
| **Content-type mapping** | Added `ogg`/`opus` → `.ogg`, `flac` → `.flac`, `wav`/`wave` → `.wav`, `aac` → `.aac` |
| **playedIds pruning** | Capped at 2000 entries with `prunePlayedIds()` |
| **Config parse** | Added `log('Config', 'WARNING: ...')` when `config.json` is malformed |
| **Double decode** | Removed redundant `decodeURIComponent()` from `/api/cache/stream/:id` (Express already decodes params) |
| **downloadBatch URL** | Changed from `req.hostname` (breaks behind proxy) to `127.0.0.1` |

---

## Immediate verification checklist

```
□ Re-run live curl/UI tests whenever upstream instances change
□ Docker Node 22 smoke test when you ship containers
```

---

## Known Gaps / Backlog

```
□ Download dedup: fix TOCTOU race between cache check and Set.add (theoretical, low probability)
□ Karaoke-style scroll-centred lyrics
□ Settings: allow user to add/remove source instances via UI
□ Settings: richer "Test Sources" grid (per-URL latency table)
□ Waveform: show cue point marker (verify end-to-end)
□ Playlists: save/load queue as JSON file
□ Song requests: display page form needs full implementation
□ Stats page: show cache size, queue history, source health
□ Internet Archive or other open-audio provider
□ Better ID3 fallback: add Vorbis Comment parser for FLAC files
□ Acoustic fingerprint: integrate Chromaprint or WASM library
□ WebRTC: add TURN server config for cross-network audio sharing
```

---

## Android App (Not Yet Built)

The user wants an Android companion app in the style of "Pioneer Pro Link" — a professional DJ setup that shows track info, allows remote queue management, and connects to the AutoDJ server.

**Planned architecture:**
- React Native or Flutter app
- Connects to AutoDJ server via same LAN (configure server IP in app)
- Features:
  - Now Playing screen (mirrors `/display`)
  - Queue browser — see upcoming tracks, reorder, remove
  - Search & add songs
  - Basic deck controls (play/pause/skip)
  - Live waveform visualization
- Communication: REST API + SSE for live state

**To start this project:**
1. Pick React Native (better bridge ecosystem) or Flutter (better UI)
2. The backend is already complete — all endpoints needed exist
3. Key endpoints the app will use:
   - `GET /api/nowplaying/stream` (SSE) — live state updates
   - `GET /api/nowplaying` — current state
   - `POST /api/nowplaying/update` — update shared state
   - `GET /api/youtube/search?q=` — search
   - `GET /api/local/scan` — local library
   - `POST /api/cache/download` — queue an online track
4. Start in a new chat with the AutoDJ zip attached as context

---

## Deployment

### Local (no Docker)
```bash
# Requires Node.js 22+
node --version  # must be v22.x.x

cd autodj-v4
npm install
node server.js

# Open:
# DJ Console  → http://localhost:3000/dj
# Now Playing → http://localhost:3000/display
```

### Docker (recommended)
```bash
cd autodj-v4
docker compose build --no-cache
docker compose up -d

# View logs:
docker compose logs -f autodj

# Stop:
docker compose down
```

### Environment Variables (optional — can also use Settings UI)
```bash
LASTFM_API_KEY=your_key_here
JAMENDO_CLIENT_ID=your_jamendo_client_id
SPOTIFY_CLIENT_ID=your_id
SPOTIFY_CLIENT_SECRET=your_secret
ANTHROPIC_API_KEY=your_key
OPENAI_API_KEY=your_key
PORT=3000
MUSIC_DIR=/path/to/music
# Optional: MeTube container + shared volume (see docker-compose) — server uses as download fallback
METUBE_URL=http://metube:8081
METUBE_DOWNLOADS_DIR=/metube_downloads
```

### First Time Setup
1. Open `http://localhost:3000/dj`
2. Go to Settings tab
3. Add Last.fm API key (free at last.fm/api) — enables Discovery
4. Optionally add **Jamendo** `client_id` (developer.jamendo.com) — strong fallback lane (CC catalog, not YouTube)
5. Optionally add Spotify credentials — enables Spotify search
6. Optionally add Anthropic/OpenAI key — enables AI track recommendations
7. Click "Save Keys" / "Save Settings"
8. Go to **Queue** tab → **＋ Add / search** or **Search online** (unified search), add tracks, then **Mix** tab → ▶

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/config` | Get current config (keys masked) |
| POST | `/api/config` | Update config + save |
| GET | `/api/youtube/search?q=` | Unified search (ordered by `sourcePriority` config) |
| GET | `/api/system/stats` | CPU / RAM / disk / temp upload stats + uptime |
| DELETE | `/api/temp/file?file=` | Delete one temp upload by stored filename |
| POST | `/api/cache/download` | Download track to local cache |
| GET | `/api/cache/stream/:id` | Stream cached audio (range requests) |
| POST | `/api/cache/played` | Mark track played, trigger cleanup |
| GET | `/api/lyrics?title=&artist=&duration=` | Get lyrics from LRCLIB |
| GET | `/api/test/sources` | Test all music source instances |
| GET | `/api/piped/streams?videoId=` | Get audio stream URLs (Piped/Invidious) |
| GET | `/api/local/scan` | Scan local music directories |
| GET | `/api/local/stream?path=` | Stream local audio file |
| POST | `/api/temp/upload` | Upload temp audio files |
| GET | `/api/temp/stream?file=` | Stream temp upload |
| GET | `/api/lastfm?method=&...` | Proxied Last.fm API call |
| GET | `/api/spotify/v1/*` | Proxied Spotify API |
| POST | `/api/ai/recommend` | AI track recommendations |
| GET | `/api/nowplaying/stream` | SSE stream for display page |
| GET | `/api/nowplaying` | Current playback state |
| POST | `/api/nowplaying/update` | Update playback state (DJ → display) |
| GET | `/api/listeners` | SSE client list with device info (browser, OS, mobile/desktop, connected time) |
| POST | `/api/cache/downloadBatch` | Download N tracks in parallel |
| GET | `/api/logs` | Get recent server logs (query: `?level=`, `?tag=`) |
| DELETE | `/api/logs` | Clear server log buffer |
| GET | `/api/ping` | Keepalive ping (service worker) |
| POST | `/api/playback/start` | Start playback engine (auto-advance) |
| POST | `/api/playback/stop` | Stop playback engine |
| POST | `/api/playback/next` | Advance to next track |
| POST | `/api/playback/event` | Report playback event (e.g. `{type: "ended"}`) |
| POST | `/api/playback/played` | Mark track as played (for dedup) |
| POST | `/api/nowplaying/clear` | Clear now-playing state |
| POST | `/api/webrtc/offer` | Send WebRTC SDP offer (DJ) |
| GET | `/api/webrtc/offer` | Poll for WebRTC offer (Display) |
| POST | `/api/webrtc/answer` | Send WebRTC SDP answer (Display) |
| GET | `/api/webrtc/answer` | Poll for WebRTC answer (DJ) |
| POST | `/api/webrtc/ice` | Send ICE candidate (both) |
| GET | `/api/webrtc/ice` | Poll for ICE candidates (both) |
| DELETE | `/api/webrtc` | Reset WebRTC signaling state |
| POST | `/api/cache/verify` | Verify downloaded track via ID3 metadata |

---

## Code Patterns to Know

### Adding a new music source
1. For **multi-instance** HTTP APIs: add URLs to `SOURCES` in `server.js` and use `markInst` / `getHealthy`.
2. For **single-endpoint + API key** providers (like Jamendo): add fields to `config` / `config.json`, expose in `/api/config`, then branch in `/api/youtube/search` and `/api/cache/download`.
3. Add a search block in `/api/youtube/search` returning the same shape: `{ videoId, title, author, lengthSeconds?, artwork?, _source, _instance }`. Use a **namespaced** `videoId` if the id is not globally unique.
4. Add download logic in `/api/cache/download` for your `_source` (and skip YouTube fallbacks when the id is namespaced).
5. Add to `/api/test/sources` when a simple health GET exists.

### The `_source` / `_instance` flow
When a track is found via search, it stores (examples):
```js
{ videoId: 'abc123', _source: 'dab', _instance: 'https://dabmusic.xyz/api' }
{ videoId: 'jamendo:123', _source: 'jamendo', _instance: 'https://api.jamendo.com/v3.1' }
```
This flows through to cache/download so the server knows which API to use for getting the stream URL. Don't break this chain.

### Health tracking
```js
markInst(url, true, latencyMs)  // mark as healthy
markInst(url, false)             // mark as unhealthy
getHealthy(SOURCES.piped)        // returns instances sorted: healthy fast → healthy slow → unknown → unhealthy
```

### SSE broadcast
```js
Object.assign(sharedState, { nowPlaying: track, isPlaying: true });
broadcastState();  // sends to all /display page connections
```

---

## Project History (Quick Summary)

This project went through multiple sessions:

1. **v1-v2:** Basic DJ console with Piped-only streaming. Piped stream URLs expired = silent failures.
2. **v3:** Added HiFi-API/Monochrome instances, download cache idea introduced. `node-fetch` import caused streaming failures (CVE-2024-24750 memory leak + `Readable.fromWeb` bugs).
3. **v4.0:** Switched to Node 22 native `fetch`. Added DAB Music as primary source (from SpotiFLAC research). Added LRCLIB lyrics. Removed duplicate route bugs. Used `pipeline()` for downloads.
4. **v4.1:** Complete `server.js` rewrite; DAB primary; `pipeline()` cache downloads.
5. **v4.2 (May 2026):** Display relay fix for cached audio; expanded `/api/system/stats`; Jamendo lane; DAB `query=` fallback; Piped/Invidious search hardening; safe cache basenames; `DELETE /api/temp/file`; Queue unified search; Settings “Test sources”; next-track pre-download; `css/shared.css`; removed dead `getPipedAudioUrl`.
   - **Post-MVP (same session):** Duration normalization (4966:40 bug); Cue A/B stop fixed; Display wrong-track fix; Queue dedup; Lyrics auto-scroll; MeTube-first config; Parallel batch downloads; Pre-download ahead; Smart fade at 80%; Track-length filter; Logs tab; Config UI; Media Session API; Temp queue retention; Mobile responsive; Service Worker keepalive; WebRTC shared audio; Source priority reorder; Song verification (ID3).

**The root cause of "nothing plays"** was always one of:
- Dead Piped/Invidious instances (no results returned)
- `node-fetch` breaking `Readable.fromWeb()` streaming
- Stream URLs expiring before audio starts playing
- `audio.play()` errors swallowed with `.catch(()=>{})`
- **Display relay** treating same-origin cache URLs as remote relay targets (fixed in v4.2)

Core streaming issues are addressed in v4.1+; v4.2 fixes display listen path and broadens search reliability.

---

## Files in the Zip

```
autodj-v4/
├── server.js          ← All backend logic (Express routes, sources, cache, lyrics, WebRTC, logs, verify, auto-advance)
├── engine.js          ← Browser audio engine (WebAudio, crossfade, waveform, Last.fm, ID3, WebRTC broadcast)
├── dj.js              ← DJ console UI (queue, decks, settings, logs, WebRTC, verify, source priority, theme)
├── dj.html            ← DJ console HTML + inline CSS (Spotify-inspired theme, light/dark, mobile responsive)
├── display.html       ← Now-playing display (WebRTC receive, relay audio, theme toggle, mobile responsive)
├── sw.js              ← Service Worker (app shell caching, API skip)
├── manifest.json      ← PWA manifest (standalone display, icons, theme color)
├── css/
│   └── shared.css     ← Minimal shared baseline
├── icons/
│   ├── icon.svg       ← SVG app icon
│   ├── icon-192.png   ← PWA icon (192x192)
│   └── icon-512.png   ← PWA icon (512x512)
├── package.json       ← Dependencies (express, cors, multer, fast-xml-parser — NO node-fetch)
├── Dockerfile         ← node:22-alpine
├── docker-compose.yml ← Mounts music/, cache/, config.json
├── config.json        ← Empty {} to start (populated via Settings UI)
├── .dockerignore      ← Excludes node_modules, cache, music
├── .env.example       ← Template for env vars
├── README.md          ← Original readme (partially outdated)
├── handoff.md         ← Canonical project handoff (this file)
├── music/             ← Mount your local music here
└── cache/             ← Auto-managed audio download cache
```

---

*Last updated: June 2026. AutoDJ v5.0.0 (source prune + duration fix + OpenRouter + compression).*

---

## v5.0.0 Changelog (June 2026)

### Source Health
- **Removed dead HiFi sources** — all 8 HiFi instances were returning 502/ENOTFOUND
- **Culled dead Piped instances** — kept only `api.piped.private.coffee` (verified working)
- **Culled dead Invidious instances** — removed yewtu.be (403), inv.nadeko.net (403), invidious.nerdvpn.de (401); added invidious.flokinet.to (verified working)
- **DAB** kept but noted as Cloudflare-blocked (both instances 403)

### Duration Fix
- **Rewrote `normalizeTrackDurationSeconds`** — split into `parseDurationToSeconds` + validator
- Now handles **HH:MM:SS** and **MM:SS** colon-separated formats (fixes "1000:10" bug)
- Better millisecond detection (threshold `>100000 && <1e12`)
- Caps bogus values >10 hours to zero

### AI Provider: OpenRouter
- Added **OpenRouter** as a fourth AI provider (`openrouter` option in `/api/ai/recommend`)
- Config fields: `openrouterKey`, `openrouterBaseUrl`, `openrouterModel`
- Settings UI updated in dj.html (provider dropdown + API key/base URL/model fields)
- Config load/save wired in dj.js

### Infrastructure
- Added `compression` middleware (gzip static assets, threshold 512 bytes)
- Added **graceful shutdown** (SIGTERM/SIGINT/SIGHUP handlers)
- Updated `.env.example` with OpenRouter vars
- Bumped version to **5.0.0** in package.json and server.js startup message
- Updated description to remove dead HiFi references
- Removed "HiFi" from source priority drag area in Settings UI

### Backend
- Updated SOURCE_KEYS to remove 'hifi'
- Updated startup log message (removed HiFi count)
- Updated `hasAI` config check to include OpenRouter
