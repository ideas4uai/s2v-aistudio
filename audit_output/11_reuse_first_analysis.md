# 11 — Reuse-First Analysis

## Classification Framework

- **Class A — Fully Reusable**: Use as-is, no changes needed
- **Class B — Reusable with Small Extensions**: Minor additions (<4 hours), interface unchanged
- **Class C — Reusable with Moderate Refactoring**: Meaningful changes (1-3 days), external behavior preserved
- **Class D — Should Never Be Modified**: Stable production fallback; changes risk regressions
- **Class E — Should Eventually Be Deprecated**: Superseded by newer implementation

---

## Class A — Fully Reusable (Use As-Is)

| Component | File | Why |
|-----------|------|-----|
| AbortManager | `src/pipeline/abortManager.ts` | 30 lines, clean interface, no external deps |
| DirectorAgent | `src/pipeline/agents/directorAgent.ts` | Stateless, clean interface, well-scoped |
| ScriptwriterAgent | `src/pipeline/agents/scriptwriterAgent.ts` | Stateless, clear input/output contract |
| WorldAgent | `src/pipeline/agents/worldAgent.ts` | Stateless, smallest agent (62 lines) |
| Firebase Auth | `src/lib/firebase.ts` + `src/server/utils/auth.ts` | Stable, well-tested Firebase pattern |
| Request Context | `src/server/utils/context.ts` | 3 lines, correct AsyncLocalStorage pattern |
| Retry Utility | `src/utils/retry.ts` | Solid exponential backoff, 429 detection |
| Hash Utilities | `src/utils/hash.ts` | Pure functions, no side effects |
| Path Utility | `src/utils/path.ts` | Simple URL normalization |
| Timeline Builder | `src/utils/timeline.ts` | Clean functional utility |
| AuthContext | `src/contexts/AuthContext.tsx` | Clean Firebase auth context |
| Card Component | `src/components/ui/card.tsx` | Standard Shadcn/ui pattern |
| Layout | `src/components/Layout.tsx` | Clean navbar shell |
| FeedbackModal | `src/components/FeedbackModal.tsx` | Ready when API is implemented |
| Metro Engine V4 | `src/scripts/metro_engine_v4.py` | Built, tested, flag-gated |
| Doraemon Engine | `src/scripts/doraemon_engine.py` | Built, tested, flag-gated |
| Rembg Worker | `src/scripts/rembg_worker.py` | Production-stable, minimal |
| Depth Parallax | `src/scripts/depth_parallax.py` | Optional enhancement, guarded |
| Validate Consistency | `src/scripts/validate_consistency.py` | Useful tool, just needs wiring |
| Fallbacks | `src/pipeline/fallbacks.ts` | Clean static fallback data |

---

## Class B — Reusable with Small Extensions (<4 hours each)

| Component | File | Extension Needed |
|-----------|------|-----------------|
| AIService | `src/services/aiService.ts` | Add Fal.ai + Together AI as image fallbacks; add ElevenLabs TTS path |
| FirestoreService | `src/server/db/firestore.ts` | Extract Supabase client to singleton; add `listAll()` without userId filter for admin |
| VoiceService | `src/services/voiceService.ts` | Add per-character voice routing |
| TTS Service | `src/server/services/ttsService.ts` | Add ElevenLabs TTS alongside existing Piper/GCloud |
| AssetService | `src/services/assetService.ts` | Replace Picsum fallback with real second-provider (Fal.ai) |
| LogService | `src/services/logService.ts` | Implement `logUserEvent` body (write to Firestore collection) |
| Dashboard | `src/pages/Dashboard.tsx` | Add analytics row, pagination, status indicators |
| UniverseEditor | `src/pages/UniverseEditor.tsx` | Add episode list section; remove Japanese style presets |
| VoiceCloner | `src/components/VoiceCloner.tsx` | Add voice playback preview |
| QuotaIndicator | `src/components/QuotaIndicator.tsx` | Wire to real quota tracking |
| UniverseController | `src/controllers/universeController.ts` | Already complete; minor additions |

---

## Class C — Reusable with Moderate Refactoring (1-3 days each)

