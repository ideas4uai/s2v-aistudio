# 13 — Product Gap Analysis

## Current Product vs Target Product

### Current Product (What Exists Today)

s2v-aistudio is a **local video production pipeline** with a web UI for management. It automates the creation of short-form vertical videos (1080×1920) from a text topic through a 4-agent AI chain, with three Python rendering engines and FFmpeg-based stitch. A separate Universe of NULL branch handles animated series production with LoRA character images and part-based lip-sync.

**Works reliably today:**
- Topic → narrated animated video (5-15 minutes end-to-end)
- Firebase auth (Google Sign-In)
- Project CRUD (create, list, delete, view status)
- Universe + character/location management
- 25-asset character pack generation with consistency validation
- Voice cloning via ElevenLabs (UI + API)
- Three rendering engines (V3/V4/Doraemon) — V4 ready, flag-gated
- Caption burn (ASS subtitles) — professional quality

### Target Product (AI Universe Studio — 20 Modules)

A multi-creator AI animation studio that can:
1. Generate and publish educational + animated series videos at 2+2/week cadence
2. Maintain character/story continuity across episodes
3. Track performance analytics from platforms
4. Provide a searchable asset library
5. Manage prompt templates and style presets
6. Publish directly to YouTube, TikTok, Instagram
7. Support multiple universes and character packs

---

## Gap Map by Module

| # | Module | Current | Target | Gap Level |
|---|--------|---------|--------|-----------|
| 1 | Authentication | Firebase Google auth | + RBAC, multi-tenant | 🟡 Small |
| 2 | Dashboard | Project/universe list | + Analytics tiles, quick-start | 🟡 Small |
| 3 | Universe Management | Full CRUD | + Episode list, analytics | 🟡 Small |
| 4 | Character Manager | Creation wizard | + Edit, asset browser, version history | 🟡 Medium |
| 5 | Environment Manager | Sub-object in Universe | Dedicated manager + asset library | 🟡 Medium |
| 6 | Visual Style Manager | 4 profiles + 8 presets | User-editable, A/B, per-universe | 🟢 Small |
| 7 | Story Engine | 4-agent pipeline | + Memory context input | 🟡 Medium |
| 8 | Prompt Engine | Embedded in agents | Centralized library, user-editable | 🟡 Medium |
| 9 | Image Engine | Gemini + Replicate LoRA | + Fal.ai fallback, approval flow | 🟢 Small |
| 10 | Voice Engine | Piper+GCloud+silence, voice clone | + Per-char voice, ElevenLabs TTS, management | 🟡 Medium |
| 11 | Video Engine | Full pipeline (V3/V4/Doraemon) | + Supabase upload, progress streaming | 🟡 Small |
| 12 | Episode Manager | Manual seed scripts | Dedicated UI, ordering, templates | 🟡 Medium |
| 13 | Content Publishing | None (download only) | YouTube/TikTok/Instagram direct publish | 🔴 Large |
| 14 | Analytics | No-op stubs | Event tracking, platform performance, quota | 🔴 Large |
| 15 | Knowledge Base | None | RAG, document storage, retrieval | 🔴 Large |
| 16 | AI Review Engine | Consistency check (not wired) | Quality gate in main pipeline | 🟡 Medium |
| 17 | Memory Engine | Test file only | Cross-episode state, character arcs | 🔴 Large |
| 18 | AI Orchestration | Full 1340-line orchestrator | + Job queue, progress streaming | 🟡 Medium |
| 19 | Asset Management | Supabase storage (no UI) | Asset browser, tags, search, cleanup | 🟡 Medium |
| 20 | Future Readiness | Flag-gated, TypeScript | + Tests, observability, splitting | 🟡 Medium |

---

## Top 10 Blockers for 2 Educational + 2 UoN Videos/Week Goal

**Target cadence:** 4 videos/week continuously. Currently requires manual pipeline execution per video.

### Blocker 1: No Reliable Video Download URL 🔴

**Gap:** Final video stored at local `%TEMP%` path. `output_path` points to stub API endpoint. After any server restart, video is inaccessible.

**Impact:** Every finished video requires SSH/server access to retrieve.

**Fix:** Upload final MP4 to Supabase after `stitchScenes()`, store public URL in `project.output_url`. Wire `/api/assets/download` or just use Supabase URL directly.

**Effort:** 2-4 hours.

---

### Blocker 2: Anchor URL Bug 🔴

**Gap:** `characterAnchors.set(charKey, localTempPath)` at `orchestrator.ts:781-789` stores a local filesystem path. Downstream Gemini calls expecting an HTTP URL fail silently.

**Impact:** UoN multi-scene episodes with Veer/Byte/Nova as anchor characters silently produce inconsistent character rendering.

**Fix:** Upload anchor image to Supabase; store returned public URL.

**Effort:** 1-2 hours.

---

### Blocker 3: No Progress Visibility During Render 🔴

**Gap:** `jobs.ts` returns `{status:'pending'}` always. No SSE, no WebSocket. User sees a static spinner during a 10-15 minute render.

**Impact:** Users cannot tell if the render is progressing or stuck; they cannot make decisions (abort, retry).

**Fix:** Add an SSE endpoint (`GET /api/projects/:id/progress`); emit scene-level events from orchestrator.

**Effort:** 4-8 hours.

---

