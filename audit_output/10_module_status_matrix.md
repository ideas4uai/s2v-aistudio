# 10 — Module Status Matrix

**Audit scope:** 20 modules of AI Universe Studio product spec.

Legend: ✅ Exists | ⚠️ Partial | ❌ Missing | 🔴 High priority | 🟡 Medium priority | 🟢 Low priority

---

## Module 1: Authentication

| Field | Value |
|-------|-------|
| **Status** | ✅ EXISTS |
| **File** | `src/lib/firebase.ts`, `src/server/utils/auth.ts`, `src/contexts/AuthContext.tsx` |
| **Lines** | firebase.ts: ~30; auth.ts: 1-27; AuthContext.tsx: 1-44 |
| **Evidence** | Firebase Google Sign-In (frontend popup), `verifyIdToken()` via Firebase Identity Toolkit REST (backend), AsyncLocalStorage token propagation |
| **Gap** | No role-based access control; no multi-tenant project isolation (any authenticated user can access any project by ID); dev mode bypasses auth with hardcoded `DEV_USER` |
| **Reuse note** | Fully reusable as-is |
| **Priority** | 🟡 MEDIUM (RBAC needed for multi-user production) |
| **Complexity** | LOW |
| **Confidence** | HIGH |

---

## Module 2: Dashboard

| Field | Value |
|-------|-------|
| **Status** | ✅ EXISTS |
| **File** | `src/pages/Dashboard.tsx` |
| **Lines** | ~150+ |
| **Evidence** | Project list with search (client-side) and sort (latest/oldest/name). Universe list. Project/universe delete with confirmation. Fetches from `/api/projects` and `/api/universes` in parallel. |
| **Gap** | No analytics tiles; no render stats; no quick-start CTAs; no project status indicators; no pagination (all loaded at once); no recent activity feed |
| **Reuse note** | Reusable with small extension (add analytics row, quick-start) |
| **Priority** | 🟡 MEDIUM |
| **Complexity** | LOW |
| **Confidence** | HIGH |

---

## Module 3: Universe Management

| Field | Value |
|-------|-------|
| **Status** | ⚠️ PARTIAL |
| **File** | `src/pages/UniverseEditor.tsx`, `src/controllers/universeController.ts` |
| **Lines** | universeController.ts: 1-80 |
| **Evidence** | Universe CRUD (create, read, update, delete) via Firestore. `StoryCharacter[]` and `StoryLocation[]` editing with AI image generation. 8 style presets. Universe linked to projects by `project.universeId`. |
| **Gap** | No episode list within universe page; no universe-level analytics; no episode ordering/numbering UI; style presets include Japanese options (Makoto Shinkai, Studio Ghibli) inconsistent with South Asian UoN brand; no "publish universe" flow |
| **Reuse note** | Reusable with moderate extension |
| **Priority** | 🟡 MEDIUM |
| **Complexity** | MEDIUM |
| **Confidence** | HIGH |

---

## Module 4: Character Manager

| Field | Value |
|-------|-------|
| **Status** | ⚠️ PARTIAL |
| **File** | `src/pages/CharacterOnboarding.tsx`, `src/services/characterAssetService.ts` |
| **Lines** | characterAssetService.ts: ~403 |
| **Evidence** | 5-step 25-asset generation wizard. Asset groups: Body Poses (4), Mouth/Lip Sync (6), Eye States (4), Brow States (3), Emotion Full-Body (8). CIE76 consistency validation per asset. Uploads to Supabase. |
| **Gap** | Create-only; no post-creation editing of individual assets; no asset browser/replacement UI; consistency score not displayed to user; no character version history; `STYLE_BASE` hardcodes "South Asian graphic novel" and cannot be configured per character |
| **Reuse note** | Reusable with moderate extension (add edit path, score display) |
| **Priority** | 🟡 MEDIUM |
| **Complexity** | MEDIUM |
| **Confidence** | HIGH |

---

## Module 5: Environment Manager

