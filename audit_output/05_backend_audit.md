# 05 — Backend Audit

## Services Layer

### AIService (`src/services/aiService.ts`, ~448 lines)

**What exists:**
- Static class with `generateText(prompt, options)` and `generateImageBase64(prompt, options)` methods
- Supports both API-key mode and GCP Application Default Credentials (ADC) for Vertex AI via `GOOGLE_CLOUD_PROJECT` env var
- Per-task model routing via `TASK_MODELS` object (all tasks → `gemini-2.5-flash`; image → `gemini-2.5-flash-image`)
- Gemini multi-key routing via `getKeyForTask()` / `getGeminiKey()` from `geminiAuth.ts` (4 separate keys for `script`, `scenes`, `visual`, `image`)
- Replicate LoRA inference via direct REST calls to `https://api.replicate.com/v1/`
- Hardcoded LoRA negative prompt: "orange hair, blonde, white hair, pale skin, blue eyes, European, Japanese, Korean features"

**Partial / gaps:**
- `@fal-ai/client` and `together-ai` are in `package.json` but not wired into `aiService.ts` — available but unused
- No provider fallback chain: if Gemini image generation fails, no automatic retry on alternate provider
- LoRA polling uses a manual sleep loop (no webhook support)

**Reuse note:** Reusable as-is. Extension: add Fal.ai and Together AI as image generation fallbacks.

---

### RenderService (`src/services/renderService.ts`, 893 lines)

**What exists:**
- `guardedExec(command, signal?)` — AbortSignal-aware `exec` wrapper (lines 15-37)
- `callAnimator(config)` — legacy V1 Python animator via config JSON file (lines 39-85)
- `callSceneAnimatorV3(...)` — routes to V3/V4/Doraemon engine based on env flags (lines 87-182)
  - `USE_METRO_V4=true` → `metro_engine_v4.py`
  - `USE_DORAEMON=true && render_mode==='cutout'` → `doraemon_engine.py`
  - Default → `scene_animator_v3.py`
  - V4 transition type filter: only `['street','black','grid','bedroom']` get non-empty `--prev_scene_type`
- `compositeCharacterOverBackground(...)` — FFmpeg overlay of character PNG on background (lines 184-230)
- `callRembg(inputPath, outputPath)` — serialized rembg subprocess; module-level mutex (`rembgRunning`) prevents concurrent runs (lines 255-294)
- `renderVisualClip(visual, project, signal, scene, audioDuration)` — main scene render function (lines 349-700):
  - Handles multi-frame visuals, Ken Burns zoompan, 4K/preview resolution switching
  - Stage 2: rembg → V3/V4 compositor, or Ken Burns fallback
  - NARRATOR scene detection: skips character animation, uses image as full background
  - Doraemon cutout detection: skips rembg, uses parts directory
- `assembleSceneSegment(scene, audioPath, cacheKey, signal)` (lines 702-749):
  - FFmpeg: `stream_loop -1` + `setpts=PTS-STARTPTS` → `_segment.mp4`
  - Probes actual audio duration via ffprobe for sync accuracy
- `renderCaptions(scene, signal)` (lines 751-818):
  - Generates ASS subtitle file with 3-word-max chunks
  - Style: `Arial 34pt, white bold, 3px black outline, bottom-center`
  - FFmpeg burns ASS → `_captioned.mp4`
- `stitchScenes(scenes, project, signal)` (lines 820-892):
  - FFmpeg `concat demuxer` (no `-fflags +genpts`) + `-vsync cfr` → final MP4
  - Optional background music mix at configurable volume (default 0.08)
  - `project.output_path` set to `/api/assets/download?path=...` (note: stub endpoint)

**Partial / gaps:**
- Legacy V1 `callAnimator` still present; dead code for most scenes
- `rembgRunning` mutex is a module-level boolean — not safe under concurrent requests from multiple users
- Output path uses `/api/assets/download` which is a stub (unimplemented)
- No progress events emitted during render

**Reuse note:** Reusable as-is. Extend: add SSE/WebSocket progress events; replace global mutex with per-project queue.

---

### VoiceService (`src/services/voiceService.ts`, ~50 lines)

**What exists:**
- `generateSceneAudio(scene, preset, hash, projectSettings?)` — delegates to `ttsService.generateNarration()`
- Probes output duration via ffprobe; attaches `scene.duration_actual` and `scene.narration_path`
- Fallback duration = file size / 3000 bytes per second when ffprobe fails
- Sets `scene.fallback_used = true` when audio path contains `-silence.wav`

