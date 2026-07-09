# AutoDJ Source & Download System Redesign v7.0

## Scope

Complete rewrite of source/download pipeline, preload gate, proxy rotation, AI curation, retry system, playlist dedup, duration sanitizer, UI fault indicators, and yt-dlp worker.

---

## 1. Architecture — Hybrid Pipeline + yt-dlp Worker

### Components

**SourcePipeline**
- Unified interface for MeTube, Invidious, Piped, DAB, Jamendo, Squid
- Health scoring: each instance maintains `{ ok: bool, latency: ms, errorRate: %, lastChecked: timestamp }`
- Circuit breaker: instance disabled for 5 min after 3 consecutive failures
- Proxy injection: all fetch calls accept optional proxy param (SOCKS5/HTTP)

**PreloadGate**
- Blocks `startPlayback()` until `config.preDownloadCount` tracks fully cached
- Polls cache every 1s
- If timeout exceeds `config.preloadTimeout` (default 120s), starts anyway with warning
- State: `{ required, cached, downloading, failed, status: 'waiting'|'ready'|'timeout' }`

**DownloadQueue**
- File-based queue at `downloads/queue.json`
- Entries: `{ videoId, title, artist, source, attempts, maxAttempts, nextRetry, backoff, status }`
- Background worker polls every 15s for pending retries

**yt-dlpWorker** (separate Node process)
- Spawned by main server on startup
- Receives jobs via HTTP POST to internal endpoint (`worker.port`)
- Runs `yt-dlp` with: `--extract-audio --audio-format mp3 -o {output}` 
- Proxy rotation: `--proxy http://{proxy}` from pool
- Reports result via HTTP callback to main server
- Falls back to in-process download if worker unavailable

### Data Flow

```
Search -> SourcePipeline -> unified results (videoId + duration + artwork)
                         |
                DurationSanitizer -> normalizes/nullifies bad durations
                         |
                DedupFilter -> checks queue + history + playedIds
                         |
                Queue Manager -> adds to queue, persists to disk
                         |
                PreloadGate -> blocks play until N cached
                         |
                yt-dlpWorker (or in-process) -> downloads to cache/
                         |
                advanceTrack() -> plays from cache file
                         |
                On fail -> RetryManager -> background retry 2x
```

---

## 2. SourcePipeline - Unified Interface

### Interface

```javascript
// Each source handler implements:
{
  name: 'invidious', // 'metube', 'invidious', 'piped', 'dab', 'jamendo', 'squid'
  search(query) => TrackResult[],
  resolveStream(videoId) => url | null,
  download(videoId, outputPath) => boolean,
  test() => { ok, latency }
}
```

### Instance Registry

Each source type has a list of instances. Each instance:
```javascript
{
  url: 'https://inv.thepixora.com',
  proxy: null,                    // assigned proxy URL
  health: { ok: true, latency: 450, errorRate: 0.05, lastChecked: Date.now() },
  circuitOpen: false,
  circuitUntil: 0,
  failCount: 0
}
```

### Health Scoring

- Every instance tested every 5 min
- Score = weighted: latency (30%) + errorRate (40%) + age (30%)
- Healthy > 0.7, Degraded 0.3-0.7, Down < 0.3
- Circuit opens at 3 consecutive fails, closes after 5 min
- Instances sorted by health score for selection

### Proxy Pool

```json
{
  "proxies": [
    { "url": "socks5://proxy1:1080", "region": "US", "type": "socks5", "failCount": 0 }
  ],
  "rotationStrategy": "round-robin"
}
```

---

## 3. PreloadGate

### Behavior
1. `startPlayback()` called
2. PreloadGate checks: how many of next N tracks are cached?
3. If < N cached: block playback, show progress in UI
4. Download next N - cached tracks via yt-dlp or fallback
5. On each cache update, re-check threshold
6. If threshold met: unblock, start playback
7. If 120s timeout: start anyway with warning "Preload incomplete"

### SSE State
```javascript
data: { preload: { required: 3, cached: 1, downloading: 2, status: 'waiting' } }
```

