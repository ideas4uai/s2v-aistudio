# 15 — Executive Audit Report

**Project:** s2v-aistudio (Script2Video / AI Universe Studio)  
**Audit Date:** 2026-07-02  
**Audit Basis:** Read-only inspection of all production source files  
**Confidence:** HIGH (all major claims backed by file reads)

---

## Executive Summary

s2v-aistudio is an **AI video production platform** that converts a text topic into a narrated animated MP4 in 5-15 minutes with no human intervention. The core pipeline — 4 AI agents → TTS → image generation → Python animation → FFmpeg stitch — is functional and production-capable.

The platform has two personalities: an educational/generic video maker and a Universe of NULL (UoN) animated series pipeline with LoRA character images, lip-sync animation, and split-transition cinematic rendering.

**The pipeline works. The delivery and publishing layers do not.**

The top 3 problems are:
1. Final rendered videos are stored only in a local temp directory — inaccessible after any server restart
2. 6 of 20 product modules are entirely missing (publishing, analytics, memory engine, knowledge base, environment manager, quota tracking)
3. No automated tests — any change to the 1340-line orchestrator or 893-line render service could silently break all video production

---

## Architecture Overview

```
React 18 (Vite) ←→ Express 4 (server.ts) ←→ Firebase Firestore (projects/universes)
                                          ←→ Supabase Storage (images)
                                          ←→ Gemini 2.5 Flash (text + images)
                                          ←→ Replicate (LoRA images)
                                          ←→ ElevenLabs (voice clone)
                                          ←→ Python engines (animation)
                                          ←→ FFmpeg (video assembly)
```

**4-agent AI pipeline:** DirectorAgent → ScriptwriterAgent → StoryboardAgent → WorldAgent

**3 rendering engines:** Metro V3 (stable default) → Metro V4 (cinematic, flag-gated) → Doraemon (lip-sync, flag-gated)

---

## A. Complete 20-Row Module Status Table

| # | Module | Status | Evidence File | Priority |
|---|--------|--------|---------------|----------|
| 1 | Authentication | ✅ EXISTS | `src/lib/firebase.ts`, `src/server/utils/auth.ts` | 🟡 M |
| 2 | Dashboard | ✅ EXISTS | `src/pages/Dashboard.tsx` | 🟡 M |
| 3 | Universe Management | ⚠️ PARTIAL | `src/pages/UniverseEditor.tsx`, `src/controllers/universeController.ts` | 🟡 M |
| 4 | Character Manager | ⚠️ PARTIAL | `src/pages/CharacterOnboarding.tsx`, `src/services/characterAssetService.ts` | 🟡 M |
| 5 | Environment Manager | ❌ MISSING | `src/models/project.ts` (model only) | 🟢 L |
| 6 | Visual Style Manager | ⚠️ PARTIAL | `src/pipeline/orchestrator.ts:71-84`, UniverseEditor presets | 🟢 L |
| 7 | Story Engine | ✅ EXISTS | `src/pipeline/agents/` (4 agents) | 🟢 L |
| 8 | Prompt Engine | ⚠️ PARTIAL | `orchestrator.ts:71-84`, `characterAssetService.ts:ASSET_PROMPTS` | 🟡 M |
| 9 | Image Engine | ✅ EXISTS | `src/services/aiService.ts`, `src/services/assetService.ts` | 🟡 M |
| 10 | Voice Engine | ⚠️ PARTIAL | `src/server/services/ttsService.ts`, `src/server/routes/voices.ts` | 🟡 M |
| 11 | Video Engine | ✅ EXISTS | `src/services/renderService.ts`, Python engines | 🔴 H (delivery fix) |
| 12 | Episode Manager | ⚠️ PARTIAL | `src/models/project.ts` (fields), seed scripts | 🟡 M |
| 13 | Content Publishing | ❌ MISSING | None found | 🔴 H |
| 14 | Analytics | ❌ MISSING | `src/services/logService.ts` (stub only) | 🔴 H |
| 15 | Knowledge Base | ❌ MISSING | None found | 🟢 L |
| 16 | AI Review Engine | ⚠️ PARTIAL | `src/scripts/validate_consistency.py` | 🟢 L |
| 17 | Memory Engine | ❌ MISSING | `scripts/test_memory_store.ts` (test only) | 🟡 M |
| 18 | AI Orchestration | ✅ EXISTS | `src/pipeline/orchestrator.ts` (1340 lines) | 🟡 M |
| 19 | Asset Management | ⚠️ PARTIAL | `src/server/db/firestore.ts:uploadAsset` | 🟡 M |
| 20 | Future Readiness | ⚠️ PARTIAL | Flag-gated engines, TypeScript strict | 🟡 M |

**Counts: ✅ 5 | ⚠️ 9 | ❌ 6**

---

## B. Architecture Score

| Dimension | Score | Notes |
|-----------|-------|-------|
| Pipeline automation | 8.5/10 | Full topic→MP4 automation; 3 flag-gated engines; robust error handling |
| Character consistency | 5/10 | Validator built but not wired to episode pipeline; anchor URL bug breaks LoRA consistency |
| Content publishing | 1/10 | Download only; no platform integrations; even the download endpoint is a stub |
| Universe management | 6/10 | CRUD works well; episode ordering is manual; no memory/continuity |
| Analytics | 1/10 | `logUserEvent()` is a no-op; quota stubs; no data collected |
| Memory/continuity | 1/10 | Test file only; no implementation; each episode starts cold |
| **Overall** | **3.7/6 = 37/60** | Excellent core pipeline; weak delivery and discovery layers |

