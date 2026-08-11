# 02 — Codebase Inventory

## Entry Points

| File | Lines | Purpose |
|------|-------|---------|
| `server.ts` | ~810 | Express + Vite bootstrap; registers all routes; seeds Firestore templates on cold start |
| `src/main.tsx` | ~10 | React SPA entry; mounts App into DOM |
| `src/App.tsx` | ~35 | React Router v6 with 6 routes; wraps AuthProvider + QuotaProvider |

---

## src/models/ — Domain Model

| File | Lines | Purpose | Key Exports |
|------|-------|---------|-------------|
| `types.ts` | 7 | Central union types | `VideoMode`, `JobStatus` (incl. `'degraded'`), `PacingIntensity`, `StyleProfile`, `SceneType`, `AssetType`, `TransitionType` |
| `template.ts` | 12 | Template interface | `Template` |
| `project.ts` | 104 | Full project domain model + universe sub-types | `StoryCharacter` (LoRA fields), `StoryLocation`, `Universe`, `Project` |
| `scene.ts` | 122 | Scene, visual, caption data structures | `WordTimestamp`, `CaptionChunk`, `VisualFrame`, `Visual`, `VisualSegment`, `Scene` |

**Notable model fields:**
- `Project.projectType`: `'educational' | 'story_episode' | 'standard'`
- `Scene.render_mode`: `'generative' | 'cutout'`
- `Scene.stage`: `'audio' | 'audio_and_visuals' | 'captions' | 'asset' | 'render' | 'done'`
- `StoryCharacter.loraStatus`: `'training' | 'ready' | 'failed'`
- `Scene.unified`, `Scene.prev_scene_type`, `Scene.next_scene_type` — Metro V4 transition fields

---

## src/services/ — Business Services

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| `aiService.ts` | ~448 | Gemini/Imagen AI client; Replicate LoRA inference | ✅ Production |
| `renderService.ts` | 893 | Full FFmpeg rendering pipeline; Python engine spawner | ✅ Production |
| `voiceService.ts` | ~50 | Audio generation + ffprobe duration probe | ✅ Production |
| `captionService.ts` | ~102 | Time-math caption generation (no ASR) | ⚠️ Functional but fake timing |
| `assetService.ts` | ~115 | Image asset generation with Picsum fallback | ⚠️ Picsum fallback visible in prod |
| `characterAssetService.ts` | ~403 | 25-part character asset pack generation | ✅ Production |
| `logService.ts` | 6 | Logging stub; `logUserEvent` is a no-op | ❌ Analytics not implemented |
| `cacheService.ts` | 27 | File-system cache | ⚠️ Non-file data silently skipped |
| `qualityService.ts` | 8 | Fake quality score (base 50 + scene count) | ❌ Not meaningful |

---

## src/pipeline/ — Pipeline Coordination

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| `orchestrator.ts` | ~1340 | Master pipeline coordinator; all stage sequencing | ✅ Production (large) |
| `abortManager.ts` | ~30 | Per-project AbortController registry | ✅ Production |
| `fallbacks.ts` | ~38 | Static fallback data when AI fails entirely | ✅ Production |

### src/pipeline/agents/

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| `directorAgent.ts` | ~101 | Creative director plan (visual style, camera, pacing) | ✅ Production |
| `scriptwriterAgent.ts` | ~156 | Narration script from director plan | ✅ Production |
| `storyboardAgent.ts` | ~236 | Scene graph from script (emotion, character, shot type) | ✅ Production |
| `worldAgent.ts` | ~62 | World entity extraction (characters, locations, objects) | ✅ Production |

---

## src/server/ — Backend Infrastructure

