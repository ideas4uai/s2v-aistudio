import { Scene } from '../models/scene.js';

export const fallbacks = {};

export const fallbackHook = (topic: string) => `Hook for ${topic}`;
export const fallbackScript = (topic: string, hook: string) => `Script for ${topic} with ${hook}`;
export const fallbackSceneGraph = (script: string, project: any): Scene[] => [
  {
    scene_id: `scene_${Date.now()}`,
    order: 0,
    scene_type: 'build',
    narration_text: script,
    caption_text: script,
    captions: [],
    caption_chunks: [],
    duration_target: 5,
    duration_actual: null,
    asset_type: 'ai_image',
    motion_instruction: null,
    transition_type: 'hard_cut',
    retry_count: 0,
    fallback_used: false,
    cache_key: '',
    visuals: [
      {
        visual_id: `visual_${Date.now()}`,
        prompt: `A visual about ${project.topic}`,
        asset_type: 'ai_image',
        duration_target: 5,
        status: 'pending',
        motion_instruction: null,
        cache_key: ''
      }
    ],
    status: 'pending',
    error_log: null
  }
];
