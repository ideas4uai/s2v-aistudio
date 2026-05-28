import { AssetType, JobStatus, SceneType, TransitionType } from './types.js';

export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
  emphasis?: boolean;
}

export interface CaptionChunk {
  words: string[];
  text: string;
  start: number;
  end: number;
  style?: {
    font_size: number;
    position: "center" | "lower_third";
    align: "center" | "left";
    highlight_mode: "word" | "none";
    animation: "pop" | "fade" | "none";
    color_primary: string;
    color_highlight: string;
    stroke_color: string;
    stroke_width: number;
    shadow: boolean;
  };
}

export interface VisualFrame {
  frame_id: string;
  prompt: string;
  asset_path?: string;
  duration: number;
  motion: string;
}

export interface Visual {
  visual_id: string;
  prompt: string;
  asset_type: AssetType;
  duration_target: number;
  motion_instruction: string | null;
  status: JobStatus;
  cache_key: string;
  asset_hash?: string;
  fallback_used?: boolean;
  asset_path?: string;
  rendered_path?: string;
  frames?: VisualFrame[];
  referenceImageUrl?: string;
  emotion?: string;
}

export interface VisualSegment {
  visual_id: string;
  start: number;
  end: number;
}

export interface Scene {
  scene_id: string;
  order: number;
  scene_type: SceneType;
  narration_text: string;
  caption_text: string;
  captions: WordTimestamp[];
  caption_chunks: CaptionChunk[];
  visuals: Visual[];
  timeline?: VisualSegment[];
  duration_target: number;
  duration_actual: number | null;
  audio_hash?: string;
  asset_type: AssetType;
  motion_instruction: string | null;
  transition_type: TransitionType;
  retry_count: number;
  fallback_used: boolean;
  cache_key: string;
  image_path?: string;
  status: JobStatus;
  stage?: 'audio' | 'audio_and_visuals' | 'captions' | 'asset' | 'render' | 'done';
  rendered_path?: string;
  narration_path?: string;
  segment_path?: string;
  captioned_path?: string;
  preview_path?: string;
  error_log: string | null;
  mode?: 'shorts' | 'long';
  preview_mode?: boolean;
  suggestions?: string[];
  is_null_tease?: boolean;
  emotion?: string;
  character?: string;

  // Source-aware generation metadata
  primarySubject?: string;
  location?: string;
  timePeriod?: string;
  camera?: string;
  lighting?: string;
  mood?: string;
  sourcePreference?: 'stock' | 'ai' | 'stock_then_ai';
  stockSearchQuery?: string;
  stockReason?: string;
  aiReason?: string;
}
