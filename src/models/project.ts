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
}

export interface Project {
  project_id: string;
  userId?: string;
  mode: 'shorts' | 'long';
  topic: string;
  hook_strategy: string;
  pacing_intensity: string;
  style_profile: string;
  status: 'draft' | 'scripting' | 'scene_parsing' | 'generating_assets' | 'stitching_video' | 'completed' | 'failed' | 'cancelled' | string;
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
  character_description?: string;
  world_entities?: {
    characters: { name: string; description: string; prompt: string }[];
    locations: { name: string; description: string; prompt: string }[];
    objects: { name: string; description: string; prompt: string }[];
  };
  quality_score?: number;
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
  music_track?: string;
  music_volume?: number;
  thumbnail_path?: string;
  projectType?: 'educational' | 'story_episode' | 'standard';
  universe?: Universe;
  episodeNumber?: number;
  featuredCharacterIds?: string[];
  featuredLocationId?: string;
}
