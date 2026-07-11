# 04 — Dependency Analysis

## Service Dependency Graph (Text Form)

```
┌─────────────────────────────────────────────────────────┐
│                    CLIENT LAYER                         │
│  App.tsx → AuthContext → Firebase Auth (Google)         │
│  App.tsx → QuotaContext → /api/quota (stub)             │
│  Pages → authenticatedFetch() → Firebase idToken        │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP + Bearer token
┌────────────────────────▼────────────────────────────────┐
│                   TRANSPORT LAYER                       │
│  Express routes (server.ts)                             │
│  verifyIdToken() → Firebase Identity Toolkit REST       │
│  requestContext (AsyncLocalStorage) → token propagation │
└────────────────────────┬────────────────────────────────┘
                         │ internal function calls
┌────────────────────────▼────────────────────────────────┐
│               CONTROLLER LAYER                          │
│  projectController.ts ──────────────────────────────┐  │
│  universeController.ts ─────────────────────────┐   │  │
└──────────────────────────────────────────────────│───│──┘
                                                   │   │
         ┌─────────────────────────────────────────┘   │
         │ Firestore REST                               │ Orchestrator
         ▼                                             ▼
┌─────────────────┐        ┌──────────────────────────────────────────┐
│ FirestoreService│        │          ORCHESTRATOR                    │
│ (firestore.ts)  │        │       (orchestrator.ts, 1340 lines)      │
│                 │        │                                          │
│ Firestore REST  │◄───────│ loadProject / saveProjectState           │
│ (Firestore API) │        │ runPipeline / runScenePipeline           │
│                 │        │ characterHasPortraitAssets               │
│ Supabase Storage│        │ applyStyleToPrompt                       │
│ (uploadAsset)   │        │ INDIAN_AESTHETIC_SUFFIX                  │
└─────────────────┘        └──────────┬───────────────────────────────┘
                                      │ calls sequentially
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
┌─────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│   AGENT LAYER       │  │   SERVICE LAYER       │  │   RENDER LAYER       │
│                     │  │                       │  │                      │
│ DirectorAgent       │  │ voiceService          │  │ renderService        │
│  → AIService.text   │  │  → ttsService         │  │  → callAnimator (V1) │
│                     │  │    → Piper binary     │  │  → callSceneAnim V3  │
│ ScriptwriterAgent   │  │    → GCloud TTS       │  │    → scene_anim_v3   │
│  → AIService.text   │  │    → ffmpeg silence   │  │  → callSceneAnim V4  │
│                     │  │  → ffprobe duration   │  │    → metro_engine_v4 │
│ StoryboardAgent     │  │  → cacheService       │  │  → callSceneAnim     │
│  → AIService.text   │  │                       │  │    (Doraemon)        │
│                     │  │ captionService        │  │    → doraemon_engine │
│ WorldAgent          │  │  (time-math; no ASR)  │  │  → callRembg         │
│  → AIService.text   │  │                       │  │    → rembg_worker.py │
│                     │  │ assetService          │  │                      │
└─────────────────────┘  │  → AIService.img      │  │ assembleSceneSegment │
                         │  → Picsum fallback    │  │  → ffmpeg (loop+mux) │
┌─────────────────────┐  │                       │  │                      │
│   AI SERVICE        │  │ qualityService (stub) │  │ renderCaptions       │
│  (aiService.ts)     │  │ logService (stub)     │  │  → ffmpeg ASS burn   │
│                     │  │ cacheService          │  │                      │
│ Gemini 2.5 Flash    │  │  (file-system KV)     │  │ stitchScenes         │
│ (text + images)     │  └──────────────────────┘  │  → ffmpeg concat      │
│                     │                             │  → music mix          │
│ Replicate (LoRA)    │                             └──────────────────────┘
│ @fal-ai (wired)     │
│ together-ai (wired) │
└─────────────────────┘
```

---

## Upstream Dependencies (External)

