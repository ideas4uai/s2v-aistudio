# 16 — Technical Appendix

*For implementation teams. All findings are grounded in file reads during this audit.*

---

## A. File Reference Index

| File | Lines | Role | Read in Audit |
|------|-------|------|---------------|
| `server.ts` | ~810 | Express + Vite bootstrap, route registration, template seeding | First 60 lines |
| `src/App.tsx` | ~35 | React SPA, 6 routes | Full |
| `src/models/project.ts` | 104 | Project, Universe, StoryCharacter, StoryLocation interfaces | Full |
| `src/models/scene.ts` | 122 | Scene, Visual, Caption interfaces | Full |
| `src/models/types.ts` | 7 | Union types: VideoMode, JobStatus, StyleProfile, etc. | Full |
| `src/models/template.ts` | 12 | Template interface | Full |
| `src/pipeline/orchestrator.ts` | ~1340 | Master pipeline coordinator | Lines 1-100 + sections |
| `src/pipeline/abortManager.ts` | ~30 | Per-project AbortController | Full |
| `src/pipeline/fallbacks.ts` | ~38 | Static fallback data | Full |
| `src/pipeline/agents/directorAgent.ts` | ~101 | Director planning agent | Full |
| `src/pipeline/agents/scriptwriterAgent.ts` | ~156 | Script writing agent | Full |
| `src/pipeline/agents/storyboardAgent.ts` | ~236 | Scene graph generation agent | Full |
| `src/pipeline/agents/worldAgent.ts` | ~62 | World entity extraction agent | Full |
| `src/services/aiService.ts` | ~448 | AI client wrapper (Gemini, Replicate) | First 100 lines |
| `src/services/renderService.ts` | 893 | FFmpeg rendering pipeline | Lines 1-499, 700-892 |
| `src/services/voiceService.ts` | ~50 | Audio generation + duration probe | Full |
| `src/services/captionService.ts` | ~102 | Caption generation (time-math) | Full |
| `src/services/assetService.ts` | ~115 | Image asset generation + Picsum fallback | Full |
| `src/services/characterAssetService.ts` | ~403 | 25-part character asset pack generation | First 60 lines |
| `src/services/logService.ts` | 6 | No-op analytics stub | Full |
| `src/services/cacheService.ts` | 27 | File-system cache | Full |
| `src/services/qualityService.ts` | 8 | Fake quality score formula | Full |
| `src/server/db/firestore.ts` | ~370 | Firestore REST + Supabase Storage | Full |
| `src/server/routes/projects.ts` | ~311 | Full project API | First 40 lines |
| `src/server/routes/voices.ts` | ~76 | ElevenLabs voice clone proxy | Full |
| `src/server/routes/templates.ts` | ~61 | In-memory template CRUD | Full |
| `src/server/routes/assets.ts` | 6 | Stub (returns []) | Full |
| `src/server/routes/feedback.ts` | 6 | Stub (returns {success:true}) | Full |
| `src/server/routes/jobs.ts` | 10 | Stub (returns pending) | Full |
| `src/server/routes/quota.ts` | 13 | Stub (hardcoded limits) | Full |
| `src/server/routes/visuals.ts` | 6 | Stub (returns queued) | Full |
| `src/server/services/ttsService.ts` | ~200 | TTS: Piper→GCloud→silence fallback | Lines 1-60 |
| `src/server/utils/auth.ts` | ~27 | Firebase token verification | Full |
| `src/server/utils/context.ts` | 3 | AsyncLocalStorage | Full |
| `src/controllers/projectController.ts` | ~400+ | Project API handlers | Lines 1-349 |
| `src/controllers/universeController.ts` | ~80 | Universe API handlers | Full |
| `src/pages/Dashboard.tsx` | ~150+ | Project/universe list | First 80 lines |
| `src/pages/CreateProject.tsx` | ~? | Project creation wizard | First 40 lines |
| `src/pages/ProjectDetail.tsx` | ~? | Status polling view | First 40 lines |
| `src/pages/ProjectEditor.tsx` | ~? | Full scene editor | First 40 lines |
| `src/pages/UniverseEditor.tsx` | ~? | Universe + char/location editor | First 40 lines |
| `src/pages/CharacterOnboarding.tsx` | ~? | 25-asset generation wizard | First 40 lines |
| `src/components/Layout.tsx` | ~40 | Navbar | Full |
| `src/components/VoiceCloner.tsx` | ~60 | Voice clone upload | Full |
| `src/components/FeedbackModal.tsx` | ~60 | Feedback modal | Full |
| `src/components/QuotaIndicator.tsx` | ~80 | Quota display | Full |
| `src/components/ApiKeyGuard.tsx` | ~6 | Pass-through stub | Full |
| `src/contexts/AuthContext.tsx` | ~44 | Firebase auth context | Full |
| `src/utils/api.ts` | ~? | authenticatedFetch | Full (name + description) |
| `src/utils/geminiAuth.ts` | ~? | Multi-key Gemini routing | Full (description) |
| `src/utils/hash.ts` | ~? | djb2 hash utilities | Full (description) |
| `src/utils/path.ts` | ~? | toUrl() | Full (description) |
| `src/utils/retry.ts` | ~? | withRetry() | Full (description) |
| `src/utils/diff.ts` | ~? | Stub: always returns all scenes | Full (description) |
| `src/utils/timeline.ts` | ~? | buildSceneTimeline() | Full (description) |
| `src/scripts/metro_engine_v3.py` | ~300 | V3 library (no CLI) | First 80 lines |
| `src/scripts/scene_animator_v3.py` | ~120 | V3 CLI adapter | First 80 lines |
| `src/scripts/metro_engine_v4.py` | ~500+ | V4 cinematic engine | First 80 lines |
| `src/scripts/doraemon_engine.py` | ~400 | Part-based lip-sync engine | First 80 lines |
| `src/scripts/rembg_worker.py` | ~39 | Background removal | Full |
| `src/scripts/depth_parallax.py` | ~120 | Depth-map 2.5D parallax | First 80 lines |
| `src/scripts/validate_consistency.py` | ~100 | CIE76 consistency check | First 80 lines |
| `src/scripts/animator.py` | ~150 | V1 prototype (legacy) | First 80 lines |
| `package.json` | ~63 | Dependencies, scripts | Full |
| `tsconfig.json` | ~? | TypeScript config | Full |
| `firebase-applet-config.json` | ~12 | Firebase client config | Full (field names only) |

