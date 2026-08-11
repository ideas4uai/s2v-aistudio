# 12 — Future Data Model Review

## Current Model Assessment

The current data model supports the core use case (automated video generation per project) but blocks several planned features. The key structural limitation is that **all data lives in two document types** (`projects` and `universes`) with deep nesting and local filesystem paths.

---

## Existing Collections (Firestore)

| Collection | Status | Notes |
|-----------|--------|-------|
| `projects/{id}` | ✅ Functional | Contains embedded `scenes[]` array |
| `universes/{id}` | ✅ Functional | Contains embedded `characters[]` and `locations[]` arrays |
| `templates` (seeded) | ⚠️ | Seeded to Firestore but served from in-memory; mismatch |

---

## Missing Entities (Confirmed Absent from Codebase)

### 1. `scenes/{id}` (sub-collection)

**Current:** Scenes embedded in project document as array  
**Problem:** Full project re-written on every scene update; no per-scene reads  
**Needed for:** Episode Manager, scene-level retry, per-scene analytics

```
projects/{projectId}/scenes/{sceneId}
  scene_id: string
  order: number
  narration_text: string
  emotion: string
  character: string
  background_prompt: string
  scene_type: string
  duration_target: number
  duration_actual?: number
  status: 'pending' | 'completed' | 'failed'
  stage: string
  audio_url?: string          ← Supabase URL (not local path)
  background_url?: string     ← Supabase URL
  visual_url?: string         ← Supabase URL
  captioned_segment_url?: string ← Supabase URL
  caption_chunks?: CaptionChunk[]
  createdAt: string
  updatedAt: string
```

---

### 2. `voices/{id}`

**Current:** Voice IDs received from ElevenLabs but never stored  
**Needed for:** Voice management UI, per-character voice routing

```
voices/{voiceId}
  id: string (ElevenLabs voiceId)
  name: string
  provider: 'elevenlabs' | 'piper' | 'gcloud'
  userId: string
  previewUrl?: string
  createdAt: string
```

---

### 3. `analytics_events/{id}`

**Current:** `logUserEvent()` is a no-op  
**Needed for:** Usage analytics, quota tracking, render statistics

```
analytics_events/{eventId}
  eventType: 'render_started' | 'render_completed' | 'render_failed' | 'image_generated' | 'audio_generated' | 'publish_triggered'
  userId: string
  projectId?: string
  sceneId?: string
  provider?: string       ← which AI provider was used
  durationMs?: number     ← how long the operation took
  error?: string
  metadata?: Record<string, any>
  timestamp: string
```

---

### 4. `feedback/{id}`

**Current:** `POST /api/feedback` returns `{success:true}` and discards data  
**Needed for:** Product improvement, content quality feedback

```
feedback/{feedbackId}
  projectId?: string
  userId: string
  useful: boolean
  improvement?: string
  createdAt: string
```

---

### 5. `universe_memory/{id}`

**Current:** No memory system exists  
**Needed for:** Cross-episode story continuity (Memory Engine Module 17)

```
universe_memory/{universeId}
  universeId: string
  characterStates: Record<charId, {
    lastSeen: string      ← episode + scene reference
    emotionalState: string
    recentEvents: string[]
    relationships: Record<charId, string>
  }>
  worldEvents: {
    eventId: string
    description: string
    episodeId: string
    sceneId: string
    timestamp: string
  }[]
  plotThreads: {
    threadId: string
    title: string
    status: 'active' | 'resolved' | 'abandoned'
    lastUpdated: string
  }[]
  updatedAt: string
```

---

### 6. `publish_jobs/{id}`

**Current:** No publishing system  
**Needed for:** Content Publishing Module 13

```
publish_jobs/{jobId}
  projectId: string
  userId: string
  platform: 'youtube' | 'tiktok' | 'instagram'
  platformVideoId?: string    ← returned by platform API
  status: 'pending' | 'uploading' | 'processing' | 'published' | 'failed'
  title: string
  description?: string
  tags?: string[]
  scheduledAt?: string
  publishedAt?: string
  error?: string
  createdAt: string
```

---

### 7. `platform_connections/{id}`

**Current:** No platform OAuth  
**Needed for:** Content Publishing Module 13

```
platform_connections/{connectionId}
  userId: string
  platform: 'youtube' | 'tiktok' | 'instagram'
  accessToken: string       ← encrypted at rest
  refreshToken?: string
  channelId?: string
  channelName?: string
  expiresAt?: string
  createdAt: string
```

---

## Missing Relationships

| Missing Relationship | Current State | Impact |
|--------------------|---------------|--------|
| Universe → Episodes | `project.universeId` (one-way) | Cannot list episodes from Universe page |
| Character → Scenes | No reference | Cannot find which scenes a character appears in |
| Voice → Project/Character | No reference | Cannot know which voice is used where |
| Scene → Assets | Asset URLs in scene fields | No centralized asset registry |
| Project → Publish Jobs | No reference | Cannot see publish history from project page |

---

## Evolutionary Database Strategy

### Immediate (Required for Reliability)

1. **Add `output_url` and `audio_url` to scenes** — store final assets in Supabase, not local filesystem
2. **Fix anchor URL** — store `character.anchorImageUrl` as Supabase URL
3. **Add `voices` collection** — 30 minutes, unblocks voice management

### Short-Term (Required for Product Features)

4. **Split scenes to sub-collection** — major but necessary; unblocks per-scene operations and reduces PATCH payload size
5. **Add `analytics_events` collection** — wire `logUserEvent()` to write here; unblocks quota tracking
6. **Add `feedback` collection** — implement `feedbackRouter`; unblocks user feedback loop
7. **Add `universeId → episodeIds[]`** — one field addition to Universe; unblocks episode manager

### Medium-Term (New Modules)

8. **Add `universe_memory` collection** — memory engine prerequisite
9. **Add `publish_jobs` + `platform_connections`** — publishing module prerequisite

### Long-Term (Scale)

10. **Migrate to Supabase PostgreSQL** (optional) — enables complex queries, relationships, transactions. Firestore works at current scale but relational queries (e.g., "all scenes with character X across all episodes") become awkward as the data grows.

---

## Migration Risk Assessment

| Change | Risk | Notes |
|--------|------|-------|
| Add fields to existing documents | LOW | Firestore is schemaless; additive changes are safe |
| Split scenes to sub-collection | MEDIUM | Requires migration of existing project documents; existing pipeline reads `project.scenes[]` |
| Remove local paths from persistence | LOW | Stop writing local paths; add URL fields instead |
| Move to PostgreSQL | HIGH | Full data migration; requires ORM; months of effort |

**Recommendation:** Stay with Firestore for now. Fix local path persistence and add missing collections. Do not migrate to PostgreSQL until the 20-module product is built and active user scale requires relational queries.
