# 06 — Frontend Audit

## Architecture Overview

React 18 SPA served by Vite (dev) or compiled to `dist/` (prod). Single `App.tsx` entry with React Router v6. Six pages, six routes. Firebase Auth context wraps the entire app. No Redux/Zustand/Jotai — local `useState` manages all state.

**Auth approach (confirmed from `AuthContext.tsx`):**
- `DEV_USER` hardcoded at `src/contexts/AuthContext.tsx:13` — in `MODE=development`, Firebase auth is bypassed entirely and this stub user is injected
- Production: `onAuthStateChanged(auth)` → real Firebase Google Sign-In
- `ApiKeyGuard` component is a pass-through (`ApiKeyGuard.tsx:~6 lines, renders children only`) — no actual key gating

---

## Pages

### Dashboard (`/`, `src/pages/Dashboard.tsx`)

**What exists:**
- Fetches projects and universes in parallel via `Promise.all` (line 24)
- Project list with search (client-side filter on `topic`/`title`) and sort (latest/oldest/name)
- Delete with confirmation dialog (`deletingId` state pattern)
- Universe cards with delete handler
- `useAuth()` — re-fetches when user changes
- Icons: `Plus`, `Video`, `Clock`, `ChevronRight`, `Trash2`, `Search`, `BookOpen`

**Gaps:**
- No analytics tiles (render count, success rate, total duration)
- No quick-start CTAs ("Make your first video", "Create a Universe")
- No project status indicators beyond what the API returns
- No pagination — all projects loaded at once (could be slow with 50+ projects)
- No recent activity feed
- Universe list shown but no "Create Universe" quick action

---

### CreateProject (`/projects/new`, `src/pages/CreateProject.tsx`)

**What exists:**
- Three project types: `educational`, `story_episode`, `standard`
- Rich settings form: aspect ratio, voice style, visual style, export preset
- Universe/episode linking for `story_episode` type
- `VoiceCloner` component embedded for voice cloning during project setup
- Template loading from `/api/templates`

**Gaps:**
- No script preview before committing to generate
- No estimated cost/time before render
- "Story episode" type requires manual universe selection — no guided wizard for new users

---

### ProjectDetail (`/projects/:id`, `src/pages/ProjectDetail.tsx`)

**What exists:**
- Read-only project status view
- Polls `/api/projects/:id/status` on interval
- Re-fetches on browser tab focus (`window.addEventListener('focus')`)

**Gaps:**
- No real-time progress (polling only, no SSE/WebSocket)
- No scene-level status breakdown ("Scene 3/8 complete")
- No error details when pipeline fails
- No "retry failed scene" action

---

### ProjectEditor (`/projects/:id/edit`, `src/pages/ProjectEditor.tsx`)

**What exists (inferred from imports and field names):**
- Full scene-level editor
- Scene interface fields: `scene_id`, `order`, `duration`, `narration_text`, `visual_prompt`, `character`, `emotion`, `scene_type`, `background_prompt`
- Inline narration editing
- Per-scene actions: regenerate image, regenerate audio, download
- Render trigger button
- `VoiceCloner` embedded for mid-session voice cloning

**Gaps (confirmed from code context):**
- No drag-and-drop scene reordering (order is index-based)
- No undo/redo
- No scene preview (play individual scene clip)
- No bulk operations ("regenerate all images")
- No split/merge scenes
- Render triggers full pipeline re-run (no incremental render — `diff.ts` is a stub)

---

### UniverseEditor (`/universes/:id`, `src/pages/UniverseEditor.tsx`)

**What exists:**
- Universe object with `StoryCharacter[]` and `StoryLocation[]`
- Style preset selector (8 presets: Anime Cinematic, Photorealistic, Makoto Shinkai, Studio Ghibli, Cyberpunk, Indian Miniature Modern, Webtoon, Custom)
- Character CRUD with AI image generation per character
- Location CRUD with AI image generation per location
- Save via `PUT /api/universes/:id`

**Gaps:**
- No episode list within universe (episodes are separate projects)
- No character visual consistency review
- No "publish universe" flow
- No episode ordering/numbering UI
- Style presets include "Makoto Shinkai" and "Studio Ghibli" — Japanese aesthetic options persist even as UoN targets South Asian style

---