| Field | Value |
|-------|-------|
| **Status** | ❌ MISSING |
| **File** | `src/models/project.ts` (StoryLocation interface only) |
| **Lines** | project.ts: 104 (StoryLocation defined at ~line 30) |
| **Evidence** | `StoryLocation` interface exists with `id`, `name`, `description`, `imageUrl`, `type`. Locations are sub-arrays inside Universe objects, editable from `UniverseEditor.tsx`. No dedicated location manager. No location asset generation wizard. No location reuse across projects. |
| **Gap** | No dedicated environment/location manager page; no location asset pack generation; no location library for reuse across episodes; locations are edit-in-place sub-objects in UniverseEditor |
| **Reuse note** | Build on existing StoryLocation model + UniverseEditor location section |
| **Priority** | 🟢 LOW (locations managed within UniverseEditor for now) |
| **Complexity** | MEDIUM |
| **Confidence** | HIGH |

---

## Module 6: Visual Style Manager

| Field | Value |
|-------|-------|
| **Status** | ⚠️ PARTIAL |
| **File** | `src/pages/UniverseEditor.tsx` (8 style presets), `src/pipeline/orchestrator.ts:71-84` (`applyStyleToPrompt`) |
| **Lines** | orchestrator.ts:71-84 |
| **Evidence** | `applyStyleToPrompt(prompt, style)` supports 4 `StyleProfile` values: `cinematic`, `minimal`, `high-contrast`, `documentary`. UniverseEditor has 8 named presets that set style + background art style strings. |
| **Gap** | No standalone visual style manager; styles are not user-editable custom objects; aesthetic strings are hardcoded in 3 different files; no style preview/comparison; `StyleProfile` type has only 4 values but UniverseEditor offers 8 presets (mismatch) |
| **Reuse note** | Reusable with refactor (extract to shared config) |
| **Priority** | 🟢 LOW |
| **Complexity** | LOW |
| **Confidence** | HIGH |

---

## Module 7: Story Engine

| Field | Value |
|-------|-------|
| **Status** | ✅ EXISTS |
| **File** | `src/pipeline/agents/directorAgent.ts`, `scriptwriterAgent.ts`, `storyboardAgent.ts`, `worldAgent.ts` |
| **Lines** | 62–236 lines each |
| **Evidence** | Full 4-agent pipeline: Director planning → Script writing → World entity extraction → Scene graph generation with emotion detection, character detection, background prompt generation, motion instruction selection |
| **Gap** | No story memory/continuity across episodes; world entities not surfaced in UI; `SPEAKER_PATTERNS` for UoN characters hardcoded in generic agent; no script versioning; director plan not persisted |
| **Reuse note** | Fully reusable; extend with memory engine when ready |
| **Priority** | 🟢 LOW (works well; memory is the big gap) |
| **Complexity** | MEDIUM |
| **Confidence** | HIGH |

---

## Module 8: Prompt Engine

| Field | Value |
|-------|-------|
| **Status** | ⚠️ PARTIAL |
| **File** | `src/pipeline/orchestrator.ts:71-84`, `src/pipeline/agents/` (prompts embedded), `src/services/characterAssetService.ts` (`ASSET_PROMPTS`) |
| **Lines** | orchestrator.ts:71-84; characterAssetService.ts: ASSET_PROMPTS at ~40-130 |
| **Evidence** | `applyStyleToPrompt()` applies 4 style profiles to any prompt. `ASSET_PROMPTS` record maps 25 asset names to generation prompts. Background prompt construction in orchestrator with aesthetic suffix injection. |
| **Gap** | No standalone prompt template library; no user-editable prompt templates; prompt logic scattered across 4 files; no A/B prompt testing; no prompt history/versioning; visual prompt from StoryboardAgent is used verbatim without user review step |
| **Reuse note** | Reusable with refactor (centralize into PromptEngine service) |
| **Priority** | 🟡 MEDIUM |
| **Complexity** | MEDIUM |
| **Confidence** | HIGH |

---

## Module 9: Image Engine