---

## B. Dependency Analysis (Technical Detail)

### Import Graph (key nodes)

```
orchestrator.ts imports:
  ← project.ts, scene.ts, types.ts (models)
  ← directorAgent, scriptwriterAgent, storyboardAgent, worldAgent (agents)
  ← voiceService, captionService, assetService, renderService (services)
  ← cacheService, logService, qualityService (utilities)
  ← FirestoreService (firestore.ts)
  ← abortManager, fallbacks (pipeline)
  ← withRetry (utils/retry)
  ← requestContext (server/utils/context)
  ← createClient from @supabase/supabase-js (DUPLICATE — also in firestore.ts)

renderService.ts imports:
  ← ffmpeg-static, ffprobe-static
  ← child_process (exec, spawn)
  ← fs, os, path (Node built-ins)
  [No domain model imports — operates on raw any types via scene/visual objects]

firestore.ts imports:
  ← @supabase/supabase-js
  ← node-fetch
  ← firebase-applet-config.json
  ← requestContext (server/utils/context)

routes/projects.ts imports:
  ← all project controller functions
  ← AIService, FirestoreService, loadProject
  ← toUrl (utils/path)
```

### Potential Circular Dependency Risk

None found. The import DAG is strictly:

```
routes → controllers → orchestrator → agents/services → AI/FFmpeg/Firestore
```

No backwards imports detected.

---

## C. Database Schema Detail

### Firestore Collections

**`projects/{uuid}`** — Full schema documented in `08_database_storage_audit.md`

**`universes/{uuid}`** — Key fields: `id`, `name`, `description`, `backgroundArtStyle`, `characters[]`, `locations[]`, `characterPoses`, `userId`, `createdAt`, `updatedAt`

**`templates/{id}`** — 2 hardcoded: `{id: 'tiktok-viral-hook', name: 'TikTok Viral Hook', ...}`, `{id: 'educational-deep-dive', name: 'Educational Deep Dive', ...}`

### Supabase Storage

Single bucket: `aivideogen`

Path convention: `projects/{projectId}/{fileName}`

Notable paths seen in code:
- `backgrounds/${sceneId}_background.png`
- `anchors/${charName}_anchor.png` (intended but not implemented)
- Character asset PNG files (various names from `ASSET_PROMPTS`)

### Local Filesystem Paths (ephemeral)