| Service | Provider | How Used | Risk |
|---------|----------|----------|------|
| Gemini 2.5 Flash | Google AI | Text generation (all agents) + image generation | HIGH — central to all pipeline stages |
| Gemini 2.5 Flash-Image | Google AI | Background image generation | HIGH |
| Replicate | Replicate.com | LoRA fine-tuned character image generation | MEDIUM — UoN only |
| ElevenLabs | ElevenLabs API | Voice cloning | MEDIUM |
| Firebase Auth | Google/Firebase | User authentication | MEDIUM |
| Firebase Firestore | Google/Firebase | Document storage (projects, universes) | MEDIUM |
| Supabase Storage | Supabase | File/asset blob storage | MEDIUM |
| Piper TTS | Local binary | Primary TTS | LOW — local fallback |
| Google Cloud TTS | Google Cloud | Secondary TTS | MEDIUM |
| ffmpeg-static | npm pkg | All video processing | HIGH — every render |
| ffprobe-static | npm pkg | Duration probing | MEDIUM |
| Fal.ai | Fal.ai | Available but not actively used in main pipeline | LOW |
| Together AI | Together AI | Available but not actively used in main pipeline | LOW |

---

## Shared Services (Used by Multiple Callers)

| Service | Called By |
|---------|-----------|
| `AIService` | `DirectorAgent`, `ScriptwriterAgent`, `StoryboardAgent`, `WorldAgent`, `assetService`, `projectController` |
| `FirestoreService` | `orchestrator`, `universeController`, `projectController`, `characterAssetService` |
| `requestContext` | `orchestrator`, `firestore.ts`, `projectController`, `universeController` |
| `withRetry` | `orchestrator` (all AI calls) |
| `abortManager` | `orchestrator`, `renderService` |
| `ffmpeg-static` | `renderService`, `ttsService`, `assembleSceneSegment`, `stitchScenes` |

---

## Circular Dependencies

| Finding | Evidence | Risk |
|---------|----------|------|
| None detected | Each layer imports only from layers below | LOW |

Flow is strictly one-directional: Routes → Controllers → Orchestrator → Agents/Services → DB.

---

## Tight Coupling Points

| Coupling | Files | Impact |
|----------|-------|--------|
| `INDIAN_AESTHETIC_SUFFIX` hardcoded in orchestrator | `orchestrator.ts:38` | Contaminates generic pipeline; not injectable |
| `STYLE_BASE` in characterAssetService | `characterAssetService.ts` (early lines) | Duplicate aesthetic definition |
| `SPEAKER_PATTERNS` for Byte/Nova/Veer in storyboardAgent | `storyboardAgent.ts` | Universe-specific logic in generic agent |
| Supabase client created inline in orchestrator | `orchestrator.ts:29-31` | Second client instance alongside `firestore.ts` singleton |
| Python engine spawned with `'py'` hardcoded | `renderService.ts:159` | Windows-only; `python3` used in V1 path, `py` in V3/V4 |
| `requestContext` must be seeded before any Firestore call | All callers | Invisible invariant; breaks on new entry points |

---

## Safe Extension Points

| Extension Point | Where | How to Extend |
|----------------|-------|---------------|
| New AI agent | `src/pipeline/agents/` | Add new `Agent.ts`; import in orchestrator |
| New Python engine | `src/scripts/` | Add new `.py`; add env flag + branch in `callSceneAnimatorV3` |
| New AI provider | `aiService.ts` | Add new method; route by task in `TASK_MODELS` |
| New API route | `src/server/routes/` + `server.ts` | Add router file; register in `server.ts` |
| New universe style preset | `UniverseEditor.tsx` | Extend `STYLE_PRESETS` array |
| New scene emotion | `orchestrator.ts` + `storyboardAgent.ts` | Add to `CameraPath` map in V4; no `choices=` constraint in V4 |

---

## High-Risk Modules

| Module | Risk | Reason |
|--------|------|--------|
| `orchestrator.ts` (1340 lines) | HIGH | All business logic coupled together; single point of failure |
| `renderService.ts` (893 lines) | MEDIUM | Complex FFmpeg orchestration; any ffmpeg version issue breaks all renders |
| `aiService.ts` (448 lines) | MEDIUM | Multi-provider; Gemini API changes would break text + image generation |
| `firestore.ts` (400 lines) | MEDIUM | Hand-rolled Firestore REST client; Firestore wire format changes would break persistence |

## Low-Risk Extension Modules

| Module | Why Low Risk |
|--------|-------------|
| `abortManager.ts` | 30 lines, clean interface, no external deps |
| Pipeline agents (4 files) | Stateless, thin wrappers around AIService.generateText |
| `hash.ts`, `path.ts`, `retry.ts` | Pure utilities, no side effects |
| Python engines (V3/V4/Doraemon) | Flag-gated; V3 is stable fallback |