---

## C. Top 10 Missing Features Blocking Weekly Posting Goal

| # | Feature | Why It Blocks | Effort |
|---|---------|---------------|--------|
| 1 | Final video upload to Supabase | Cannot reliably access rendered videos | 4h |
| 2 | Anchor URL fix | UoN character consistency broken | 2h |
| 3 | Render progress streaming (SSE) | No visibility into 10-15 min renders | 8h |
| 4 | Per-scene retry UI | 1 failed scene = full re-render | 6h |
| 5 | Real scene diff (not stub) | Every edit re-renders all scenes | 8h |
| 6 | YouTube publishing with SEO metadata | Manual upload/metadata = bottleneck | 2-3 days |
| 7 | Memory Engine | UoN episodes have no story continuity | 2-3 days |
| 8 | Whisper captions | Mechanical equal-spaced captions | 8h |
| 9 | Analytics (logUserEvent implementation) | Flying blind on costs/failures | 6h |
| 10 | Voice management UI | Cloned voices not listable/selectable | 4h |

---

## D. Reuse Map

| What | Reuse Category | File |
|------|---------------|------|
| All 4 AI agents | Class A — no changes | `src/pipeline/agents/` |
| Metro Engine V4 | Class A — no changes (promote via flag) | `src/scripts/metro_engine_v4.py` |
| Doraemon Engine | Class A — no changes (promote via flag) | `src/scripts/doraemon_engine.py` |
| Firebase Auth | Class A — no changes | `src/lib/firebase.ts`, `auth.ts` |
| RetryUtility, AbortManager | Class A — no changes | `src/utils/retry.ts`, `src/pipeline/abortManager.ts` |
| AIService | Class B — add Fal.ai fallback | `src/services/aiService.ts` |
| FirestoreService | Class B — add video upload method | `src/server/db/firestore.ts` |
| RenderService | Class B — add Supabase upload, SSE events | `src/services/renderService.ts` |
| Orchestrator | Class C — split into sub-modules | `src/pipeline/orchestrator.ts` |
| CaptionService | Class C — replace with Whisper | `src/services/captionService.ts` |
| Projects route | Class C — add SSE endpoint, per-scene route | `src/server/routes/projects.ts` |

**Overall reuse split: 35% A | 25% B | 20% C | 10% D | 10% new**

---

## E. 4-Phase Roadmap

### Phase 1: Reliability (Weeks 1-2) — Fix the Delivery Layer

| Task | Effort |
|------|--------|
| Upload final MP4 to Supabase after stitch | 4h |
| Fix anchor URL bug | 2h |
| Implement `logUserEvent()` basic analytics | 4h |
| Add render progress SSE endpoint | 8h |
| Fix `diff.ts` for real scene diffing | 8h |
| Add per-scene retry UI button | 6h |
| Add voice management UI (list/play/select) | 6h |

**Deliverable:** Videos reliably accessible; users can monitor progress; editing is incremental.

---

### Phase 2: Quality (Weeks 3-5) — Improve Output Quality

| Task | Effort |
|------|--------|
| Promote Metro Engine V4 to default (`USE_METRO_V4=true`) | 2h (flag flip + validation) |
| Integrate Whisper for caption timing | 8h |
| Wire `validate_consistency.py` into episode render | 4h |
| Add Fal.ai/Together AI as image generation fallback | 8h |
| Replace Picsum fallback | 4h |
| Implement real quota tracking from analytics_events | 8h |

**Deliverable:** Cinematic quality renders; professional caption sync; no Picsum images in output.

---

### Phase 3: Scale (Weeks 6-8) — Enable the Weekly Cadence

| Task | Effort |
|------|--------|
| YouTube Data API v3 publishing flow | 3 days |
| Episode Manager UI | 2 days |
| Memory Engine (universe_memory Firestore collection + agent injection) | 3 days |
| Per-character voice routing | 1 day |

**Deliverable:** 4 videos/week is achievable; UoN has story continuity; direct YouTube publish.

---

### Phase 4: Product (Months 3-4) — Full Studio

| Task | Effort |
|------|--------|
| Asset browser UI | 1 week |
| Analytics dashboard (render stats, platform performance) | 1 week |
| TikTok + Instagram publishing | 1 week |
| Prompt template library (user-editable) | 1 week |
| Orchestrator refactor (split into sub-modules) | 1 week |
| Test suite (Vitest) | 1 week |

**Deliverable:** Full AI Universe Studio product.

---

## F. CTO Verdict

**The pipeline is genuinely excellent.** The automation from topic to MP4 is state-of-the-art for a single-developer build. The three-engine rendering system (V3/V4/Doraemon), the 4-agent story pipeline, and the robust error handling are all production-grade work.

**The delivery layer has not kept up with the pipeline.** The system renders great videos that nobody can reliably access after a restart. Five API routes are stubs. The download button leads nowhere. This gap between "pipeline works" and "product works" is the defining technical problem.

**The one most important thing to build next is: upload the final rendered video to Supabase and return a public URL.** Four hours of work. Unlocks everything else.

After that: YouTube publishing. The SEO metadata is already being generated. The video just needs to reach the platform. That single feature converts this from a local tool to a content production engine.