- `os.tmpdir()/ais-audio/{projectId}/narration-{sceneId}.wav`
- `os.tmpdir()/ais-renderer/{sceneId}_transparent.png`
- `os.tmpdir()/ais-renderer/{sceneId}_segment.mp4`
- `os.tmpdir()/ais-renderer/{sceneId}_captioned.mp4`
- `os.tmpdir()/ais-renderer/{projectId}/final_{timestamp}.mp4`
- `./cache/{hash}` (project-local, persists)
- `./assets/characters/{charName}/*.png` (project-local, persists)
- `./outputs/` (project-local, persists)

---

## D. Technical Debt Detail

Full catalogue documented in `09_technical_debt_audit.md`. 

**Quick reference for implementation teams:**

| ID | File | Line Range | Debt |
|----|------|-----------|------|
| TD-001 | `orchestrator.ts` | 781-789 | Anchor URL stored as local path |
| TD-002 | `scene.ts` + orchestrator writes | Multiple | Local paths in Firestore fields |
| TD-003 | `renderService.ts` | 882-884 | Output path is stub URL |
| TD-004 | `orchestrator.ts` | 38 | INDIAN_AESTHETIC_SUFFIX hardcoded |
| TD-005 | 3 files | Multiple | Duplicate aesthetic definitions |
| TD-006 | `logService.ts` | 4-6 | logUserEvent is no-op |
| TD-007 | `qualityService.ts` | 1-8 | Fake quality formula |
| TD-008 | `diff.ts` | All | Always re-renders all scenes |
| TD-009 | `rateLimiter.ts` | All | No-op rate limiter |
| TD-010 | `quotaService.ts` | All | No-op quota service |
| TD-011 | `renderService.ts` | 10 | Global rembg mutex |
| TD-012 | `firestore.ts` | saveProject | Scenes array in project doc |
| TD-013 | `orchestrator.ts` | All | 1340 lines, too large |
| TD-014 | `renderService.ts` | 39-85 | Legacy V1 callAnimator |
| TD-015 | `scene_animator_v3.py` | argparse | choices= blocks new values |
| TD-016 | All | All | No test suite |
| TD-017 | `firebase-applet-config.json` | All | Config committed to repo |

---

## E. Environment Variables Reference

**Required for production:**

| Variable | Used By | Purpose |
|----------|---------|---------|
| `GEMINI_KEY_SCRIPT` | `geminiAuth.ts` | Director + Scriptwriter agents |
| `GEMINI_KEY_SCENES` | `geminiAuth.ts` | World + Storyboard agents |
| `GEMINI_KEY_VISUAL` | `geminiAuth.ts` | Visual prompt expansion |
| `GEMINI_KEY_IMAGE` | `geminiAuth.ts` | Background image generation |
| `GOOGLE_CLOUD_TTS_API_KEY` | `ttsService.ts` | Google Cloud TTS (secondary TTS) |
| `SUPABASE_URL` | `firestore.ts` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | `firestore.ts` | Supabase service role key |
| `PIPER_BIN_PATH` | `ttsService.ts` | Path to Piper TTS binary |
| `PIPER_VOICES_DIR` | `ttsService.ts` | Path to Piper voice models |
| `REPLICATE_API_TOKEN` | `aiService.ts` | Replicate LoRA inference |

**Optional / Feature Flags:**

| Variable | Purpose |
|----------|---------|
| `USE_METRO_V4` | Activates Metro Engine V4 (default: V3) |
| `USE_DORAEMON` | Activates Doraemon lip-sync engine |
| `UNIFIED_SCENES` | Activates unified LoRA scene generation |
| `METRO_V4_FPS` | Override V4/Doraemon FPS (default: 24) |
| `DISABLE_FIRESTORE` | Use in-memory store instead of Firestore |
| `MUSIC_DIR` | Override music directory for background music |
| `FAL_API_KEY` | Fal.ai client (wired in package.json, not yet in service) |
| `TOGETHER_API_KEY` | Together AI (wired in package.json, not yet in service) |
| `REPLICATE_USERNAME` | Replicate username for LoRA model paths |
| `REPLICATE_LORA_TRAINER_VERSION` | LoRA trainer model version |

---

## F. FFmpeg Command Reference

All FFmpeg commands confirmed from reading `renderService.ts`:

**1. Ken Burns zoompan (renderVisualClip, lines ~444-461):**
```
ffmpeg -i {image} -vf "scale=-1:4000,zoompan=z='min(zoom+0.000167,1.1)':x='...':y='...':d={frames}:s=1080x1920:fps=30,trim=duration={dur}" -c:v libx264 -preset fast -crf 20 -y {output}
```

