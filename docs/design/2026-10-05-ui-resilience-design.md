# AutoDJ UI resilience and design

User approved this direction on 2026-10-05. Preserve the DJ workflow and Signal & Flow identity while improving reliability and clarity.

The supplied attachment lists inspiration galleries and design resources rather than normative rules. Apply practical principles: consistent spacing, readable type, visible keyboard focus, responsive controls, restrained motion, and explicit failure feedback.

Compile Tailwind utilities at development time and commit the generated stylesheet so Node and Docker deployments need no build step or external CSS runtime. Keep intrinsic logo dimensions. Test with third-party resources blocked and at mobile and desktop widths.

Serve only public pages and assets. Keep runtime configuration, queues, source files, and dependency directories outside static hosting. Preserve API behavior.

Use bounded JSON requests for configuration, report failed saves accurately, tolerate unavailable browser storage, and show live connection state. Repair service-worker assets, isolate its cache namespace, bypass non-GET/API/media requests, and return predictable offline responses.

Validation: existing source/playback module tests, fault tests for storage and HTTP failures, service-worker lifecycle tests, public asset checks, syntax validation, and browser layout checks where available.

## Source reliability follow-up

User requested correction of empty Drake searches and explicitly requested new working sources. Add direct YouTube metadata search and public ungated Audius tracks, preserve namespaced Audius IDs through queue/cache, and resolve Audius audio from the provider API rather than client-supplied URLs. Search the two new providers concurrently before legacy proxy fallback. Label provider provenance and YouTube playback dependencies in results.

Test all configured endpoints concurrently and allow manual tests to retry open circuits. Validate response shape, show untested status until a check occurs, and report useful HTTP/network failure reasons. Search availability counts do not certify stream availability. Live verification confirmed Audius cache download, HTTP range serving, and browser MP3 decoding/playback; the newly listed Invidious endpoint supported search but failed a video-stream probe.