| Component | File | Refactoring Needed |
|-----------|------|--------------------|
| Orchestrator | `src/pipeline/orchestrator.ts` (1340 lines) | Split into 3-4 sub-orchestrators: audio, visual, render, persistence. Extract INDIAN_AESTHETIC_SUFFIX to universe config. Remove Supabase client initialization (use FirestoreService). |
| RenderService | `src/services/renderService.ts` (893 lines) | Replace global rembg mutex with per-project queue. Add SSE progress events. Add final MP4 Supabase upload. Remove legacy V1 callAnimator when V4 is default. |
| StoryboardAgent | `src/pipeline/agents/storyboardAgent.ts` | Externalize SPEAKER_PATTERNS to universe config. Add memory context input. |
| CaptionService | `src/services/captionService.ts` | Replace time-math with Whisper API integration for word-level timestamps |
| CharacterAssetService | `src/services/characterAssetService.ts` | Extract STYLE_BASE to shared config; add edit-existing-pack path |
| ProjectController | `src/controllers/projectController.ts` | Add per-scene operations; add streaming progress endpoint |
| ProjectEditor | `src/pages/ProjectEditor.tsx` | Add scene drag-and-drop; per-scene preview; bulk operations |
| ProjectDetail | `src/pages/ProjectDetail.tsx` | Replace polling with SSE; add per-scene status breakdown |
| Templates Route | `src/server/routes/templates.ts` | Replace in-memory store with Firestore persistence |

---

## Class D — Should Never Be Modified

| Component | File | Why |
|-----------|------|-----|
| Metro Engine V3 | `src/scripts/metro_engine_v3.py` | Stable production fallback; V4 is the forward path. Breaking V3 removes the safety net. |
| Scene Animator V3 | `src/scripts/scene_animator_v3.py` | Stable CLI adapter for V3. Fix only the `choices=` issue if V4 is promoted to default. |
| Firebase config | `firebase-applet-config.json` | Do not rotate or restructure; existing deployed clients depend on this. |

---

## Class E — Should Eventually Be Deprecated

| Component | File | When to Deprecate |
|-----------|------|------------------|
| V1 Animator | `src/services/renderService.ts:39-85` (`callAnimator`) | After V4 is promoted to default (`USE_METRO_V4=true` globally) |
| animator.py | `src/scripts/animator.py` | Same condition as above |
| Picsum Fallback | `src/services/assetService.ts` | After Fal.ai/Together AI fallback is wired in |
| `diff.ts` stub | `src/utils/diff.ts` | After real scene hash diffing is implemented |
| `rateLimiter.ts` stub | `src/utils/rateLimiter.ts` | After real rate limiter is implemented |
| `quotaService.ts` stubs | `src/server/services/quotaService.ts` | After real quota tracking is built |

---

## Stub Routes to Implement (Priority Order)

| Route | File | What to Build | Effort |
|-------|------|---------------|--------|
| `GET /api/assets` | `routes/assets.ts` | List Supabase assets for a project | 4h |
| `GET /api/quota` | `routes/quota.ts` | Real per-user quota from analytics_events | 4h |
| `POST /api/feedback` | `routes/feedback.ts` | Write to Firestore `feedback` collection | 2h |
| `GET /api/jobs/:id` | `routes/jobs.ts` | Real job status from in-memory pipeline state | 4h |
| `POST /api/visuals/generate` | `routes/visuals.ts` | Trigger single-visual generation | 2h |

---

## Reuse Percentage Estimate

Based on all components analyzed:

| Category | Components | % of Codebase |
|----------|-----------|---------------|
| Class A (fully reusable) | 20 components | ~35% |
| Class B (small extension) | 11 components | ~25% |
| Class C (moderate refactor) | 9 components | ~20% |
| Class D (never change) | 3 components | ~5% |
| Class E (deprecate) | 6 components | ~5% |
| New development required | 6 missing modules | ~10% |

**Summary:**
- **60% of existing code is reusable as-is or with small extensions**
- **20% needs moderate refactoring but behavior is preserved**
- **10% should eventually be deprecated**
- **10% is genuinely new development** (publishing, analytics, knowledge base, memory engine, episode manager UI, asset browser)

**Key insight:** The architecture is healthy. The ratio of "build new" to "reuse existing" strongly favors reuse. The highest-value investment is wiring up existing stubs (5 routes) and fixing the 4 high-priority technical debt items before adding new modules.