| Field | Value |
|-------|-------|
| **Status** | ✅ EXISTS |
| **File** | `src/services/aiService.ts`, `src/services/assetService.ts`, `src/services/characterAssetService.ts` |
| **Lines** | aiService.ts: ~448; assetService.ts: ~115 |
| **Evidence** | `AIService.generateImageBase64()` supports Gemini Flash-Image and Replicate LoRA paths. `assetService.generateAsset()` adds Picsum fallback. Character asset service generates 25 named PNG assets with consistency validation. |
| **Gap** | No image approval workflow; Picsum fallback is visible in production when Gemini fails (stock photos in educational videos); no image variation/regeneration from a confirmed seed; no human-in-the-loop review before image is used in render |
| **Reuse note** | Reusable as-is; extend with Fal.ai/Together AI fallback chain |
| **Priority** | 🟡 MEDIUM |
| **Complexity** | LOW |
| **Confidence** | HIGH |

---

## Module 10: Voice Engine

| Field | Value |
|-------|-------|
| **Status** | ⚠️ PARTIAL |
| **File** | `src/server/services/ttsService.ts`, `src/server/routes/voices.ts`, `src/services/voiceService.ts` |
| **Lines** | ttsService.ts: ~200; voices.ts: ~76; voiceService.ts: ~50 |
| **Evidence** | Triple fallback TTS: Piper → Google Cloud TTS → ffmpeg silence. ElevenLabs voice cloning via `POST /api/voices/clone` (multer + proxy). Duration probing via ffprobe. |
| **Gap** | No voice preview after cloning; no voice management UI (list/delete/test cloned voices); no per-character voice assignment (all scenes use same project voice); no ElevenLabs TTS (only voice cloning — TTS still uses Piper/GCloud); cloned `voiceId` not persisted to Firestore |
| **Reuse note** | Reusable with extension (voice management, per-character routing) |
| **Priority** | 🟡 MEDIUM |
| **Complexity** | MEDIUM |
| **Confidence** | HIGH |

---

## Module 11: Video Engine

| Field | Value |
|-------|-------|
| **Status** | ✅ EXISTS |
| **File** | `src/services/renderService.ts`, `src/scripts/metro_engine_v4.py`, `src/scripts/doraemon_engine.py`, `src/scripts/scene_animator_v3.py` |
| **Lines** | renderService.ts: 893; metro_engine_v4.py: ~500; doraemon_engine.py: ~400 |
| **Evidence** | Full FFmpeg rendering pipeline: visual clip → segment assembly (stream_loop + setpts) → caption burn (ASS subtitles, Arial 34pt bold) → stitch (concat demuxer, -vsync cfr). Three Python animation engines (V3/V4/Doraemon) with clean CLI contract. Background music mixing supported. |
| **Gap** | Concurrent rembg blocked by global mutex; no render progress streaming to UI; final video stored only on local FS (not Supabase); output_path points to stub endpoint |
| **Reuse note** | Fully reusable; extend with progress SSE and Supabase upload |
| **Priority** | 🔴 HIGH (Supabase upload for final video is critical) |
| **Complexity** | HIGH |
| **Confidence** | HIGH |

---

## Module 12: Episode Manager

| Field | Value |
|-------|-------|
| **Status** | ⚠️ PARTIAL |
| **File** | `src/models/project.ts` (episodeNumber, universeId fields), `scripts/seed_ep2.ts`, `scripts/stitch_ep2.ts` |
| **Lines** | project.ts: 104 |
| **Evidence** | `Project` model has `universeId` and `episodeNumber` fields. Projects can be linked to universes as episodes. Seed scripts exist for specific UoN episodes (pilot, EP2). Manual stitch script exists for EP2. |
| **Gap** | No episode manager UI; episode ordering is manual via seed scripts; no episode list view from Dashboard or Universe page; no episode template (new episode uses CreateProject wizard, then manually sets universe link); no episode continuity check |
| **Reuse note** | Extend universe model + add `/universes/:id/episodes` page |
| **Priority** | 🟡 MEDIUM |
| **Complexity** | MEDIUM |
| **Confidence** | HIGH |

---

## Module 13: Content Publishing