**Reuse note:** Fully reusable.

---

### TTS Service (`src/server/services/ttsService.ts`, ~200 lines)

**What exists:**
- Triple fallback chain: Piper TTS → Google Cloud TTS → ffmpeg silent WAV → raw WAV bytes
- `estimateDurationSec(text, hintSec?)` — 2.5 words/second formula; minimum 3 seconds
- `generateNarration(text, sceneId, projectId, settings?, durationSec?)` — main entry point
- Reads `PIPER_BIN_PATH`, `PIPER_VOICES_DIR` env vars for local Piper binary
- Reads `GOOGLE_CLOUD_TTS_API_KEY` for Google Cloud TTS
- Audio stored in `%TEMP%/ais-audio/{projectId}/narration-{sceneId}.wav`

**Gaps:** No voice selection UI beyond what's set in project settings; no voice preview.

**Reuse note:** Fully reusable.

---

### Caption Service (`src/services/captionService.ts`, ~102 lines)

**What exists:**
- `generateCaptions(scene, audioPath, mode)` — time-math caption generation
- Evenly spaces caption chunks across `scene.duration_actual || scene.duration_target`
- Alternates ASS colour tags on even/odd blocks (white + yellow)
- `audioPath` and `mode` parameters accepted but not used

**Gap:** No ASR/Whisper integration — all timing is artificial, causing mechanical caption feel.

---

### AssetService (`src/services/assetService.ts`, ~115 lines)

**What exists:**
- `generateAsset(scene, project)` — calls `AIService.generateImageBase64()` with style-injected prompt
- Picsum Photos fallback: `https://picsum.photos/seed/${seed}/1080/1920` when AI fails
- Image written to local `./cache/` directory; hashed by prompt for reuse

**Gap:** Picsum fallback is deterministic but produces stock photos — visible in production output when Gemini fails. No image approval workflow.

---

### CharacterAssetService (`src/services/characterAssetService.ts`, ~403 lines)

**What exists:**
- `ASSET_PROMPTS` — 25 named asset prompts (4 body poses, 6 mouth, 4 eye, 3 brow, 8 emotion full-body)
- `STYLE_BASE` — "South Asian graphic novel flat colour illustration style" hardcoded
- `generateAssetPack(characterId, name, reference?, style?)` — generates all 25 assets
- `validate_consistency.py` called via `spawnSync` for CIE76 skin-tone consistency check per asset
- Results uploaded to Supabase via `FirestoreService.uploadAsset()`
- Returns `AssetPackResult` with per-asset status and `deltaE` consistency scores

**Gap:** Consistency validator called here, but not integrated into the main orchestrator pipeline for episode renders.

---

## API / Routes Layer

### `routes/projects.ts` (311 lines)

The only fully-implemented project API file. Key routes confirmed by reading:
- `GET /test_ai` — live Gemini connectivity smoke test
- `POST /` — create project
- `GET /:id` — get project
- `POST /:id/script` → `generateScript`
- `POST /:id/scenes` → `generateScenes`
- `POST /:id/audio` → `generateAudio`
- `POST /:id/images` → `generateImages`
- `POST /:id/render` → `renderProject`
- `POST /:id/cancel` → `cancelProject`
- `POST /:id/reset` → `resetProject`

**Gaps:**
- No streaming/SSE endpoint for render progress
- No `GET /:id/scenes/:sceneId` endpoint for per-scene operations
- Scene-level retry is done by calling full pipeline endpoints

### Stub Routes (confirmed by reading source)

| Route | File | Status |
|-------|------|--------|
| `GET /api/assets` | `assets.ts:1-6` | Returns `[]` always |
| `POST /api/feedback` | `feedback.ts:1-6` | Returns `{success:true}` always |
| `GET /api/jobs`, `GET /api/jobs/:id` | `jobs.ts:1-10` | Returns `[]` / `{id, status:'pending'}` always |
| `GET /api/quota` | `quota.ts:1-13` | Returns hardcoded `{aiImagesLimit:10, audioLimit:10, resetsIn:'24h'}` |
| `POST /api/visuals/generate` | `visuals.ts:1-6` | Returns `{status:'queued'}` always |

---

## Database Access (`src/server/db/firestore.ts`, ~370 lines)

### Firestore Operations

