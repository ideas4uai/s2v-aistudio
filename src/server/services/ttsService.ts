import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';

const execAsync = promisify(exec);

async function generateSilentAudio(outputPath: string, duration = 5): Promise<string> {
  const silencePath = outputPath.replace('.wav', '-silence.wav');
  await execAsync(`"${ffmpegStatic}" -f lavfi -i anullsrc=r=44100:cl=stereo -t ${duration} -y "${silencePath}"`);
  return silencePath;
}

export async function generateNarration(
  text: string,
  sceneId: string,
  projectId: string,
  settings?: any
): Promise<string> {
  const projectAudioDir = path.join(os.tmpdir(), 'ais-audio', projectId);
  await fs.mkdir(projectAudioDir, { recursive: true });
  const outputPath = path.join(projectAudioDir, `narration-${sceneId}.wav`);
  const textFilePath = path.join(projectAudioDir, `text-${sceneId}.txt`);

  // Normalise short language codes to full names used throughout the routing
  const langRaw = (settings?.language || 'en').toLowerCase();
  const lang = langRaw === 'te' ? 'telugu'
             : langRaw === 'hi' ? 'hindi'
             : langRaw === 'en' ? 'english'
             : langRaw; // pass-through if already a full name

  // 1. Piper TTS — only attempted if PIPER_BIN_PATH is explicitly configured
  const piperBin = process.env.PIPER_BIN_PATH;
  if (piperBin) {
    try {
      console.log(`[TTS] Using Piper TTS for scene ${sceneId}`);
      await fs.writeFile(textFilePath, text, 'utf8');

      const voicesDir = process.env.PIPER_VOICES_DIR || path.dirname(piperBin);
      let modelName = 'en_US-lessac-medium';

      if (lang === 'hindi') {
        modelName = 'hi_IN-rohan-medium';
      } else if (lang === 'telugu') {
        modelName = 'te_IN-maya-medium';
      }

      if (settings?.voice_clone_url || settings?.user_voice_clone) {
        modelName = settings.voice_clone_url || settings.user_voice_clone;
      }

      const modelPath = path.join(voicesDir, `${modelName}.onnx`);
      const modelFile = path.basename(modelPath);
      const piperDir = path.dirname(piperBin);

      const isWindows = process.platform === 'win32';
      let piperCmd: string;
      if (isWindows) {
        piperCmd = `cmd /c "type "${textFilePath}" | "${piperBin}" --model "${modelFile}" --output_file "${outputPath}""`;
      } else {
        piperCmd = `cat "${textFilePath}" | "${piperBin}" --model "${modelFile}" --output_file "${outputPath}"`;
      }

      await execAsync(piperCmd, { timeout: 60000, cwd: piperDir });
      await fs.unlink(textFilePath).catch(() => {});
      const stats = await fs.stat(outputPath);
      console.log(`[TTS] Piper complete for scene: ${sceneId} size: ${stats.size} bytes`);
      return outputPath;
    } catch (piperErr: any) {
      const errMsg = (piperErr as any).stderr ? `${piperErr.message} | stderr: ${(piperErr as any).stderr}` : piperErr.message;
      const isTimeout = piperErr.killed || piperErr.code === 'ETIMEDOUT' || piperErr.message?.includes('timed out');
      if (isTimeout) {
        console.error(`[TTS] Piper TTS timeout after 30s for scene ${sceneId} — using silence`);
      } else {
        console.error(`[TTS] Piper failed for scene ${sceneId}: ${errMsg} — using silence`);
      }
      await fs.unlink(textFilePath).catch(() => {});
      console.log(`[TTS] Using silent audio fallback for scene: ${sceneId}`);
      return generateSilentAudio(outputPath);
    }
  }

  // 2. No TTS provider configured — generate silence
  console.warn(`[TTS] No TTS provider configured (PIPER_BIN_PATH not set) for scene ${sceneId} — using silence`);
  console.log(`[TTS] Using silent audio fallback for scene: ${sceneId}`);
  return generateSilentAudio(outputPath);
}

