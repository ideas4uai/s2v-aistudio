import { Scene } from './scene.js';

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
}
