# 14 — Chief Software Architect Synthesis

## Conflict Resolution from Prior Findings

### Conflict 1: "5 routes are stubs" vs "API is largely complete"

**Resolution:** The routes layer is split. `/api/projects` (311 lines) is fully implemented and handles all pipeline operations. The 5 stub routes (`assets`, `feedback`, `jobs`, `quota`, `visuals`) are placeholders that exist but are not functional. The API is complete for the core workflow; missing for ancillary features. Downgrade: the API is not "largely complete" — it is complete for the critical path only.

### Conflict 2: "Video Engine is fully functional" vs "output is inaccessible after restart"

**Resolution:** The Video Engine renders correctly, but the delivery mechanism is broken (local temp path + stub download endpoint). Maintain ✅ status for the engine itself, but flag ❌ for the delivery layer. The engine produces a correct MP4; the system does not deliver it reliably. This is the single highest-priority fix.

### Conflict 3: "Authentication is strong" vs "no ownership check on project access by ID"

**Resolution:** Authentication (proving who you are) is strong. Authorization (proving you're allowed to do this) has a gap. `GET /api/projects/:id` does not verify that the requester owns the project. For a single-user system, this is acceptable. For multi-user production, this is a security gap. Confidence: HIGH (read the auth flow in full). Downgrade: auth is ✅ but authorization is ⚠️.

### Conflict 4: "Orchestrator is production-ready" vs "1340 lines creates maintenance risk"

**Resolution:** The orchestrator works correctly. The risk is maintainability and testability, not correctness. It is production-ready in the sense that it produces correct outputs; it is not production-ready in the sense that adding any new feature requires careful reading of 1340 lines. Keep ✅ for current functionality; flag 🟡 for architectural risk.

### Conflict 5: "Metro V4 is built" vs "it's not the default engine"

**Resolution:** Metro V4 is fully built, tested (test_metro_v4.ts), and flag-gated behind `USE_METRO_V4=true`. It is not the production default. This is the correct approach — V3 is the safe fallback. V4 promotion should happen after a full episode render validation. Both claims are true simultaneously.

---

## What to Keep

1. **The 4-agent pipeline architecture** — DirectorAgent → ScriptwriterAgent → StoryboardAgent → WorldAgent. Clean, modular, extensible. Adding a 5th agent (e.g., a MemoryAgent that injects prior episode context) requires zero changes to existing agents.

2. **The Python engine flag-gating system** — `USE_METRO_V4`, `USE_DORAEMON`, `USE_UNIFIED_SCENES` pattern. This is the right way to evolve a production rendering pipeline. V3 stays untouched as fallback. V4 can be promoted globally once validated.

3. **Firebase Auth + AsyncLocalStorage pattern** — `verifyIdToken()` is minimal and correct. `requestContext` propagation is clean. Do not replace this with a heavier auth library.

4. **Supabase Storage + Firestore combination** — Object storage (Supabase) + document store (Firestore) is the right split for this kind of application. Do not migrate to PostgreSQL; the data is not relational enough to justify the migration cost.

5. **`withRetry()` and `abortManager`** — These are production-grade primitives. Every new AI call should use `withRetry()`; every new pipeline should register with `abortManager`.

6. **The FFmpeg pipeline in renderService.ts** — `assembleSceneSegment` → `renderCaptions` → `stitchScenes` is a clean three-stage pipeline. The caption ASS style (Arial 34pt bold, 3px outline) is already industry-standard. The stitch fix (remove `+genpts`, add `-vsync cfr`) is correct.

---

## What to Extend

1. **`orchestrator.ts`** — Extend the existing file (not replace it) by extracting the 3 largest concerns into sub-modules: `src/pipeline/stores/projectStore.ts` (DB reads/writes), `src/pipeline/stages/audioStage.ts`, `src/pipeline/stages/visualStage.ts`. The main orchestrator becomes a thin coordinator calling sub-modules. This can be done incrementally, one extracted module at a time.

2. **`firestore.ts`** — Add `createDocument()` (currently `saveDocument()` always uses PATCH — needs POST for new documents to avoid overwriting). Add the Supabase final-video upload method.

3. **`aiService.ts`** — Add Fal.ai and Together AI as image generation fallbacks when Gemini fails (not on 429, but on content refusal).

4. **`logService.ts`** — Implement the body of `logUserEvent()`. 10 lines of code. This unlocks the entire analytics module without structural changes.

5. **`StoryboardAgent`** — Add optional `memoryContext: string` parameter. When provided, inject it into the scene generation prompt. The Memory Engine writes to Firestore; the orchestrator reads it and passes it here. Zero changes to the agent interface.

---

## What to Deprecate

1. **V1 `callAnimator()`** — Remove from `renderService.ts` once V4 is promoted to default. Reduces render complexity and eliminates the `animator.py` subprocess.

2. **Picsum fallback in `assetService.ts`** — Replace with Fal.ai or Together AI image generation when Gemini fails. Stock photos in an AI video product destroy trust.

3. **`diff.ts` stub** — Replace the stub with real content-hash scene diffing. The `generateSceneHash()` function already exists; the diff logic is the only missing piece.

---

## What to Absolutely Never Change

1. **`metro_engine_v3.py` and `scene_animator_v3.py`** — These are the production fallback. They produce known-good output. Any change risks regressions in the default rendering path.

2. **The CLI contract for Python engines** — `--background`, `--character`, `--output`, `--duration`, `--emotion`, `--scene_type`, `--fps`, `--width`, `--height`, exit 0 + >10KB = success. This is the interface contract between TypeScript and Python. Changing it requires coordinated changes in both layers.

3. **The Firebase Auth flow** — `signInWithGoogle()` + `verifyIdToken()` + `requestContext`. This works; it is stable; it is the security perimeter. Do not add JWT complexity or replace with a different auth provider.

---

## Highest ROI Improvement

**Implement final video upload to Supabase.**

Every other feature depends on users being able to reliably access their rendered videos. Currently, a server restart or deployment silently deletes all rendered outputs. This is a 2-4 hour change in `renderService.ts`:

1. After `stitchScenes()` succeeds, call `FirestoreService.uploadAsset(projectId, 'output.mp4', localPath, 'video/mp4')`
2. Store the returned public URL in `project.output_url`
3. Update the frontend to use `project.output_url` for download

This single change converts the pipeline from "works once on the current server" to "works permanently and is accessible from anywhere."

---

## If You Could Only Build ONE Feature Next Month

**Build YouTube publishing with SEO metadata.**

The system already:
- Generates SEO title (60 chars max), description (150 words), 15 tags, thumbnail text in `projectController.generateScript()`
- Produces a finished MP4
- Has Firebase auth to identify users

Adding YouTube Data API v3 upload means:
- User finishes a render → clicks "Publish to YouTube" → video goes live
- SEO metadata is auto-populated from what was already generated
- The "2+2 per week" goal becomes achievable without manual platform work

This single feature closes the last mile between "renders a video" and "publishes content at scale." Everything else (analytics, memory engine, episode manager, knowledge base) becomes more valuable after publishing is working, because it gives you data and audience feedback to optimize against.

---

## Low-Confidence Areas (Flagged)

| Area | What Was Not Read | Confidence | Risk |
|------|------------------|------------|------|
| QuotaContext implementation | `src/contexts/QuotaContext.tsx` not fully read | MEDIUM | May have more logic than assumed |
| `projectController.ts` beyond line 350 | Remaining controller functions not read | MEDIUM | May have additional API operations |
| `server.ts` beyond initial routes | Route registration details not fully read | MEDIUM | May have additional middleware |
| Python engine internals | V4/Doraemon read at high level only | MEDIUM | Specific rendering bugs may exist |
| Supabase bucket policies | Not readable from codebase | LOW | Assets may not be publicly accessible as assumed |

All HIGH-confidence findings are backed by reading the actual source files cited. MEDIUM-confidence findings are based on partial reads or inference from adjacent code.