### CharacterOnboarding (`/characters/new`, `src/pages/CharacterOnboarding.tsx`)

**What exists:**
- 5-step wizard
- Steps: name/style selection → reference image upload → asset generation per group → review
- 5 asset groups: Body Poses (4), Mouth/Lip Sync (6), Eye States (4), Brow States (3), Walk Cycle (implied from scripts)
- 3 style options: `flat_colour_anime`, `cartoon`, `semi_realistic`

**Gaps:**
- No per-asset replacement (regenerate only specific failed assets)
- No character archive/history
- No consistency validation visible to user (validator runs but score not displayed in UI)
- No way to update an existing character's assets after onboarding

---

## Components

### Layout (`src/components/Layout.tsx`, ~40 lines)

- Top navbar with Firebase Google Sign-In / Sign-Out
- `Script2Video` branding with indigo "S" logo
- Navigation links to Dashboard and other main pages
- `useAuth()` for user state

**Gap:** No sidebar navigation for complex workflows; no notification bell; no help/docs link.

---

### VoiceCloner (`src/components/VoiceCloner.tsx`, ~60 lines)

- Multi-file upload for ElevenLabs voice cloning
- POSTs to `/api/voices/clone` with FormData `name + files[]`
- `onVoiceCloned(voiceId, name)` callback to parent

**Gap:** No playback preview of cloned voice; no voice management (list/delete cloned voices).

---

### FeedbackModal (`src/components/FeedbackModal.tsx`, ~60 lines)

- Thumbs up/down + free-text modal
- POSTs to `/api/feedback` — which is a stub returning `{success:true}`
- UI is polished; data is discarded server-side

**Gap:** Feedback endpoint is a stub; no feedback is actually stored or reviewed.

---

### QuotaIndicator (`src/components/QuotaIndicator.tsx`, ~80 lines)

- Sidebar quota display with live countdown to reset
- Reads from `QuotaContext` (`useQuota()`)
- Shows AI images used/remaining, audio used/remaining

**Gap:** Backend quota endpoint returns hardcoded values; actual usage is not tracked. QuotaContext reads from `GET /api/quota` which returns `{aiImagesLimit:10, audioLimit:10, resetsIn:'24h'}` always.

---

### ApiKeyGuard (`src/components/ApiKeyGuard.tsx`, ~6 lines)

- Pass-through component; renders children unconditionally
- No actual API key validation

---

## Workflow Gaps

| User Journey | Current State | Gap |
|-------------|---------------|-----|
| New user → first video | Create project → generate script → generate scenes → render | No onboarding guide; no ETA on render time |
| Edit scene visual | ProjectEditor → trigger image regeneration | No preview before committing; old image stays until new one generated |
| Fix failed scene | ProjectDetail shows failed status | No error message shown; no retry button |
| Download final video | `/api/assets/download?path=...` | Route not implemented; user must navigate to `outputs/` directory manually |
| Publish to platform | — | Missing entirely |
| View render analytics | Dashboard | No render stats shown |
| Manage cloned voices | VoiceCloner (creates only) | No list/delete/preview |
| Character asset update | CharacterOnboarding (create only) | No edit path after initial generation |

---

## State Management Assessment

All state is local `useState` per component. No global store. This works today because:
- Projects are server-authoritative (all reads from Firestore)
- No cross-component state sharing except via React Context (Auth, Quota)

**Risk:** As features grow (episode manager, asset browser), prop drilling and component re-mounting will become painful. Recommend a lightweight global store (Zustand) when the third multi-page flow is added.

---

## Frontend Build / Tooling

| Tool | Status | Notes |
|------|--------|-------|
| Vite | ✅ | Configured via `vite.config.ts`; HMR disabled via `DISABLE_HMR` env var |
| TypeScript | ✅ | `strict: true`; `@/*` path alias |
| Tailwind CSS v4 | ✅ | Via `@tailwindcss/vite` plugin |
| React Router v6 | ✅ | 6 routes in `App.tsx` |
| lucide-react | ✅ | Icon set |
| motion/react | ✅ | Used in `FeedbackModal.tsx` for AnimatePresence |
| ESLint | ✅ | `eslint.config.js` present |
| Test runner | ❌ | None configured |
| Storybook | ❌ | Not present |