| Method | HTTP Method | Path Pattern | Used By |
|--------|------------|--------------|---------|
| `saveProject(project)` | PATCH | `projects/{id}` | orchestrator |
| `getProject(id)` | GET | `projects/{id}` | orchestrator |
| `getProjects(userId)` | POST (runQuery) | `projects` | projectController |
| `deleteProject(id)` | DELETE | `projects/{id}` | projectController |
| `saveDocument(collection, id, data)` | PATCH | `{collection}/{id}` | universeController, seeds |
| `getDocument(collection, id)` | GET | `{collection}/{id}` | universeController |
| `listDocuments(collection, userId)` | POST (runQuery) | `{collection}` | universeController, Dashboard |
| `deleteDocument(collection, id)` | DELETE | `{collection}/{id}` | universeController |

### Supabase Storage Operations

| Method | Bucket | Path Pattern | Used By |
|--------|--------|-------------|---------|
| `uploadAsset(projectId, fileName, data, contentType)` | `aivideogen` | `projects/{id}/{fileName}` | orchestrator, characterAssetService |
| `deleteAssetByUrl(urlStr)` | `aivideogen` | extracted from public URL | orchestrator (cleanup) |

**Notable: `fdb` export is a mock stub** — `fdb.collection().doc().set()` logs a warning and does nothing. Only `FirestoreService` methods make real API calls.

---

## Auth & Session Handling

### Authentication Flow (confirmed)

```
Frontend: Firebase Google Sign-In → idToken (JWT)
  ↓
authenticatedFetch() in src/utils/api.ts
  → Authorization: Bearer {idToken}
  ↓
Express middleware in server.ts
  → verifyIdToken(token) in src/server/utils/auth.ts
  → Firebase Identity Toolkit REST: identitytoolkit/v3/.../getAccountInfo
  → Returns { localId: uid }
  ↓
requestContext.run({ token }, handler)
  → AsyncLocalStorage propagates token to all downstream calls
  ↓
FirestoreService.withAuth(url, token)
  → If token === '__dev__': appends ?key={apiKey} (dev bypass)
  → Else: Authorization: Bearer header
```

**Gap:** No role-based access. Any authenticated user can access any project by ID (no ownership check beyond `userId` filter in list queries). No multi-tenant isolation.

---

## Orchestration (`src/pipeline/orchestrator.ts`, 1340 lines)

**Key design:**
- `runPipeline(project_id, opts)` — full pipeline trigger
- `runScenePipeline(project_id, scene_id, opts)` — single scene re-render
- Stages executed sequentially per scene: audio → captions → background image → visual clip → segment assembly → caption burn
- `abortManager.getOrCreate(projectId)` creates per-pipeline abort signal
- All AI calls wrapped in `withRetry()` (3 retries, 2s base delay)
- After all scenes: `stitchScenes()` → final MP4 → `project.output_path` updated

**Known technical debt:**
- Lines 757-761: `INDIAN_AESTHETIC_SUFFIX` conditionally applied based on `project.universeId` (Fix 3 from prior session)
- Lines 654-659: prev/next scene type stamping for Metro V4 transitions
- Lines 781-789: Anchor URL bug — `characterAnchors.set(charKey, localAsset)` stores local temp path (anchor fix pending)
- `projectMemoryStore` (line 92): module-level Map — not shared across process restarts; not safe for multi-instance deploys

---

## Background Jobs / Queues

**No job queue exists.** Pipelines run synchronously in the Express request thread:
- `runPipeline()` is called with `runPipeline(id).catch(console.error)` (fire-and-forget after response sent)
- No Redis, Bull, BullMQ, or any queue library
- `jobs.ts` route returns stub data — no real job tracking

**Gap:** For production multi-user use, this is the highest-risk architectural gap. Long renders (5-15 minutes) block process resources with no queuing or backpressure.

---

## Storage Integration Summary

| Type | Provider | Bucket/DB | Path Format |
|------|----------|-----------|-------------|
| Project documents | Firestore | `(default)` | `projects/{uuid}` |
| Universe documents | Firestore | `(default)` | `universes/{uuid}` |
| Background images | Supabase | `aivideogen` | `projects/{id}/backgrounds/{name}.png` |
| Character assets | Supabase | `aivideogen` | `projects/{id}/{asset}.png` |
| Character anchors | Bug: local path | — | Should be `anchors/{name}_anchor.png` in Supabase |
| Audio | Local filesystem | `%TEMP%/ais-audio/` | `{projectId}/narration-{sceneId}.wav` |
| Video segments | Local filesystem | `%TEMP%/ais-renderer/` | `{sceneId}_segment.mp4` |
| Final output | Local filesystem | `./outputs/` | `{projectId}.mp4` |
| Output URL | Project field | — | `/api/assets/download?path=...` (stub endpoint) |