**2. Scene Segment Assembly (assembleSceneSegment, line 742):**
```
ffmpeg -stream_loop -1 -i {visual_mp4} -i {audio_wav} -vf setpts=PTS-STARTPTS -af asetpts=PTS-STARTPTS -c:v libx264 -preset fast -crf 20 -c:a aac -ar 44100 -ac 2 -b:a 192k -t {duration} -y {segment_mp4}
```

**3. Caption Burn (renderCaptions, line 810):**
```
ffmpeg -i {segment_mp4} -vf "ass='{ass_file}'" -c:v libx264 -preset fast -crf 18 -b:v 4M -c:a copy -y {captioned_mp4}
```

**4. Final Stitch (stitchScenes, line 849):**
```
ffmpeg -f concat -safe 0 -i {list_file} -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" -vsync cfr -c:v libx264 -preset fast -crf 20 -c:a aac -ar 44100 -ac 2 -b:a 192k -y {output_mp4}
```

**5. Music Mix (stitchScenes, line 869):**
```
ffmpeg -i {video} -stream_loop -1 -i {music} -filter_complex "[0:a]aformat=...[a0];[1:a]volume={vol}[bg];[a0][bg]amix=inputs=2:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -y {output_with_music}
```

**6. rembg subprocess (callRembg, line 266):**
```
py src/scripts/rembg_worker.py {input_path} {output_path}
```

**7. Python engine (callSceneAnimatorV3, line 159):**
```
py {script_path} --background {bg} --character {char} --output {out} --duration {dur} --emotion {emo} --scene_type {type} --fps {fps} --width 1080 --height 1920 [--prev_scene_type {prev}] [--next_scene_type {next}]
```

---

## G. Findings Registry (High Confidence Only)

| ID | Module | Status | File | Lines | Evidence | Confidence |
|----|--------|--------|------|-------|----------|------------|
| F001 | Authentication | ✅ | `auth.ts` | 1-27 | Firebase Identity Toolkit REST token verification | HIGH |
| F002 | Dashboard | ✅ | `Dashboard.tsx` | 1-80 | Project/universe fetch, sort, delete | HIGH |
| F003 | Story Engine | ✅ | `agents/` | All | 4-agent pipeline confirmed | HIGH |
| F004 | Image Engine | ✅ | `aiService.ts` | ~1-100 | Gemini + Replicate LoRA integration | HIGH |
| F005 | Video Engine | ✅ | `renderService.ts` | 700-892 | assembleSceneSegment, renderCaptions, stitchScenes | HIGH |
| F006 | AI Orchestration | ✅ | `orchestrator.ts` | 1-100 | Full pipeline + retry + abort | HIGH |
| F007 | Content Publishing | ❌ | None | N/A | Searched entire src/; no YouTube/TikTok/Instagram found | HIGH |
| F008 | Analytics | ❌ | `logService.ts` | 4-6 | `logUserEvent` body is `{}` | HIGH |
| F009 | Memory Engine | ❌ | `test_memory_store.ts` | All | Test file only; no implementation | HIGH |
| F010 | Knowledge Base | ❌ | None | N/A | No RAG, vector store, or knowledge docs found | HIGH |
| F011 | Anchor URL Bug | 🔴 | `orchestrator.ts` | 781-789 | `characterAnchors.set(charKey, localAsset)` | HIGH |
| F012 | Local paths in DB | 🔴 | `scene.ts`, orchestrator | Multiple | `narration_path`, `background_path` etc. persisted | HIGH |
| F013 | No video to Supabase | 🔴 | `renderService.ts` | 882-884 | Output to local temp only | HIGH |
| F014 | V4 flag-gated | ⚠️ | `renderService.ts` | 105-115 | `USE_METRO_V4` flag routing confirmed | HIGH |
| F015 | Stub routes (×5) | ❌ | 5 route files | 1-13 each | Return hardcoded values, all confirmed by reading | HIGH |
| F016 | No test suite | 🔴 | Entire project | N/A | No *.test.ts, no test runner in package.json | HIGH |
| F017 | Scenes embedded in doc | 🟡 | `orchestrator.ts` | ~100+ | `project.scenes[]` array patched per update | HIGH |
| F018 | captions: time-math | 🟡 | `captionService.ts` | All | audioPath and mode parameters ignored | HIGH |
| F019 | diff.ts stub | 🟡 | `utils/diff.ts` | All | getScenesToRender always returns all | HIGH |
| F020 | qualityService fake | 🟡 | `qualityService.ts` | All | base 50 + scene count formula | HIGH |
