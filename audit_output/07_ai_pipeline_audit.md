# 07 — AI Pipeline Audit

## Pipeline Overview

The AI pipeline is a sequential, per-project, synchronous processing chain coordinated by `src/pipeline/orchestrator.ts`. Every stage depends on the prior stage's output.

```
Stage 0: Topic + Project Settings
    ↓
Stage 1: Director Planning       [DirectorAgent → Gemini 2.5 Flash]
    ↓
Stage 2: Script Writing          [ScriptwriterAgent → Gemini 2.5 Flash]
    ↓
Stage 3: World Analysis          [WorldAgent → Gemini 2.5 Flash]
    ↓
Stage 4: Scene Graph Generation  [StoryboardAgent → Gemini 2.5 Flash]
    ↓
Per Scene (sequential):
  Stage A: Audio Generation      [ttsService → Piper/GCloud/silence]
  Stage B: Caption Generation    [captionService → time-math]
  Stage C: Background Image      [AIService → Gemini Flash-Image]
  Stage D: Character Image       [AIService → Gemini / Replicate LoRA]
  Stage E: Background Removal    [rembg_worker.py → u2net ONNX]
  Stage F: Visual Animation      [metro_engine_v4.py / scene_animator_v3.py]
  Stage G: Segment Assembly      [renderService → FFmpeg mux]
  Stage H: Caption Burn          [renderService → FFmpeg ASS]
    ↓
Stage 5: Final Stitch            [renderService → FFmpeg concat + re-encode]
    ↓
Stage 6: Music Mix (optional)   [renderService → FFmpeg amix]
```

---

## Stage 1: Director Planning

**Agent:** `src/pipeline/agents/directorAgent.ts` (101 lines)

**Inputs:** `project.topic`, `project.universe` (optional), `project.settings.targetLength`

**Outputs:** `DirectorPlan` object:
```typescript
{
  visual_style: string,
  color_palette: string,
  camera_language: string,
  pacing_notes: string,
  overall_mood: string,
  narrative_arc: string
}
```

**Model:** `gemini-2.5-flash` via `AIService.generateText(prompt, { task: 'planning' })`

**Notable:**
- Hardcoded scene-count lookup: `30s → 4-6`, `60s → 7-9`, `3m → 14-18`, `5m → 24-30`
- Builds `universeContext` block from `project.universe` for story episode mode
- Wrapped in `withRetry()` in orchestrator

**Gap:** Director plan not persisted to Firestore. If pipeline restarts mid-run, Director is re-called even if plan was already good.

---

## Stage 2: Script Writing

**Agent:** `src/pipeline/agents/scriptwriterAgent.ts` (156 lines)

**Inputs:** `project`, `DirectorPlan`, target word count (2.5 words/second × duration)

**Outputs:** `{ rawScript: string, wordCount: number, estimatedDuration: number }`

**Model:** `gemini-2.5-flash` via `AIService.generateText(prompt, { task: 'script' })`

**Notable:**
- Words-per-second rate hardcoded: 2.5
- Produces a structured script with narration blocks
- Also used for SEO metadata generation in `projectController.generateScript()`:
  - Title (60 chars max), description (150 words), 15 tags, thumbnail text
  - SEO is a bonus non-critical path in `projectController`, not in orchestrator

**Gap:** Script stored in `project.script`. On multi-stage resume (e.g., after a crash), the script stage is skipped if `project.script` already exists. No version tracking.

---

## Stage 3: World Analysis

**Agent:** `src/pipeline/agents/worldAgent.ts` (62 lines)

**Inputs:** `project`, raw script text

**Outputs:** `world_entities` — structured list of characters, locations, key objects

**Model:** `gemini-2.5-flash` via `AIService.generateText(prompt, { task: 'world' })`

**Usage:** World entities inform character detection in StoryboardAgent and provide context for universe continuity.

**Gap:** World entities stored in `project.world_entities` but not surfaced in the editor UI.

---

## Stage 4: Scene Graph Generation

**Agent:** `src/pipeline/agents/storyboardAgent.ts` (236 lines)

**Inputs:** Script, director plan, world entities, project (universe, characters)

**Outputs:** Array of `Scene` objects with:
- `narration_text`, `caption_text`
- `emotion` (detected from narration)
- `character` (detected via `SPEAKER_PATTERNS` matching)
- `background_prompt`, `scene_type`
- `visuals[]` with motion instruction
- `duration_target`