| Field | Value |
|-------|-------|
| **Status** | ❌ MISSING |
| **File** | None |
| **Evidence** | Searched entire `src/` — no YouTube, TikTok, Instagram, or social media integration. No `publish` route, no platform API clients, no OAuth flows for platform auth. Final video access requires local file download. `output_path` points to a stub endpoint. |
| **Gap** | Entire module missing. No publish flow, no platform connections, no scheduling, no analytics from platforms. |
| **Reuse note** | Build new — recommend starting with YouTube Data API v3 |
| **Priority** | 🔴 HIGH (critical for "2 educational + 2 UoN per week" goal) |
| **Complexity** | HIGH |
| **Confidence** | HIGH |

---

## Module 14: Analytics

| Field | Value |
|-------|-------|
| **Status** | ❌ MISSING |
| **File** | `src/services/logService.ts` (stub only) |
| **Lines** | logService.ts: 6 |
| **Evidence** | `logUserEvent(event, data?)` body is empty `{}` (confirmed by reading file). `qualityService.calculateQualityScore()` returns a formula number. `quotaService` is all stubs. No analytics data stored anywhere. |
| **Gap** | Entire analytics module missing. No render event tracking, no failure rate monitoring, no user engagement metrics, no video performance analytics. |
| **Reuse note** | Build new — can wire into existing `logService.ts` entry point |
| **Priority** | 🔴 HIGH |
| **Complexity** | MEDIUM |
| **Confidence** | HIGH |

---

## Module 15: Knowledge Base

| Field | Value |
|-------|-------|
| **Status** | ❌ MISSING |
| **File** | None |
| **Evidence** | No RAG system, no vector store, no knowledge document storage, no embedding generation, no retrieval pipeline referenced anywhere in the codebase. `policy.yaml`, `policy_general.yaml`, `policy_project.yaml` at root are AI content policy configs, not a knowledge base. |
| **Gap** | Entire module missing. |
| **Reuse note** | Build new |
| **Priority** | 🟢 LOW (not needed for weekly video posting goal) |
| **Complexity** | HIGH |
| **Confidence** | HIGH |

---

## Module 16: AI Review Engine

| Field | Value |
|-------|-------|
| **Status** | ⚠️ PARTIAL |
| **File** | `src/scripts/validate_consistency.py`, `src/services/qualityService.ts` |
| **Lines** | validate_consistency.py: ~100; qualityService.ts: 8 |
| **Evidence** | `validate_consistency.py` computes CIE76 LAB colour distance between character asset and reference image. Called by `characterAssetService.ts` during pack generation. `qualityService.calculateQualityScore()` is a fake formula. |
| **Gap** | Consistency validator works but is never called during episode rendering (only character onboarding). No AI-based visual quality check. No narrative coherence check across scenes. `qualityService` quality score is meaningless. |
| **Reuse note** | Extend validate_consistency.py; wire into orchestrator; replace qualityService formula |
| **Priority** | 🟢 LOW |
| **Complexity** | MEDIUM |
| **Confidence** | HIGH |

---

## Module 17: Memory Engine

| Field | Value |
|-------|-------|
| **Status** | ❌ MISSING |
| **File** | `scripts/test_memory_store.ts` (test only, no implementation) |
| **Evidence** | `test_memory_store.ts` exists as an operational test script but references no `memoryStore` service or implementation. No memory storage, no episode-to-episode state persistence, no character arc tracking. |
| **Gap** | Entire module missing. UoN characters Veer, Byte, Nova have no state that persists between episodes. Each episode render starts cold with no knowledge of prior events. |
| **Reuse note** | Build new — recommend Firestore `universe_memory` collection with event log |
| **Priority** | 🟡 MEDIUM (UoN quality depends on it) |
| **Complexity** | HIGH |
| **Confidence** | HIGH |

---

## Module 18: AI Orchestration

| Field | Value |
|-------|-------|
| **Status** | ✅ EXISTS |
| **File** | `src/pipeline/orchestrator.ts`, `src/pipeline/abortManager.ts` |
| **Lines** | orchestrator.ts: 1340; abortManager.ts: 30 |
| **Evidence** | Full pipeline orchestration: all stages, retry logic, abort control, in-memory + Firestore dual persistence, per-scene stage tracking, single-scene recovery via `runScenePipeline()`, fallback data for complete AI failure |
| **Gap** | No job queue; pipelines run in-process; no real-time progress events; single file at 1340 lines is a maintenance risk; recovery is per-scene, not per-stage-within-scene |
| **Reuse note** | Reusable with refactor (split into sub-orchestrators) |
| **Priority** | 🟡 MEDIUM |
| **Complexity** | HIGH |
| **Confidence** | HIGH |

