# 09 — Technical Debt Audit

## Priority Definitions

- 🔴 HIGH — blocks current use cases or causes silent data loss
- 🟡 MEDIUM — creates friction or limits future extension
- 🟢 LOW — cosmetic, minor, or only affects edge cases

---

## TD-001 — Anchor URL Bug 🔴

**Location:** `src/pipeline/orchestrator.ts:781-789`

**Evidence:** `characterAnchors.set(charKey, localAsset)` stores a local temp file path in the Map. This path is later passed to `fetch()` in `aiService.ts:158` as an anchor image URL for Gemini multi-turn image generation. `fetch()` requires an HTTP URL; a local path causes a silent network error or misformatted request.

**Impact:** All multi-scene UoN renders with anchor images silently fail to pass the anchor. Character consistency across scenes is broken.

**Fix:** Upload anchor file to Supabase using `FirestoreService.uploadAsset()`, store the returned public URL.

**Effort:** 1–2 hours.

---

## TD-002 — Local Temp Paths Stored in Firestore 🔴

**Location:** `src/models/scene.ts` field definitions + orchestrator assignment throughout

**Evidence:** Fields `narration_path`, `background_path`, `transparent_path`, `segment_path`, `rendered_path` in scene objects are local filesystem paths (`%TEMP%\ais-renderer\...`). These are persisted to Firestore via `saveProjectState()`. On any server restart, these paths no longer exist.

**Impact:** Pipeline resume after restart fails silently. Re-render triggers find "file not found" and re-run stages unnecessarily.

**Fix:** Either (a) don't persist local paths to Firestore (keep them in-memory only during a run), or (b) use Supabase URLs for audio and intermediate files.

**Effort:** Medium (4–8 hours to implement and test).

---

## TD-003 — Final Video Not Persisted to Supabase 🔴

**Location:** `renderService.ts:882-884`

**Evidence:** `project.output_path = '/api/assets/download?path=${encodeURIComponent(outputPath)}'` — sets the output path to a local temp file referenced via a stub API route. The file at `outputPath` lives in `%TEMP%/ais-renderer/`. This route (`GET /api/assets`) returns `[]` always.

**Impact:** After a server restart, the final rendered video cannot be accessed. Users have no reliable download URL.

**Fix:** After `stitchScenes()`, upload the final MP4 to Supabase and store the public URL in `project.output_url`.

**Effort:** 2–4 hours.

---

## TD-004 — `INDIAN_AESTHETIC_SUFFIX` Hardcoded in Orchestrator 🟡

**Location:** `src/pipeline/orchestrator.ts:38`

**Evidence:** `const INDIAN_AESTHETIC_SUFFIX = 'South Asian graphic novel illustration style, Hyderabad cyberpunk city 2031...'` — 97 characters of universe-specific aesthetic injected into every background prompt when `project.universeId` is set.

**Status:** Fix 3 (commit `aa15eef`) makes this conditional on `project.universeId`. Generic pipeline now uses generic suffix. But the constant lives in the generic orchestrator and the conditional is an `if (universeId)` inline check.

**Residual risk:** If a generic project somehow gets a `universeId` set (e.g., from a buggy client), it gets UoN aesthetics.

**Fix:** Move `INDIAN_AESTHETIC_SUFFIX` to a universe-specific config or to the `Universe` model as `aestheticSuffix`. Orchestrator reads from model, not hardcoded constant.

**Effort:** 1 hour.

---

## TD-005 — Duplicate Aesthetic Definitions 🟡

**Locations:**
- `src/pipeline/orchestrator.ts:38` — `INDIAN_AESTHETIC_SUFFIX`
- `src/services/characterAssetService.ts` (early lines) — `STYLE_BASE`
- `src/pipeline/agents/storyboardAgent.ts` — inline aesthetic descriptors

**Evidence:** Three separate definitions of "South Asian graphic novel" style strings across three files. Any change requires updates in all three places.

**Fix:** Extract to a shared constants file (`src/config/universeStyles.ts`) or to the `Universe` model.

---

## TD-006 — `logUserEvent` is a No-Op 🔴

**Location:** `src/services/logService.ts:4-6`

**Evidence:**
```typescript
export async function logUserEvent(event: string, data?: any): Promise<void> {
  // No-op — analytics not yet implemented
}
```

**Impact:** Zero analytics data is being collected. No render counts, no failure rates, no user engagement data.

**Fix:** Implement basic event logging — write to a `analytics_events` Firestore collection or a simple server-side log aggregator.

---

## TD-007 — `qualityService.ts` is a Fake Formula 🟡

**Location:** `src/services/qualityService.ts:1-8`

**Evidence:** `calculateQualityScore(project?)` returns `50 + (scenes >= 3 ? 20 : 0) + (no failed scenes ? 30 : 0)`. This number has no relationship to visual quality.

**Impact:** Quality scores shown in UI are meaningless; `project.quality_score` in Firestore is noise.

**Fix:** Either remove quality scoring entirely, or implement a meaningful metric (e.g., ratio of completed scenes, presence of captions, audio quality probe).

---

## TD-008 — `diff.ts` Always Re-Renders All Scenes 🟡

**Location:** `src/utils/diff.ts`

**Evidence:** `getScenesToRender(project)` returns all scene IDs unconditionally. No actual diffing logic exists.

