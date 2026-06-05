export type KeyTask = 'script' | 'scenes' | 'visual' | 'image';

const KEY_MAP: Record<KeyTask, string> = {
  script: process.env.GEMINI_KEY_SCRIPT || '',
  scenes: process.env.GEMINI_KEY_SCENES || '',
  visual: process.env.GEMINI_KEY_VISUAL || '',
  image:  process.env.GEMINI_KEY_IMAGE  || '',
};

export function getKeyForTask(task: KeyTask): string {
  if (process.env.GOOGLE_CLOUD_PROJECT) return ''; // ADC mode — key unused
  const key = KEY_MAP[task];
  if (!key) throw new Error(
    `No API key configured for task: ${task}. Add GEMINI_KEY_${task.toUpperCase()} to .env`
  );
  return key;
}

// Backward compat for any remaining getGeminiKey() call sites
export function getGeminiKey(task?: string): string {
  if (task === 'image')  return KEY_MAP.image;
  if (task === 'script') return KEY_MAP.script;
  if (task === 'scenes') return KEY_MAP.scenes;
  if (task === 'visual') return KEY_MAP.visual;
  return KEY_MAP.script || KEY_MAP.scenes || KEY_MAP.visual || KEY_MAP.image;
}

export interface PoolStatus {
  total: number;
  available: number;
  exhausted: string[];
}

// Stubs — no-op in the 4-key system, kept for server.ts import compat
export const markKeyExhausted = (_key: string, _taskType?: string): void => {};
export const getPoolStatus = (_taskType?: string): PoolStatus => {
  const loaded = (Object.values(KEY_MAP) as string[]).filter(k => k.length > 5).length;
  return { total: 4, available: loaded, exhausted: [] };
};
