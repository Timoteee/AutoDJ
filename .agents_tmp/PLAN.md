# 1. OBJECTIVE

Fix all bugs in AutoDJ v7.0.0 and improve the music sourcing/download/playback success rate to ensure a fully functional, production-ready application.

# 2. CONTEXT SUMMARY

**Project:** AutoDJ — A browser-based DJ system that auto-queues music from multiple streaming sources (YouTube/Invidious/Piped/DAB/Jamendo) with crossfading, AI recommendations, and persistent playback.

**Critical Issues Found:**

### Backend (server.js):
1. **Syntax error at line 237** — Extra `}` that breaks the file structure
2. **Duplicate function definitions** (lines 443-458) — `getHealthy()` and `markInst()` defined twice
3. **Double-call bug** — `getHealthy(getHealthy('piped'))` should be `getHealthy('piped')`
4. **MeTube URL format bug** (line 771) — Uses `watch?v=` instead of `/watch?v=`
5. **Missing variable initialization** — `src` variable may be undefined in catch blocks

### Frontend (dj.html):
1. **Version displays "v6"** — Should display "v7"
2. **Meta tags and title inconsistent** — Need updating to v7

### Library (lib/duration-sanitizer.js):
1. **Duplicate `return total;`** — Dead code on line 33
2. **Unused import** — `DedupFilter` imported but not used

### Playback/Download Improvements:
1. **Improve source fallback chain** — Add more resilient error handling
2. **Better MeTube URL handling** — Fix URL format
3. **Improve stream URL extraction** — Better parsing of stream responses

# 3. APPROACH OVERVIEW

1. Fix all critical syntax errors in server.js
2. Fix duplicate function definitions and double-call bugs
3. Fix MeTube URL format bug
4. Fix version inconsistencies across all files (UI and package.json)
5. Clean up dead code and unused imports
6. Improve error handling in download/playback logic
7. Run tests and validate all fixes

# 4. IMPLEMENTATION STEPS

### Step 1: Fix server.js syntax error (line 237)
- **Goal:** Remove the extra `}` that breaks the file structure
- **Method:** Remove the stray `}` at line 237 that prematurely closes the `if (!config.rssFeedUrl)` block
- **Reference:** `server.js` lines 235-240

### Step 2: Remove duplicate function definitions (lines 443-458)
- **Goal:** Fix the duplicate `getHealthy()` and `markInst()` definitions
- **Method:** Remove the first definitions (lines 443-449) that use sourcePipeline, keep only the working instanceHealth-based versions
- **Reference:** `server.js` lines 443-458

### Step 3: Fix double-call bug in search handlers
- **Goal:** Fix `getHealthy(getHealthy('piped'))` → `getHealthy('piped')`
- **Method:** Update lines 855-856, 999, 1215 to use single calls
- **Reference:** `server.js` lines 855-856, 999, 1215

### Step 4: Fix MeTube URL format bug
- **Goal:** Fix incorrect URL format `watch?v=` should be `/watch?v=`
- **Method:** Update line 771 from `https://www.youtube.com/watch?v=${cleanId}` to `https://www.youtube.com/watch?v=${cleanId}` (add leading `/`)
- **Reference:** `server.js` line 771

### Step 5: Remove dead code in duration-sanitizer.js
- **Goal:** Remove duplicate `return total;` statement
- **Method:** Delete the duplicate return on line 33
- **Reference:** `lib/duration-sanitizer.js` line 33

### Step 6: Fix unused import in duration-sanitizer.js
- **Goal:** Remove unused `DedupFilter` import
- **Method:** Remove the `DedupFilter` require statement
- **Reference:** `lib/duration-sanitizer.js` line 1

### Step 7: Update version consistency (v7.0.0)
- **Goal:** Ensure all version references are consistent
- **Method:** Update:
  - `package.json` version from "6.0.0" to "7.0.0"
  - `dj.html` version display from "v6" to "v7"
  - `dj.html` title and meta tags
  - `display.html` title and meta tags
- **Reference:** Multiple files

### Step 8: Improve download error handling
- **Goal:** Better error handling and fallback for failed downloads
- **Method:** 
  - Initialize `src` variable before try blocks
  - Add better error messages for failed sources
  - Ensure proper cleanup on errors
- **Reference:** `server.js` download handlers

### Step 9: Improve stream URL extraction
- **Goal:** Better parsing of audio stream URLs from API responses
- **Method:** Add fallback for missing/invalid stream URLs
- **Reference:** `server.js` stream resolution handlers

### Step 10: Run tests and validate
- **Goal:** Verify all fixes work and no regressions
- **Method:** Run `npm test` to execute all unit tests
- **Reference:** All test files in `/tests`

### Step 11: Verify server starts without errors
- **Goal:** Confirm the server can start successfully
- **Method:** Attempt to start the server with `node server.js` and verify no syntax/runtime errors
- **Reference:** `server.js` startup logs

# 5. TESTING AND VALIDATION

**Success Criteria:**
- [ ] `npm test` passes all unit tests
- [ ] `node server.js` starts without syntax errors
- [ ] Server logs show "AutoDJ v7.0.0" startup message
- [ ] No duplicate function warnings/errors
- [ ] All search handlers use correct single `getHealthy()` calls
- [ ] UI displays "v7" consistently
- [ ] Music downloads work from multiple sources

**Expected Test Results:**
- dedup-filter.test.js: 17 tests pass
- duration-sanitizer.test.js: 44 tests pass
- preload-gate.test.js: 6 tests pass
- retry-manager.test.js: 12 tests pass