**Impact:** Every edit triggers a full re-render of all scenes, even unchanged ones. 10-scene project: 10× unnecessary renders on every change.

**Fix:** Implement content-hash comparison — compare `generateSceneHash()` of current vs. previously rendered state; only re-render scenes where hash differs.

---

## TD-009 — `rateLimiter.ts` is a No-Op 🟡

**Location:** `src/utils/rateLimiter.ts`

**Evidence:** `geminiRateLimiter.schedule(fn)` calls `fn()` directly; `geminiRateLimiter.acquire()` is a no-op.

**Impact:** All Gemini API calls go out at full speed. Under concurrent renders, 429 errors hit the retry logic (`withRetry`) rather than being prevented proactively.

**Fix:** Implement a token-bucket or sliding-window rate limiter using `p-limit` or a simple queue.

---

## TD-010 — `quotaService.ts` is a No-Op 🟡

**Location:** `src/server/services/quotaService.ts`

**Evidence:** All methods are stubs (confirmed from routes/quota.ts returning hardcoded values).

**Impact:** Quota UI shows arbitrary numbers. No actual per-user quota enforcement.

---

## TD-011 — `rembgRunning` Global Mutex 🟡

**Location:** `src/services/renderService.ts:10`

**Evidence:** `let rembgRunning = false;` — module-level boolean. Only one rembg process can run at a time across all users and all projects.

**Impact:** If two users trigger renders simultaneously, the second user's rembg call enters a busy-wait loop. Under 3+ concurrent users, this becomes a de facto queue with unpredictable wait times.

**Fix:** Replace with a per-project semaphore or a process pool (3–4 rembg workers).

---

## TD-012 — Scenes Array in Project Document 🟡

**Location:** `src/models/project.ts` + `FirestoreService.saveProject()`

**Evidence:** All scenes are stored as an array nested inside the project document. Every scene update triggers a full PATCH of the entire project object.

**Impact:** Projects with 15+ scenes (e.g., 3-minute videos) send large payloads on every update. Firestore document size limit is 1 MiB; at ~25+ scenes with base64 chunks this becomes a risk.

**Fix:** Separate `scenes` sub-collection: `projects/{id}/scenes/{sceneId}`. Write per-scene on update.

---

## TD-013 — `orchestrator.ts` at 1340 Lines 🟡

**Location:** `src/pipeline/orchestrator.ts`

**Evidence:** 1340 lines handling: DB persistence, style engine, character detection, all pipeline stages, error recovery, Supabase client initialization.

**Impact:** Difficult to test, review, or extend safely. Adding a new pipeline stage requires understanding all 1340 lines.

**Fix:** Split into: `audioOrchestrator.ts`, `visualOrchestrator.ts`, `renderOrchestrator.ts`, `projectStore.ts` (DB layer).

---

## TD-014 — Legacy V1 `callAnimator` Dead Code 🟢

**Location:** `src/services/renderService.ts:39-85`

**Evidence:** `callAnimator(config)` invokes `src/scripts/animator.py` (V1 prototype). Called by `renderVisualClip()` for non-NARRATOR scenes with breathing/emotion/action effects. V3 and V4 supersede this entirely when their flags are on.

**Impact:** V1 still runs when USE_METRO_V4 is false (default). Adds latency for effects that are redundant with V3/V4.

**Fix:** Remove V1 animator calls once V4 is promoted to default. Keep `animator.py` as archive.

---

## TD-015 — `scene_animator_v3.py` `choices=` Constraint 🟢

**Location:** `src/scripts/scene_animator_v3.py` (argparse section)

**Evidence:** `choices=` used on `--emotion` and `--scene_type` — unknown values cause exit(2). V4 removed this constraint.

**Impact:** New emotion types or scene types cannot be used with V3 engine.

**Fix:** Remove `choices=` from V3 argparse (or promote V4 to default and deprecate V3).

---

## TD-016 — No Test Suite 🔴

**Location:** Entire project

**Evidence:** No `*.test.ts`, no `*.spec.ts`, no `__tests__/` directory, no test runner in `package.json`.

**Impact:** Any change to orchestrator, render service, or agents could silently break the pipeline with no automated detection.

**Fix:** Add Vitest (works with Vite/TypeScript), start with smoke tests for pipeline agents and renderService unit functions.

---

## TD-017 — Firebase Config Committed to Repo 🟢

**Location:** `firebase-applet-config.json` (root)

**Evidence:** Firebase `apiKey`, `authDomain`, `projectId`, `appId` committed to the repository.

**Impact:** This is standard practice for Firebase client configs (they are designed to be public). However, `apiKey` is rate-limited by Firebase; if repo is public, a bad actor could use it to trigger excessive Firestore/Auth reads.

**Assessment:** Low risk for a private repo. Monitor Firebase usage quotas.

---

## Summary by Priority

| Priority | Count | Key Items |
|----------|-------|-----------|
| 🔴 HIGH | 4 | Anchor URL bug, local paths in Firestore, no video upload to Supabase, no analytics |
| 🟡 MEDIUM | 8 | Aesthetic duplication, diff stub, rate limiter stub, rembg global mutex, orchestrator size, quotes service stub, quality score fake, scenes array in doc |
| 🟢 LOW | 3 | Legacy V1 animator, V3 choices= constraint, Firebase config in repo |