---

## 4. yt-dlp Worker

### Launch
```bash
node worker.js --port=3001 --cacheDir=./cache --proxyPool=proxies.json
```

### Job Format
```json
POST /worker/download
{ "jobId": "uuid", "videoId": "...", "url": "https://youtube.com/watch?v=...",
  "proxy": "socks5://proxy:1080", "callback": "http://127.0.0.1:3000/api/worker/callback" }
```

### Callback
```json
POST /api/worker/callback
{ "jobId": "uuid", "status": "completed|failed", "filepath": "/cache/abc.mp3",
  "size": 5242880, "duration": 234 }
```

### yt-dlp Command
```bash
yt-dlp --extract-audio --audio-format mp3 --audio-quality 0 \
  --output "{cacheDir}/{id}.%(ext)s" --no-playlist --geo-bypass \
  --proxy {proxy} --socket-timeout 30 --retries 3 "{url}"
```

### Fallback
If worker not running, main server uses in-process download chain (existing MeTube + proxy streams).

---

## 5. DurationSanitizer

### Rules
| Input | Output | Reason |
|-------|--------|--------|
| `1000:30` | null | YT livestream |
| `abc` | null | Not numeric |
| `0` | null | Impossible |
| `5` | null | < 10s minimum |
| `36001` | null | > 10h bogus |
| `350000` | 350 | ms -> seconds |
| `3:45` | 225 | MM:SS |
| `1:30:15` | 5415 | HH:MM:SS |
| `234` | 234 | Already valid |

### Application Points
- Search results (mapping in search handlers)
- Queue POST (normalize on insert)
- Cache write complete
- Local file scan

### UI
Tracks with `_badDuration: true` show amber warning icon, duration shows "---"

---

## 6. UI Fault Indicators

### Source Health Panel (Settings tab)
Table: instance URL | status dot (green/yellow/red) | latency | last check
Buttons: [Test All] [Auto-Scout Proxies]

### Track Badges (Queue items)
- Cache badge: cached/downloading/failed
- Source badge with health color
- Duration warning (amber if bad)
- Retry button for failed tracks

### Global Status Bar (Console page top)
```
Sources: 3/4 ok | Preload: 3/5 | Retries: 2 pending | Curator: idle
```

---

## 7. Background Auto-Retry + Manual Re-add

### RetryManager State Machine
```
QUEUED -> DOWNLOADING -> COMPLETED
                        -> FAILED -> RETRY(attempt 1, 30s) -> DOWNLOADING
                                                               -> FAILED -> RETRY(attempt 2, 5min) -> DOWNLOADING
                                                                                                       -> FAILED -> EXHAUSTED
```

### Config
```json
{ "downloadRetry": { "maxAttempts": 2, "backoff": [30000, 300000], "workerPollInterval": 15000 } }
```

### Manual Re-add
- Failed track shows "Retry" button - resets attempt=0
- Settings -> Failed Downloads: list all exhausted, bulk retry/clear

### SSE event: `event: download, data: { videoId, status: 'retrying'|'exhausted' }`

---

## 8. Playlist Deduplication

### Rules
1. Exact videoId match in queue or history (last 200) -> reject
2. Same artist within last 5 queue positions -> reject
3. Title similarity > 85% (normalized Levenshtein) -> reject
4. AI Curator receives playedIds explicitly in context -> avoids

### Config
```json
{ "dedup": { "enabled": true, "historyWindow": 200, "artistSpacing": 5, "titleSimilarityThreshold": 0.85 } }
```

### UI
"Dedupe" button on Queue page: scan, group, one-click remove extras.

---

## 9. AI Proxy/Source Scout

### Endpoint: POST /api/ai/scout-proxies
Input: failedSources[], region, currentProxies[], failedVideoIds[]
Output: { proxies: [{url, type, region, reliability}], altInstances: [{url, type}] }

### Auto-trigger
When >50% downloads fail in rolling 10-min window -> auto-scout -> prompt user:
> "Download success rate dropped to 30%. AI scouted 5 proxy candidates. Review in Settings?"

