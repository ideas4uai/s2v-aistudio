# 08 — Database & Storage Audit

## Database Architecture Overview

The application uses **two persistence layers** with no SQL schema or ORM:

1. **Firebase Firestore** (NoSQL document store) — for project and universe metadata
2. **Supabase Storage** (object storage) — for all binary assets (images, audio, video)

There are no migration files, no Prisma schema, no SQL tables, and no relational database.

---

## Firestore Document Collections

### `projects/{uuid}`

**Schema (inferred from `src/models/project.ts` + `orchestrator.ts` field usage):**

```
projects/{project_id}
  project_id: string (UUID)
  topic: string
  projectType: 'educational' | 'story_episode' | 'standard'
  status: 'pending' | 'script_generated' | 'scenes_generated' | 'rendering' | 'completed' | 'failed' | 'degraded'
  userId: string (Firebase UID)
  universeId?: string → references universes collection
  episodeNumber?: number
  featuredCharacterIds?: string[]
  script?: string
  world_entities?: WorldEntity[]
  seo_metadata?: { title, description, tags, thumbnailText }
  settings:
    targetLength: number (seconds)
    aspectRatio: '9:16' | '16:9'
    voiceStyle?: string
    visualStyle?: string
    exportResolution?: '1080p' | '4k'
    musicTrack?: string
    musicVolume?: number
  scenes[]:
    scene_id: string (UUID)
    projectId: string
    order: number
    narration_text: string
    caption_text: string
    character: string
    emotion: string
    scene_type: string
    duration_target: number
    duration_actual?: number
    status: 'pending' | 'completed' | 'failed' | 'degraded'
    stage: 'audio' | 'audio_and_visuals' | 'captions' | 'asset' | 'render' | 'done'
    narration_path?: string (local temp path — NOT Supabase URL)
    segment_path?: string (local temp path)
    background_url?: string (Supabase URL)
    background_path?: string (local temp path)
    transparent_path?: string (local temp path)
    background_prompt?: string
    caption_chunks?: CaptionChunk[]
    timeline?: VisualSegment[]
    render_mode?: 'generative' | 'cutout'
    unified?: boolean
    prev_scene_type?: string
    next_scene_type?: string
    visuals[]:
      visual_id: string (UUID)
      prompt: string
      asset_type: string
      status: string
      asset_path?: string (local or Supabase URL)
      rendered_path?: string (local temp path)
      motion_instruction?: string
      duration_target: number
  output_path?: string (local path formatted as API URL — stub)
  createdAt: string (ISO timestamp)
  updatedAt: string (ISO timestamp)
```

**Issues:**
- `narration_path`, `segment_path`, `background_path`, `transparent_path`, `rendered_path` are local filesystem paths stored in Firestore — these paths break on any server restart or deployment change
- `output_path` is set to `/api/assets/download?path=...` — this endpoint is not implemented
- Scenes are stored as an array nested inside the project document — no separate `scenes` collection. This means the entire project is re-written on every scene update (large PATCH payload for 15+ scene projects)
- No index definitions (Firestore is queried via runQuery; only `userId` equality filter used)

---

### `universes/{uuid}`

**Schema (inferred from `src/models/project.ts:Universe` + `universeController.ts`):**

```
universes/{universe_id}
  id: string (UUID)
  name: string
  description?: string
  backgroundArtStyle?: string
  characters[]:
    id: string (UUID)
    name: string
    description?: string
    imageUrl?: string (Supabase URL)
    loraTrainingId?: string
    loraStatus?: 'training' | 'ready' | 'failed'
    loraModelUrl?: string
    loraTriggerWord?: string
    useLoRA?: boolean
    anchorImageUrl?: string
    poses?: Record<string, string>
  locations[]:
    id: string (UUID)
    name: string
    description?: string
    imageUrl?: string (Supabase URL)
    type?: string
  characterPoses?: Record<string, Record<string, string>>
  userId: string (Firebase UID)
  createdAt: string
  updatedAt: string
```

**Issues:**
- `characterPoses` is a nested record that duplicates pose URLs already in `characters[].poses` — denormalization with no clear winner
- No `episodeIds[]` in universe — projects/episodes are linked by `project.universeId` only (one-way reference)

---

### `templates/{id}` (seeded by server.ts)

Seeded on cold start from `server.ts:seedTemplates()` with 2 hardcoded templates. Read by frontend from `GET /api/templates` (served from in-memory store in `routes/templates.ts`, not from Firestore after seed). Mismatch: seeds write to Firestore, but reads come from in-memory.

