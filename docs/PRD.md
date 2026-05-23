# AIVideoGen - Complete Product Requirements Document (PRD)

## 1. Product Overview
AIVideoGen is a production-grade, AI-powered short-form and long-form video generation application. Users provide a simple text prompt/concept, and the system utilizes a multi-agent AI pipeline to write a script, segment it into scenes, determine narrative flow, generate localized voiceovers, create descriptive visuals, and finally stitch everything together into a final `.mp4` video with captions and Ken Burns motion effects.

Built with an MVP-first but highly resilient architectures, it features robust fallbacks, aggressive parallel processing for speed, and hyper-localization for the Indian market (using regional TTS binaries like Hindi and Telugu).

---

## 2. Deep-Dive Features & Safeguards

We built several production-grade safeguards to ensure reliability, cost-efficiency, and visual quality:

1. **Resolution Scaling ("Draft" vs "Final" Mode):**
   * **Schema:** Projects have a `quality` field (`'draft' | 'final'`).
   * **Logic:** If `draft` or `preview_mode` is enabled, FFmpeg uses `-vf scale=1280:720` and the `-preset ultrafast` flag. Final mode uses 1080p or 4K with `-preset fast`.
   * **Benefit:** Fast iterations without re-triggering expensive AI endpoint calls.

2. **GCS Lifecycle Janitor ("Cleanup Hook"):**
   * **Logic (`cleanupAssets`):** Triggers when the final `.mp4` is uploaded successfully. It iterates through the project scenes and issues `DELETE` requests to Firebase Storage for all intermediate `.png`, `.wav`/`.mp3`, and `_segment.mp4` assets.
   * **Benefit:** Prevents cloud storage bloat. Fails safely without crashing the UI.

3. **Cloud Storage Connectivity Probe (Phase 0):**
   * **Logic:** Immediately after project initialization, the pipeline attempts to upload a small `.probe.txt` file to Storage.
   * **Benefit:** If Storage is misconfigured (e.g., bucket not found via 404), the pipeline halts immediately BEFORE making any expensive Gemini/Imagen API calls. This prevents "wasting credits" on assets that cannot be saved.

4. **Asset Validation & Recovery ("Safety Check"):**
   * **Logic (`validateProjectAssets`):** Runs immediately before final FFmpeg stitching. Checks if every scene possesses a `narration_path` and `visualUrl`. 
   * **Recovery:** If assets are missing (due to network drops), it marks those specific scenes as `pending` and re-runs `processSingleScene` exclusively for them before resuming the assembly track.

4. **Caption Resilience ("Viral Look"):**
   * **Styling:** Hardcoded viral-style bottom-center subtitles.
   * **FFmpeg Filter:** `subtitles='...':force_style='FontSize=24,FontName=Arial,Bold=-1,PrimaryColour=&H00FFFFFF,BorderStyle=3,Outline=2,Shadow=0,BackColour=&H80000000,Alignment=2,MarginV=30'`

5. **Multi-TTS Engine System (Regional Intelligence):**
   * **Primary:** **Piper TTS** (Local CLI binary). Uses local `.onnx` models (`hi_IN`, `te_IN`, `en_US`). Generates `.wav` files via a temporary `text.txt` payload to preserve UTF-8 validity for regional scripts (Hindi/Telugu). 
   * **Fallback 1:** ElevenLabs API for custom voice clone IDs.
   * **Fallback 2:** Google Cloud TTS for standard Wavenet/Neural2 voices.
   * **Fail-Safe:** Generates 0-byte dummy audio if all else fails so video compilation doesn't crash.

---

## 3. Data Dictionary / Core Schemas

### `Project`
```typescript
{
  project_id: string;          // UUID
  user_id: string;             // Firebase Auth UID
  prompt: string;              // User's base prompt
  status: 'pending' | 'scripting' | 'storyboarding' | 'processing_assets' | 'stitching_video' | 'completed' | 'failed';
  mode: 'shorts' | 'long';     // Video format
  quality?: 'draft' | 'final'; // Render quality flag
  settings: {
     language?: string;        // "English", "Hindi", "Telugu"
     voiceStyle?: string;
     user_voice_clone?: string; // Optional custom Piper ONNX path
  },
  scenes: Scene[];
  output_path?: string;        // Final video Firebase Storage URL
  preview_video_path?: string; // Draft video Firebase Storage URL
}
```

### `Scene`
```typescript
{
  scene_id: string;
  order: number;
  narration_text: string;      // What the TTS says
  visual_prompt: string;       // Instructions for the imaging model
  status: 'pending' | 'processing' | 'completed' | 'failed';
  stage?: 'script' | 'audio_and_visuals' | 'render';
  narration_path?: string;     // URL to .mp3/.wav
  visuals: Visual[];
  rendered_path?: string;      // URL to stitched scene_segment.mp4
}
```

---

## 4. System Architecture & Tech Stack

* **Frontend:** React 18, Vite, TypeScript, Tailwind CSS, `lucide-react`. Client-side routing. All data interactions trigger Express local API endpoints.
* **Backend:** Express.js (Node.js). Development uses `tsx` local execution; Production uses `esbuild` to compile to a single `dist/server.cjs` bundle bypassing ES relative import rules limits.
* **Database & Auth:** Google Firebase (Firestore + Auth).
* **Storage:** Firebase Cloud Storage for intermediate and final media blobs.
* **Video Engine:** `ffmpeg-static` via `child_process.exec`. Temporary assembly happens in Node `os.tmpdir()` to prevent filesystem write permission issues in restricted containers.