### src/server/routes/

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| `projects.ts` | ~311 | Full project CRUD + all pipeline trigger endpoints | ✅ Production |
| `voices.ts` | ~76 | ElevenLabs voice cloning proxy (multer upload) | ✅ Production |
| `templates.ts` | ~61 | In-memory template CRUD (2 hardcoded defaults) | ⚠️ In-memory only |
| `assets.ts` | 6 | Stub — returns `[]` | ❌ Not implemented |
| `feedback.ts` | 6 | Stub — returns `{success:true}` | ❌ Not implemented |
| `jobs.ts` | 10 | Stub — returns `{status:'pending'}` | ❌ Not implemented |
| `quota.ts` | 13 | Stub — hardcoded limits, no tracking | ❌ Not implemented |
| `visuals.ts` | 6 | Stub — returns `{status:'queued'}` | ❌ Not implemented |

### src/server/db/

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| `firestore.ts` | ~400 | Dual-layer: Supabase Storage + Firestore REST API | ✅ Production |

### src/server/services/

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| `ttsService.ts` | ~200+ | TTS: Piper → Google Cloud TTS → ffmpeg silence | ✅ Production (triple fallback) |
| `quotaService.ts` | ~? | Quota enforcement stub | ❌ All no-ops |

### src/server/utils/

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| `auth.ts` | ~27 | Firebase token verification via Identity Toolkit REST | ✅ Production |
| `context.ts` | 3 | AsyncLocalStorage for per-request token | ✅ Production |

---

## src/controllers/ — Request Handlers

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| `projectController.ts` | ~? | All project API handlers; delegates to orchestrator | ✅ Production |
| `universeController.ts` | ~80 | Universe CRUD handlers; delegates to FirestoreService | ✅ Production |

---

## src/pages/ — Frontend Pages (React)

| File | Route | Purpose | Status |
|------|-------|---------|--------|
| `Dashboard.tsx` | `/` | Project list; search/sort; delete | ✅ Functional |
| `CreateProject.tsx` | `/projects/new` | 3-type project creation wizard | ✅ Functional |
| `ProjectDetail.tsx` | `/projects/:id` | Read-only status view; polls render progress | ✅ Functional |
| `ProjectEditor.tsx` | `/projects/:id/edit` | Full scene-level editor; render trigger | ✅ Functional (heaviest page) |
| `UniverseEditor.tsx` | `/universes/:id` | Universe + character/location management | ✅ Functional |
| `CharacterOnboarding.tsx` | `/characters/new` | 5-step 25-asset character generation wizard | ✅ Functional |

---

## src/components/ — React Components

| File | Purpose | Status |
|------|---------|--------|
| `Layout.tsx` | Top navbar; Firebase auth login/logout | ✅ Functional |
| `VoiceCloner.tsx` | Multi-file upload for ElevenLabs voice cloning | ✅ Functional |
| `FeedbackModal.tsx` | Thumbs up/down + text feedback modal | ✅ Functional (API stub) |
| `QuotaIndicator.tsx` | Sidebar quota countdown (reads from QuotaContext) | ⚠️ UI works; backend stub |
| `ApiKeyGuard.tsx` | Pass-through wrapper (no actual key gate) | ❌ Stub |
| `ui/card.tsx` | Shadcn/ui-style Card component | ✅ Functional |

---

## src/contexts/ — React Contexts

| File | Purpose | Status |
|------|---------|--------|
| `AuthContext.tsx` | Firebase Auth state; Google Sign-In/out | ✅ Functional |
| `QuotaContext.tsx` | Quota state; live reset countdown | ⚠️ Reads from stub backend |

---

## src/utils/ — Shared Utilities

| File | Purpose | Status |
|------|---------|--------|
| `api.ts` | `authenticatedFetch()` with Firebase idToken header | ✅ Functional |
| `geminiAuth.ts` | Task-based Gemini key routing (4 keys) + ADC support | ✅ Functional |
| `hash.ts` | djb2 hash → hex for cache keys | ✅ Functional |
| `path.ts` | `toUrl()` — server path → web URL | ✅ Functional |
| `retry.ts` | `withRetry()` — exponential backoff, 429 detection | ✅ Functional |
| `rateLimiter.ts` | No-op rate limiter stub | ❌ Not implemented |
| `diff.ts` | Scene diff stub — always returns all scenes | ❌ Not implemented |
| `timeline.ts` | `buildSceneTimeline()` from completed visuals | ✅ Functional |