---

## Supabase Storage Audit

**Single bucket:** `aivideogen`

**Path conventions (confirmed from `firestore.ts:uploadAsset` + orchestrator):**

| Asset Type | Path Pattern | Content-Type |
|-----------|-------------|-------------|
| Background images | `projects/{id}/backgrounds/{name}.png` | `image/png` |
| Character images | `projects/{id}/{fileName}` | `image/png` |
| Character asset pack | `projects/{id}/{assetName}.png` | `image/png` |
| Character anchors | **Bug: stored as local path** | Should be `anchors/{name}_anchor.png` |

**Upload method:** `getSupabase().storage.from('aivideogen').upload(filePath, data, { contentType, upsert: true })`

**Public URL:** `getPublicUrl(filePath)` — no expiry, no signed URLs

**Delete method:** `deleteAssetByUrl(urlStr)` — parses Supabase URL to extract path, calls `.remove([filePath])`

**Gaps:**
- No bucket policy review performed — assuming public read access for all assets
- No CDN in front of Supabase (direct origin for every asset fetch)
- No lifecycle policy for orphaned assets when projects are deleted
- Audio files (`narration-{sceneId}.wav`) and video segments are stored only on local filesystem — not uploaded to Supabase. They are lost on server restart.

---

## Local Filesystem Usage

| Content | Path | Lost on Restart? |
|---------|------|-----------------|
| Audio files | `%TEMP%/ais-audio/{projectId}/` | YES |
| Video segments | `%TEMP%/ais-renderer/` | YES |
| Final rendered MP4 | `%TEMP%/ais-renderer/{projectId}/final_*.mp4` | YES |
| Cache (images) | `./cache/` | NO (persists) |
| Character assets (PNGs) | `./assets/characters/{name}/` | NO (persists) |
| Output copies | `./outputs/` | NO (persists) |

**Critical gap:** Audio, segments, and final renders are in `%TEMP%` — ephemeral. In a container/Railway deploy, these are lost on every deployment. The pipeline would need to re-render from scratch after any restart.

---

## Data Model Normalization Assessment

| Issue | Current | Impact |
|-------|---------|--------|
| Scenes embedded in project document | 1 large PATCH per scene update | Performance degrades with 15+ scene projects |
| Local paths in Firestore | `narration_path`, `background_path` etc. | Server restart breaks resume; paths not portable |
| No separate `episodes` collection | Episodes are projects; no episode ordering | Episode manager UI cannot exist without schema change |
| No `assets` collection | Assets stored as URLs in scene/character objects | No asset browser; no orphan detection |
| No `voices` collection | Cloned voice IDs not persisted anywhere | Voice management impossible |
| No `analytics_events` collection | `logUserEvent` is a no-op | No analytics data |
| No `feedback` collection | `feedbackRouter` discards all data | No feedback loop |
| Universe references project one-way | Universe has no `episodeIds[]` | Can't list episodes from universe page |

---

## Recommended Data Evolution

**Phase 1 (minimal changes to unblock current use cases):**
- Add `output_url` field to project — store final MP4 in Supabase, not local filesystem
- Add `narration_url` to scenes — store audio in Supabase for portability
- Fix anchor URL bug: store Supabase URL in `character.anchorImageUrl`, not local path

**Phase 2 (enable new features):**
- Separate `scenes` sub-collection: `projects/{id}/scenes/{sceneId}` — enables per-scene writes without full project re-write
- Add `voices` collection: `voices/{id}` → `{name, voiceId, provider, userId, createdAt}`
- Add `episodes` to universe: `universeId + episodeNumber → projectId` linking

**Phase 3 (production scale):**
- `analytics_events` collection for render tracking
- `feedback` collection for user feedback
- CDN proxy for Supabase assets
- Lifecycle hooks to clean up orphaned Supabase assets when projects are deleted

---

## Schema Risk Rating

| Risk | Current State | Fix Effort |
|------|--------------|-----------|
| Local paths in Firestore | HIGH — pipeline not portable | MEDIUM |
| Final video only on local FS | HIGH — lost on restart | MEDIUM |
| No audio in Supabase | HIGH — lost on restart | LOW |
| Scenes array in project doc | MEDIUM — performance degrades | HIGH |
| No episode ordering | MEDIUM — UoN workflow blocked | MEDIUM |
| No voice storage | LOW — ElevenLabs retains clones | LOW |