---

## Module 19: Asset Management

| Field | Value |
|-------|-------|
| **Status** | ⚠️ PARTIAL |
| **File** | `src/server/db/firestore.ts` (`uploadAsset`, `deleteAssetByUrl`), `src/server/routes/assets.ts` (stub) |
| **Lines** | firestore.ts: uploadAsset at lines 222-254; assets.ts: 6 |
| **Evidence** | `FirestoreService.uploadAsset()` uploads to Supabase `aivideogen` bucket. `deleteAssetByUrl()` parses URL and calls Supabase `.remove()`. `GET /api/assets` returns `[]` always. No asset browser UI. |
| **Gap** | No asset browser; no asset search; no orphan detection/cleanup; no asset tags or metadata; `assets.ts` route is a stub; audio and intermediate video files not persisted to Supabase |
| **Reuse note** | Extend `uploadAsset`; implement `assets.ts` route; add asset browser page |
| **Priority** | 🟡 MEDIUM |
| **Complexity** | MEDIUM |
| **Confidence** | HIGH |

---

## Module 20: Future Readiness

| Field | Value |
|-------|-------|
| **Status** | ⚠️ PARTIAL |
| **File** | Multiple — env flags, TypeScript throughout, agent architecture |
| **Evidence** | `USE_METRO_V4`, `USE_DORAEMON`, `UNIFIED_SCENES` env flags for safe engine promotion. Modular agent architecture (4 agents, each extensible). TypeScript strict mode. `withRetry()` for resilience. `abortManager` for clean cancellation. Python engines share CLI contract (easy to add new engine). |
| **Gap** | No test suite (zero tests); hardcoded aesthetic strings in 3 places risk contamination; 5 stub routes create false sense of API completeness; no observability (no metrics, no distributed tracing, no error tracking like Sentry); `orchestrator.ts` is 1340 lines (single point of change for all pipeline features) |
| **Reuse note** | Good foundation; add testing and observability |
| **Priority** | 🟡 MEDIUM |
| **Complexity** | MEDIUM |
| **Confidence** | HIGH |

---

## Summary Table

| # | Module | Status | Priority | Complexity |
|---|--------|--------|----------|------------|
| 1 | Authentication | ✅ | 🟡 M | LOW |
| 2 | Dashboard | ✅ | 🟡 M | LOW |
| 3 | Universe Management | ⚠️ | 🟡 M | MEDIUM |
| 4 | Character Manager | ⚠️ | 🟡 M | MEDIUM |
| 5 | Environment Manager | ❌ | 🟢 L | MEDIUM |
| 6 | Visual Style Manager | ⚠️ | 🟢 L | LOW |
| 7 | Story Engine | ✅ | 🟢 L | MEDIUM |
| 8 | Prompt Engine | ⚠️ | 🟡 M | MEDIUM |
| 9 | Image Engine | ✅ | 🟡 M | LOW |
| 10 | Voice Engine | ⚠️ | 🟡 M | MEDIUM |
| 11 | Video Engine | ✅ | 🔴 H | HIGH |
| 12 | Episode Manager | ⚠️ | 🟡 M | MEDIUM |
| 13 | Content Publishing | ❌ | 🔴 H | HIGH |
| 14 | Analytics | ❌ | 🔴 H | MEDIUM |
| 15 | Knowledge Base | ❌ | 🟢 L | HIGH |
| 16 | AI Review Engine | ⚠️ | 🟢 L | MEDIUM |
| 17 | Memory Engine | ❌ | 🟡 M | HIGH |
| 18 | AI Orchestration | ✅ | 🟡 M | HIGH |
| 19 | Asset Management | ⚠️ | 🟡 M | MEDIUM |
| 20 | Future Readiness | ⚠️ | 🟡 M | MEDIUM |

**Counts: ✅ 5 | ⚠️ 9 | ❌ 6**
