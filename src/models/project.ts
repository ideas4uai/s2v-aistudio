import { Scene } from './scene.js';

export interface StoryCharacter {
  id: string;
  name: string;
  role: 'protagonist' | 'antagonist' | 'supporting' | string;
  concept: string;
  appearance: string;
  personality: string;
  colorPalette: string;
  voiceStyle: string;
  imagePrompt: string;
  referenceImageUrl?: string;
  loraTrainingId?: string;
  loraStatus?: 'training' | 'ready' | 'failed';
  loraModelUrl?: string;
  loraTriggerWord?: string;
  useLoRA?: boolean;
}

export interface StoryLocation {
  id: string;
  name: string;
  description: string;
  imagePrompt: string;
  mood: string;
  timeOfDay: 'day' | 'night' | 'any';
  referenceImageUrl?: string;
}

export interface Universe {
  projectId: string;
  title: string;
  logline: string;
  world: string;
  artStyle: string;
  toneRules: string;
  episodeStructure: string;
  recurringElements: string;
  characters: StoryCharacter[];
  locations: StoryLocation[];
  characterPoses?: Record<string, Record<string, string>>; // charName (uppercase) → pose → url
  /**
   * How long an episode in this universe runs, in seconds. A reel universe and
   * a long-form universe are not the same shape, and the handoff previously
   * hardcoded 60s for everything.
   */
  targetDurationSeconds?: number;
}

export type CloudBackupStatus = 'pending' | 'uploaded' | 'failed' | 'skipped';

export interface CloudBackup {
  status: CloudBackupStatus;
  /** Public URL of the uploaded copy. Only set when status is 'uploaded'. */
  url?: string;
  /** Why it failed, in words a person can act on. Only set when status is 'failed'. */
  error?: string;
  sizeBytes?: number;
  updatedAt: string;
}

export interface Project {
  project_id: string;
  userId?: string;
  mode: 'shorts' | 'long';
  // What the user named the project. Every stored record carries it (it is what the
  // dashboard and the output filename use); `topic` is the pipeline's own subject line
  // and is not always the same string.
  title?: string;
  topic: string;
  hook_strategy: string;
  pacing_intensity: string;
  style_profile: string;
  status: 'draft' | 'scripting' | 'scene_parsing' | 'generating_assets' | 'stitching_video' | 'completed' | 'failed' | 'cancelled' | 'hook_selection' | string;
  /**
   * When this project was moved to Trash, as an ISO string. Absent or null means live.
   *
   * Deliberately separate from `status`: a trashed project keeps whatever status it
   * had, so restoring it puts a completed render back as completed rather than having
   * to guess what it was. Deleting from the dashboard sets this; only Trash's
   * "Delete permanently" calls DELETE /:id and actually removes anything.
   */
  deleted_at?: string | null;
  current_action?: string;
  progress_percent?: number;
  logs?: string[];
  is_cancelled?: boolean;
  script?: string;
  created_at: Date;
  updated_at: Date;
  completed_at?: Date;
  preview_mode?: boolean;
  preview_video_path?: string;
  output_path?: string;
  /**
   * Off-machine copy of the finished video.
   *
   * `output_path` stays local and is what the app plays: the render is done when the
   * file is on disk, and nothing about playback should wait on, or be broken by, a
   * network round trip. This records what happened to the redundant cloud copy, so a
   * failed upload is a visible state rather than a line in a log nobody reads — which
   * is how uploads to a bucket that did not exist went unnoticed for three weeks.
   */
  cloud_backup?: CloudBackup;
  character_description?: string;
  /**
   * Region, era and cultural setting the imagery should depict, read once from the
   * project's own script. Only set for projects with no universe — a universe states
   * this in its character bible and art style already. Empty string means the script
   * named no particular place or period, which is a real answer and not a missing one.
   */
  visual_context?: string;
  world_entities?: {
    characters: { name: string; description: string; prompt: string }[];
    locations: { name: string; description: string; prompt: string }[];
    objects: { name: string; description: string; prompt: string }[];
  };
  quality_score?: number;
  /** Pre-publish gate verdict — see services/qualityService.runQualityGate. */
  quality_gate?: {
    passed: boolean;
    score: number;
    checks: { id: string; label: string; status: 'pass' | 'fail' | 'skipped'; detail: string }[];
    failures: string[];
    checkedAt: string;
  };
  tier?: string;
  export_preset?: string;
  export_resolution?: string;
  quality?: 'draft' | 'final';
  settings?: {
    language?: string;
    voiceStyle?: string;
    customVoiceId?: string;
    exportResolution?: string;
    exportPreset?: string;
    motionIntensity?: string;
    motionEffect?: string;
    aspectRatio?: string;
    targetLength?: string;
    visualStyle?: string;
  };
  scenes: Scene[];
  error_log: string | null;
  seo_metadata?: {
    title: string;
    description: string;
    tags: string[];
    thumbnailText: string;
  };
  /**
   * Back-link to the Content Studio run this project came from.
   *
   * Without it a project is an orphan the moment it is handed off, and nothing
   * downstream can ask whether its story was ever approved — which is exactly what
   * scheduled publishing has to know before it acts unattended.
   */
  contentStudio?: {
    episodeId: string;
    packageId: string;
    workflowRunId?: string;
  };
  /** Set once the video has been published. Its presence is what "already on YouTube" means. */
  youtube?: {
    videoId: string;
    url: string;
    privacyStatus: 'private' | 'unlisted' | 'public';
    title: string;
    publishedAt: string;
    /** True when the operator published past a failing quality gate. Recorded, not hidden. */
    forcedPastQualityGate?: boolean;
  };
  music_track?: string;
  music_volume?: number;
  /** Operator's trim on the whole sound-effects layer. 1 is the tuned level, 0 is off. */
  sfx_volume?: number;
  thumbnail_path?: string;
  projectType?: 'educational' | 'story_episode' | 'standard';
  universe?: Universe;
  episodeNumber?: number;
  featuredCharacterIds?: string[];
  featuredLocationId?: string;
  hookOptions?: Array<{ type: 'question' | 'statement' | 'story'; text: string }>;
  // First generated image per character (Supabase URL, or local path when the
  // upload failed) — seeded back into the pipeline on later runs so the
  // character stays visually consistent across scenes and re-renders.
  character_anchors?: Record<string, string>;
  selectedHook?: string;
  storyArc?: {
    beat_1_hook: string;
    beat_2_context: string;
    beat_3_surprise: string;
    beat_4_insight: string;
    beat_5_cta: string;
  };
  _directorPlan?: any;
}