---

## 10. AI Playlist Curator

### Taste Profile
Built from playback: `{ artistCounts, genreDistribution, bpmRange, tags, energyCurve }`
Updated every 10 plays, persisted in config.

### Endpoint: POST /api/ai/curate-playlist
Input: tasteProfile, playedIds[], count, availableSources[]
Output: { tracks: [{ title, artist, reason, source, estimatedBpm, energy }] }

### UX Flow
Queue page -> [Curate Playlist] -> Preview modal (Play / Save / Regenerate / Cancel)
On Play: fill queue, preload, start playback.

### Learning
Skip <30s = decrement weight, complete = increment weight. Save every 10 plays.

---

## 11. Testing Strategy

### Unit (Vitest)
- DurationSanitizer: 15+ edge cases
- DedupFilter: exact match, artist spacing, title similarity, history
- PreloadGate: wait/timeout/cache-update events
- RetryManager: state transitions, backoff timing
- SourcePipeline: health scoring, circuit breaker, ordering
- TasteProfile: update/decay/persistence

### Integration (Vitest + HTTP)
- Search -> SourcePipeline -> sanitize -> dedup
- Queue -> download -> callback -> cache -> SSE
- Preload -> playback gate -> advance
- Retry: fail -> retry(30s) -> fail -> retry(5min) -> exhausted

### E2E (Playwright)
- Full DJ flow: search -> queue -> preload -> play -> crossfade -> skip
- Queue management: add/reorder/remove/dedupe/clear
- Settings: update config, test sources, scout proxies
- Display: SSE, artwork, lyrics, VU meters

---

## 12. Implementation Phases

### Phase A: Foundation (source-pipeline + sanitizer + preload + dedup)
1. Extract DurationSanitizer + tests
2. Build SourcePipeline interface + health registry
3. Build PreloadGate + integrate into startPlayback()
4. Build DedupFilter + integrate into queue endpoints

### Phase B: yt-dlp Worker
1. Create worker.js (separate Node process)
2. Proxy pool + rotation
3. Callback endpoint on main server
4. Fallback to in-process download

### Phase C: Intelligence
1. AI Proxy Scout endpoint + auto-trigger
2. Taste profile (build from playback history)
3. AI Playlist Curator endpoint + UI
4. Learning loop

### Phase D: Polish
1. UI fault indicators (panels, badges, status bar)
2. RetryManager + background retry + manual re-add
3. Dedupe button on Queue page
4. Failed Downloads settings page

### Phase E: Testing + Docs + Deploy
1. Run all tests
2. Update HANDOFF.md + README.md
3. Build Docker image
4. Deploy to 192.168.1.31
5. Post-deploy smoke test

---

## Appended Features (per user request)

### Auto-Retry (added to Phase D)
- RetryManager runs independent of playback
- Attempt 1: 30s delay, next source, new proxy
- Attempt 2: 5min delay, next proxy
- Exhausted: shown with warning, retry button resets
- Config driven (maxAttempts, backoff array)

### Playlist Dedup (added to Phase A)
- Multi-layer dedup: videoId, artist spacing, title similarity
- History window of last 200 played
- Applied at queue insert, discovery, AI curation
- Manual "Dedupe" button: scan + group + one-click clean

### Bad Duration Fix (added to Phase A)
- DurationSanitizer catches 1000:30 (livestream), NaN, ms, MM:SS, HH:MM:SS
- All durations validated at search result mapping, queue insert, cache write
- Invalid durations flagged with `_badDuration: true`
- UI shows amber warning + "---" duration

### AI Proxy Scout (added to Phase C)
- POST /api/ai/scout-proxies: AI recommends proxies + instances from current region
- Auto-triggers when download success rate <50% in 10min window

### AI Playlist Curator (added to Phase C)
- Taste profile from playback history
- POST /api/ai/curate-playlist: 20-track flow-aware playlist
- Preview modal, Play/Save/Regenerate/Cancel
- Learning loop adjusts weights on skip/complete