### Directory Structure Map
* `/src/pipeline/orchestrator.ts` - Master brain controlling parallel tasks, retry logic, and fallback handlers.
* `/src/pipeline/agents/` - Prompt logic and AI calls (Director, Scriptwriter, Storyboard, World).
* `/src/services/` - Shared services (`renderService.ts` for FFmpeg, `assetService` for image generation, `aiService` for Gemini calls).
* `/src/server/services/ttsService.ts` - Binary Piper execution & TTS platform routing.
* `/src/server/db/firestore.ts` - Centralizes Firebase Admin REST API calls (uploadAsset, deleteAsset, get/update documents).
* `/src/pages/` & `/src/components/` - React UI, heavily leveraging Dashboard and multi-tab `ProjectEditor`.

---

## 5. Advanced Flow & Intricate API Behaviors

1. **AI Output Sanitization:**
   * **Problem:** LLMs occasionally wrap JSON in `\`\`\`json ... \`\`\`` blocks, causing standard `JSON.parse` to throw errors in agents.
   * **Solution:** We implemented a rigorous substring extraction using `.indexOf('{')` and `.lastIndexOf('}')`, combined with double `try/catch` fallbacks to heavily ensure agents never outright fail.

2. **Parallel Pipelining:**
   * Inside `processSingleScene(scene)`, Image Generation (`visualPromise`) and Audio TTS (`audioPromise`) are dispatched concurrently using `Promise.all([audioPromise, visualsPromise])`. This almost halves generation latency.

3. **Bucket Waterfall Algorithm:**
   * **Problem:** Cross-project Firebase environments often diverge on bucket naming (`.appspot.com` vs `.firebasestorage.app`).
   * **Solution:** `firestore.ts > uploadAsset` implements an automated retry loop that tests:
     1. The configured bucket (stripping `gs://` protocol).
     2. `PROJECT_ID.appspot.com`.
     3. `PROJECT_ID.firebasestorage.app`.
     4. Bare `PROJECT_ID`.
   * **Benefit:** Eliminates "Bucket Not Found" errors that typically stall server-side media pipelines.

4. **TTS Script Optimization:**
   * `ScriptwriterAgent` is strictly instructed: *"Remove all emojis, hashtags, and complex markdown (bolding, italics inside text) that could cause the engine to stutter or mispronounce symbols."*

---

## 6. Future Scope (Identified & Pending)

1. **Video-to-Video Live Generation Models:** Transitioning from static image + Ken Burns scaling to dynamic AI Video APIs (Runway Gen-3, Luma DreamMachine, or Fal.ai). The codebase already has skeleton fields (`visual.asset_type = 'video'`) waiting for endpoint integration.
2. **Offline Piper Voice Cloning UI:** Expand the current backend override to allow users to upload their own `.onnx` voice models inside the `CreateProject` dashboard.
3. **Advanced Timeline Editor Component:** Replace the current "List of Scenes" in `ProjectEditor` with an interactive drag-and-drop video timeline (using something like `wavesurfer.js` for audio tracks).
4. **WebSocket/SSE Progress Tracking:** The frontend currently relies on rapid polling or Firebase Snapshot streaming. The backend `orchestrator.ts` logs should be streamed directly to the UI via Server-Sent Events (SSE) for a granular progress bar.

---

## 7. Local Developer Setup Context

When passing this repository to Claude Code, local cursors, or alternative IDEs, follow these instructions to replicate the environment correctly:

### Prerequisites
1. **Node.js**: v18+ (Preferably v20+ setup).
2. **FFmpeg**: Required in System `$PATH`. While `ffmpeg-static` is in `package.json`, global CLI availability prevents `spawn` execution errors.
3. **Piper TTS**: Download [Piper](https://github.com/rhasspy/piper) binaries. Place the executable in your system `$PATH` or export `PIPER_BIN_PATH=/path/to/piper.exe`. Download associated `en_US`, `hi_IN`, and `te_IN` ONNX models.

### Environment & Keys
Create `.env` natively:
```env
GEMINI_API_KEY=your_gemini_api_key
ELEVENLABS_API_KEY=optional
GOOGLE_CLOUD_TTS_API_KEY=optional
PIPER_BIN_PATH=piper
```
Ensure `firebase-applet-config.json` is correctly set. Verify the `storageBucket` URL does not contain `gs://` protocol handlers.

### Key AI Editor Guidelines (For Claude/Other bots)
1. **Never mock APIs.** We require actual external implementations.
2. **Preserve `os.tmpdir()` logic:** Node restricted environments do not allow writing to `/src` or `/public` freely. FFmpeg temporary renderings and Piper `.text`/`.wav` assets MUST write to `os.tmpdir()` to avoid `EACCES` crashes.
3. **CommonJS Compiler Rules:** Ensure `vite.config.ts` and `package.json` build scripts remain configured to bundle the Express server into `dist/server.cjs`. Do not natively rely on `ts-node` for production deployments.