**Model:** `gemini-2.5-flash` via `AIService.generateText(prompt, { task: 'scenes' })`

**Notable:**
- `detectEmotion(text)` — keyword matching for `curious`, `tense`, `sad`, `empty`, `neutral`
- `detectCharacter(narration, chars)` — UoN speaker patterns hardcoded for `byte`, `nova`, `veer`
- `SHOT_TYPES`: 5 types (`establishing_wide`, `medium`, `close_up`, `reaction`, `cutaway`)

**Gap:** `SPEAKER_PATTERNS` for Byte/Nova/Veer are universe-specific logic in a generic agent file. Should be externalized to universe config.

---

## Stage A: Audio Generation

**Service:** `src/services/voiceService.ts` + `src/server/services/ttsService.ts`

**Inputs:** `scene.narration_text`, project voice settings, duration hint

**Outputs:** WAV file at `%TEMP%/ais-audio/{projectId}/narration-{sceneId}.wav`

**Providers (in priority order):**
1. **Piper TTS** — local binary at `PIPER_BIN_PATH`; fastest; quality depends on installed voice model
2. **Google Cloud TTS** — `GOOGLE_CLOUD_TTS_API_KEY`; higher quality
3. **ffmpeg silence** — `ffmpeg -f lavfi -i anullsrc` for estimated duration
4. **Raw WAV bytes** — last resort when ffmpeg fails

**Notable:**
- Duration probed via ffprobe after generation; attached to `scene.duration_actual`
- `estimateDurationSec()` formula: 2.5 words/sec (consistent with script stage)

**Gap:** No voice selection per character; all characters use same project voice settings. No ElevenLabs TTS integration (only voice cloning).

---

## Stage B: Caption Generation

**Service:** `src/services/captionService.ts` (~102 lines)

**Inputs:** `scene`, audio path (ignored), mode (ignored)

**Outputs:** `scene.caption_chunks[]` — array of `{text, start, end}` objects

**Method:** Time-math — divides `duration_actual` into equal chunks of 6 words max

**Gap:** No ASR/Whisper. Captions are always perfectly timed to the audio boundary but look mechanical because word timing is artificial. Industry standard for production quality is word-level Whisper alignment.

---

## Stage C: Background Image Generation

**Service:** `src/services/aiService.ts` via orchestrator

**Inputs:** `scene.background_prompt` + aesthetic suffix + universe `backgroundArtStyle`

**Outputs:** Background image at local path, URL in Supabase

**Provider:** Gemini 2.5 Flash-Image via `AIService.generateImageBase64(prompt, { isStoryEpisode })`

**Notable:**
- `INDIAN_AESTHETIC_SUFFIX` appended only when `project.universeId` is set (Fix 3, committed `aa15eef`)
- Generic pipeline uses: `'cinematic lighting, clean professional style, suitable for educational content, 16:9 composition adapted to portrait'`
- Uploaded to Supabase: `projects/{id}/backgrounds/{sceneId}_background.png`

**Gap:** No background approval step; if image is wrong, user must manually trigger regeneration from editor.

---

## Stage D: Character Image Generation

**Service:** `src/services/aiService.ts`

**Two paths:**

**Path 1 — LoRA (Universe of NULL characters):**
- Only when `project.universeId` AND character has LoRA ready
- `AIService.generateImageBase64(prompt, { isStoryEpisode: true })` → Replicate LoRA inference
- Trigger word `VEER_CHARACTER` embedded in prompt
- Negative prompt hardcoded against Japanese/Korean aesthetics

**Path 2 — Standard Gemini:**
- `AIService.generateImageBase64(prompt)` → Gemini Flash-Image
- Used for educational/generic pipeline

**Gap:** Anchor URL bug at `orchestrator.ts:781-789` — `characterAnchors.set(charKey, localTempPath)` stores a local path that breaks `fetch()` in subsequent API calls for anchor images.

---

## Stage E: Background Removal (rembg)

**Service:** `src/scripts/rembg_worker.py` + `callRembg()` in renderService

**Inputs:** Character image PNG

**Outputs:** Transparent character PNG (`_transparent.png`)

**Model:** `u2net` ONNX session, loaded once at module start

**Notable:**
- Module-level mutex in renderService (`rembgRunning`) prevents concurrent rembg calls
- Skipped for: `unified` scenes, NARRATOR scenes, Doraemon cutout scenes
- 60s timeout per call

**Gap:** One rembg process at a time means multi-user renders queue behind each other globally. Should be per-project or process-pooled.

