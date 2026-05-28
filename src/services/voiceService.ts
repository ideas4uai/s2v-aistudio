import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import ffprobeStatic from 'ffprobe-static';
import { generateNarration } from '../server/services/ttsService.js';
import { Scene } from '../models/scene.js';
import { saveToCache } from './cacheService.js';

const execAsync = promisify(exec);

async function getAudioDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await execAsync(`"${ffprobeStatic.path}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
    const duration = parseFloat(stdout.trim());
    return !isNaN(duration) ? duration : 0;
  } catch (error) {
    console.error('[VoiceService] Could not determine audio duration', error);
    // Rough estimate based on file size for mp3 (e.g. 24kbps = 3KB/s)
    try {
       const stats = fs.statSync(filePath);
       return stats.size / 3000;
    } catch {
       return 5;
    }
  }
}

export const generateSceneAudio = async (scene: Scene, preset: any, hash: string, projectSettings?: any) => {
  // Use a proper project ID folder
  const projectId = (scene as any).projectId || 'tmp_' + scene.scene_id; 
  const audioPath = await generateNarration(
    scene.narration_text,
    scene.scene_id,
    projectId,
    { ...projectSettings, character: scene.character }
  );
  if (audioPath) {
    await saveToCache(hash, audioPath);
    const actualDuration = await getAudioDuration(audioPath);
    if (actualDuration > 0) {
      scene.duration_actual = actualDuration;
    }
  }
  return audioPath;
};