---

## src/scripts/ — Python Engines + Test Scripts

### Python Engines

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| `metro_engine_v3.py` | ~300 | Library: Ken Burns + vertical parallax (no CLI) | ✅ Production fallback |
| `scene_animator_v3.py` | ~120 | CLI wrapper for V3 engine | ✅ Production fallback |
| `metro_engine_v4.py` | ~500+ | Cinematic compositing: 3-layer parallax, idle, transitions | ✅ Built (flag-gated) |
| `doraemon_engine.py` | ~400 | Part-based lip-sync engine for Veer character | ✅ Built (flag-gated) |
| `rembg_worker.py` | ~39 | Neural background removal worker process | ✅ Production |
| `depth_parallax.py` | ~120 | Depth-map 2.5D parallax (optional, try/except guarded) | ✅ Built |
| `validate_consistency.py` | ~100 | CIE76 LAB skin-tone consistency checker | ✅ Built (not wired to main pipeline) |
| `animator.py` | ~150 | Original V1 prototype animation engine | ⚠️ Legacy; V3/V4 supersede it |

### Operational TypeScript Scripts (root `scripts/`)

| File | Purpose |
|------|---------|
| `seed_ep2.ts`, `seed_pilot.ts` | One-time Firestore seeders for Episode 2 and Pilot |
| `stitch_ep2.ts` | Manual FFmpeg stitch for Episode 2 |
| `test_metro_v4.ts` | Integration test for metro_engine_v4.py |
| `verify_ep2.ts` | Reports on EP2 scene state; flags aesthetic leakage |
| `update_ep2_backgrounds.ts` | Batch-update EP2 background prompts in Firestore |
| `run_nova_pack.ts` | Nova character asset pack generator |
| `rife_interpolate.py` | RIFE frame interpolation (24→48 fps) |

---

## src/lib/ — Library Wrappers

| File | Purpose | Status |
|------|---------|--------|
| `firebase.ts` | Firebase init + auth helpers | ✅ Functional |
| `utils.ts` | `cn()` — clsx + tailwind-merge | ✅ Functional |

---

## src/types/ — Shared TypeScript Types

| File | Purpose |
|------|---------|
| `character.ts` | `AssetResult`, `AssetPackResult` interfaces |

---

## Missing Directories (confirmed absent)

| Directory | Notes |
|-----------|-------|
| `src/hooks/` | No custom hooks directory; hook logic inlined into pages |
| `src/store/` | No Redux/Zustand/Jotai state store |
| `supabase/` | No Supabase migration files; storage only |
| `prisma/` | No ORM; Firestore is schemaless |
| `migrations/` | No SQL migrations |
| `__tests__/` or `*.test.ts` | No test files anywhere; no test runner configured |

---

## Root-Level Notable Files

| File/Dir | Notes |
|----------|-------|
| `railway.toml` | Railway.app deployment config |
| `Dockerfile` | Container deployment (alternate path) |
| `firebase-applet-config.json` | Firebase client config committed to repo |
| `requirements.txt` | Python dependencies for engines |
| `policy.yaml`, `policy_general.yaml`, `policy_project.yaml` | AI content policy configs |
| `metro_engine_v3.py` (root) | Duplicate of `src/scripts/metro_engine_v3.py` at root |
| `rife/` | RIFE NCNN Vulkan binary for frame interpolation |
| `piper/` | Piper TTS binary and voice models |
| `music/` | Background music assets |
| `outputs/` | Rendered video output directory |
| `assets/characters/` | Pre-built character PNG assets |