### Blocker 4: Per-Scene Retry Has No UI Entry Point 🟡

**Gap:** `runScenePipeline(projectId, sceneId)` exists in orchestrator but there's no button in ProjectEditor or ProjectDetail to trigger per-scene retry.

**Impact:** If 1 of 8 scenes fails, user must re-run the entire pipeline (costing 7× AI credits for the working scenes).

**Fix:** Add retry button per scene in ProjectEditor; call `POST /api/projects/:id/scenes/:sceneId/retry`.

**Effort:** 4-6 hours.

---

### Blocker 5: Diff Stub — All Scenes Re-Render on Every Edit 🟡

**Gap:** `diff.ts:getScenesToRender()` returns all scene IDs unconditionally.

**Impact:** Editing one scene's narration triggers re-render of all 8-10 scenes. Educational pipeline: 30+ seconds per scene × 8 = 4+ minutes wasted on unchanged content.

**Fix:** Implement content hash comparison in `diff.ts`; skip scenes where hash matches last rendered state.

**Effort:** 4-8 hours.

---

### Blocker 6: UoN Aesthetic Bleeding into Generic Pipeline 🟡

**Gap:** Pre-Fix-3, `INDIAN_AESTHETIC_SUFFIX` was appended to all projects. Post-Fix-3 (commit `aa15eef`), it's conditional on `project.universeId`. However, generic pipeline has no aesthetic suffix at all beyond the minimal generic style string — which may be weaker than needed for high-quality educational output.

**Impact:** Educational videos may look inconsistently styled across runs.

**Fix:** Define a generic educational aesthetic prompt in config; allow per-project or per-template overrides.

**Effort:** 2 hours.

---

### Blocker 7: Memory Engine Missing — UoN Episodes Start Cold 🟡

**Gap:** No `universe_memory` collection, no character state persistence.

**Impact:** Each UoN episode is generated without knowledge of previous episodes. Veer's emotional arc, Byte's evolving relationship with Veer, Nova's discoveries — all reset on every render.

**Fix:** Implement `universe_memory` Firestore collection; feed last 3 episode summaries into DirectorAgent and StoryboardAgent context.

**Effort:** 2-3 days.

---

### Blocker 8: No Content Publishing Integration 🔴

**Gap:** Users must manually download the video and upload to YouTube/TikTok. No platform API integration.

**Impact:** "2+2 per week" goal requires 4 manual uploads/week plus platform-specific formatting (title, description, tags, thumbnail).

**Note:** SEO metadata IS generated by `projectController.generateScript()` (title, description, 15 tags, thumbnail text) — it's available in `project.seo_metadata`. It just isn't used to drive publishing.

**Fix:** Implement YouTube Data API v3 upload using existing `seo_metadata`. Start with YouTube only.

**Effort:** 2-3 days (OAuth + upload flow).

---

### Blocker 9: Caption Timing Is Mechanical 🟡

**Gap:** Captions evenly divide `duration_actual` into equal chunks. Real word timing from Whisper would align captions to actual speech rhythm.

**Impact:** Educational videos with caption sync that doesn't match speech feel amateur. Reduces engagement for TikTok/YouTube Shorts.

**Fix:** Integrate OpenAI Whisper API (or whisper.cpp local) after audio generation; replace time-math with real word timestamps.

**Effort:** 4-8 hours.

---

### Blocker 10: No Analytics — Flying Blind 🔴

**Gap:** `logUserEvent()` is a no-op. No render count, failure rate, AI spend, video performance, or quota tracking.

**Impact:** Cannot identify which topics fail most, which rendering stages are slowest, or how much API budget is consumed per video.

**Fix:** Implement `logUserEvent()` to write to `analytics_events` Firestore collection; add render start/end/fail events in orchestrator; add basic dashboard tiles.

**Effort:** 4-6 hours for basic event logging.

---

## Missing Capabilities Summary

| Capability | Blocks |
|-----------|--------|
| Final video upload to Supabase | Reliable video delivery |
| Anchor URL fix | UoN character consistency |
| Progress streaming | User confidence during renders |
| Per-scene retry UI | AI credit efficiency |
| Real scene diffing | Incremental re-render |
| Memory engine | UoN story continuity |
| Platform publishing | "2+2/week" automation goal |
| Whisper captions | Educational video quality |
| Basic analytics | Data-driven decisions |
| Voice management UI | Using cloned voices effectively |
| Episode manager UI | UoN production workflow |

---

## Reuse Map for Gap Resolution

| Gap to Fill | Reuse From |
|-------------|-----------|
| Video upload to Supabase | Extend `FirestoreService.uploadAsset()` (already works for images) |
| Anchor URL fix | Use `FirestoreService.uploadAsset()` (one extra call) |
| Progress SSE | Extend `runPipeline()` with event emitter; new route reads it |
| Per-scene retry | `runScenePipeline()` already exists; just needs a route and UI button |
| Scene diffing | `generateSceneHash()` already exists in `hash.ts`; `diff.ts` needs implementation |
| Memory engine | New Firestore collection; feed context into existing DirectorAgent/StoryboardAgent prompts |
| Publishing | New route + YouTube API; feed from existing `project.seo_metadata` |
| Whisper captions | Replace `captionService.ts` body; keep same interface |
| Analytics | Implement `logUserEvent()` body; add events in existing orchestrator call sites |