---

## Stage F: Visual Animation

**Engine routing (from `renderService.ts:105-115`):**

| Condition | Engine | File |
|-----------|--------|------|
| `USE_METRO_V4=true` | Metro Engine V4 | `metro_engine_v4.py` |
| `USE_DORAEMON=true && render_mode='cutout'` | Doraemon Engine | `doraemon_engine.py` |
| Default | Scene Animator V3 | `scene_animator_v3.py` |

**V3 capabilities (scene_animator_v3.py + metro_engine_v3.py):**
- Ken Burns zoom (zoom_in/zoom_out/pan_left/pan_right)
- Vertical parallax (slow sky, fast floor)
- Location particles (dust/data_stream/tense/rain/static_noise)
- Emotion grades (colour LUT per emotion)
- Transitions (fade_black halves)

**V4 capabilities (metro_engine_v4.py, ~500 lines):**
- 3-layer parallax (BG 0.3T, char 1.0T, particles 1.5T)
- Idle animation: breathing (1.0→1.015 sine over 2s), ±3px drift, blink every 3-5s
- Feathered alpha compositing + Reinhard LAB colour matching
- Shadow sprite + AO contact gradient
- Emotion-driven camera: curious/tense/sad/empty/neutral with distinct motion profiles
- Location particles: dust+bokeh (street), teal data-streams (grid), dust motes in light beam (bedroom), static noise (black)
- Split-transition system: whip pan (street→street), chromatic glitch (black→any), red fade (any→black), data-wipe (grid→any)
- Depth parallax (optional: `depth_parallax.py`, requires `transformers` library)

**Doraemon capabilities (doraemon_engine.py, ~400 lines):**
- Part-based compositing from 25 named PNG assets
- Lip sync via audio amplitude thresholds (4 mouth states)
- Walk cycle (8 frames)
- Wide/portrait/background render modes
- Blink every 3-5s

**Gap:** V4 and Doraemon are built and flag-gated but not default. V3 is the production default. Activating V4 globally would require a validated full episode re-render.

---

## Stage G: Segment Assembly

**Service:** `renderService.assembleSceneSegment()` (lines 702-749)

**Inputs:** Animated MP4 + WAV audio

**Outputs:** `{sceneId}_segment.mp4` — video looped to audio duration

**FFmpeg command:** `stream_loop -1 -i {visual} -i {audio} -vf setpts=PTS-STARTPTS -af asetpts=PTS-STARTPTS -c:v libx264 -crf 20 -t {duration}`

**Notable:** `setpts=PTS-STARTPTS` resets PTS to 0 for each segment — critical for clean concat downstream.

---

## Stage H: Caption Burn

**Service:** `renderService.renderCaptions()` (lines 751-818)

**Inputs:** `_segment.mp4` + caption chunks

**Outputs:** `_captioned.mp4`

**Caption style (ASS):** `Arial 34pt, white bold, 3px black outline, bottom-center, shadow`

**Notable:** Words are split into 3-word max groups for mobile readability.

---

## Stage 5: Final Stitch

**Service:** `renderService.stitchScenes()` (lines 820-892)

**Inputs:** All `_captioned.mp4` files in order

**Outputs:** `final_{timestamp}.mp4`

**FFmpeg command:** `concat demuxer + scale 1080:1920 + -vsync cfr + libx264 crf 20`

**Notable:** `-fflags +genpts` removed (black frame fix, pending commit); `-vsync cfr` added.

---

## AI Review / Scoring

**What exists:**
- `validate_consistency.py` — CIE76 LAB skin-tone consistency per character asset. Called by `characterAssetService.ts`.
- `qualityService.ts` — Stub: base 50 + 20 if ≥3 scenes + 30 if no failed scenes.

**Gap:** Neither is called during episode rendering. No automated quality gate. No AI-based frame quality scoring.

---

## End-to-End Orchestration

**`orchestrator.ts` key guards:**
- `abortManager.getOrCreate(projectId)` — per-pipeline abort
- `withRetry()` — 3 retries, 2s base, exponential backoff, 429 detection
- `projectMemoryStore` — in-memory state for `DISABLE_FIRESTORE=true`
- `scene.stage` field tracks fine-grained progress for resume logic
- Recovery path: `runScenePipeline(projectId, sceneId)` for single-scene re-render

**Gap:** Recovery is per-scene but not per-stage within a scene. If background generation succeeds but audio fails, the scene restarts from audio (not from the failed stage).
