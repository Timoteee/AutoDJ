# Adaptive transitions and reliable queue downloads

Approved direction: analyze audio locally, without an AI service. Derive leading/trailing silence, overall and boundary RMS energy, and beat confidence from decoded PCM. Use a 3–10 second equal-power overlap, shorten it for dense endings, and align to detected beats only when confidence and tempo compatibility are high. Never stretch vocals or change playback speed. Use a bounded fallback when decoding fails.

Load the upcoming track onto the idle deck before the transition. Keep queue position unchanged until loading and playback succeed; release locks on every failure. Preserve the outgoing song while the next download is pending.

One download status row per track ID, updated through queued/downloading/completed/failed. Queue additions schedule all online tracks through a bounded background downloader. Wait for MeTube finished status and its final output filename before copying. Validate binary headers correctly and retain actionable failure reasons with retries. Recover interrupted downloads on restart.

Automatically share the actual mixer output to displays on the same server. Remove the Share button. Keep the display's Enable Audio gesture because browsers may require it. Stream fallback stays available when no mixer broadcast exists. Reconcile now-playing data on reconnect and when stream URLs arrive after metadata. Avoid duplicate relay and WebRTC audio. Ports 3000 and 8090 are separate instances; console and displays must use the same origin.

Validation: synthetic silence, dense tails and periodic pulses; stalled/failed upcoming tracks; bidirectional crossfades; concurrent download requests and queue additions; real Future downloads; paired console/display playback and reconnect.
