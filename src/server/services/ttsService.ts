import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';

const execAsync = promisify(exec);

function estimateDurationSec(text: string, hintSec?: number): number {
  if (hintSec && hintSec > 0) return hintSec;
  // ~150 wpm = 2.5 words/second; minimum 3 seconds
  const words = text.trim().split(/\s+/).filter(w => w.length > 0).length;
  return Math.max(3, Math.ceil(words / 2.5));
}

async function generateSilentAudio(outputPath: string, durationSec: number): Promise<string> {
  const silencePath = outputPath.replace(/\.wav$/, '-silence.wav');
  try {
    await execAsync(
      `"${ffmpegStatic}" -f lavfi -i anullsrc=r=44100:cl=stereo -t ${durationSec.toFixed(2)} -y "${silencePath}"`
    );
  } catch (ffmpegErr: any) {
    // Last resort: ffmpeg itself failed — write a raw silent WAV directly (no dependencies)
    console.error(`[TTS] ffmpeg silence generation failed: ${ffmpegErr.message} — writing raw WAV`);
    const sampleRate = 44100;
    const numSamples = Math.round(sampleRate * Math.max(1, durationSec));
    const dataSize = numSamples * 2; // mono, 16-bit
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);   // PCM
    header.writeUInt16LE(1, 22);   // mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28); // byte rate
    header.writeUInt16LE(2, 32);   // block align
    header.writeUInt16LE(16, 34);  // bits per sample
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    await fs.writeFile(silencePath, Buffer.concat([header, Buffer.alloc(dataSize, 0)]));
  }
  return silencePath;
}

export async function generateNarration(
  text: string,
  sceneId: string,
  projectId: string,
  settings?: any,
  durationSec?: number
): Promise<string> {
  const projectAudioDir = path.join(os.tmpdir(), 'ais-audio', projectId);
  await fs.mkdir(projectAudioDir, { recursive: true });
  const outputPath = path.join(projectAudioDir, `narration-${sceneId}.wav`);
  const silenceDuration = estimateDurationSec(text, durationSec);
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
      const VOICE_MAP: Record<string, string> = {
        'VEER':     'en_US-joe-medium',
        'VEER_ALT': 'en_US-reza_ibrahim-medium',
        'BYTE':     'en_US-ryan-high',
        'NOVA':     'en_GB-alba-medium',
        'NARRATOR': 'en_US-lessac-medium',
      };
      const VOICE_STYLE: Record<string, { speed: number; noise: number }> = {
        'NARRATOR': { speed: 0.95, noise: 0.2  },
        'VEER':     { speed: 0.92, noise: 0.2  },
        'VEER_ALT': { speed: 0.90, noise: 0.2  },
        'BYTE':     { speed: 1.15, noise: 0.4  },
        'NOVA':     { speed: 0.85, noise: 0.1  },
        'MIRA':     { speed: 0.88, noise: 0.2  },
        'BIAS':     { speed: 0.92, noise: 0.15 },
        'NULL':     { speed: 0.75, noise: 0.05 },
      };

      let modelName = VOICE_MAP[
        (settings?.character as string | undefined)?.toUpperCase() ?? ''
      ] ?? VOICE_MAP['NARRATOR'];

      if (lang === 'hindi') {
        modelName = 'hi_IN-rohan-medium';
      } else if (lang === 'telugu') {
        modelName = 'te_IN-maya-medium';
      }

      if (settings?.voice_clone_url || settings?.user_voice_clone) {
        modelName = settings.voice_clone_url || settings.user_voice_clone;
      }

      const charKey = (settings?.character as string | undefined)?.toUpperCase() ?? 'NARRATOR';
      const style = VOICE_STYLE[charKey] ?? VOICE_STYLE['NARRATOR'];
      const lengthScale = (1 / style.speed).toFixed(3);
      const noiseScale = style.noise.toFixed(3);
      const noiseW = (style.noise * 0.5).toFixed(3);
      console.log('[TTS] Scene character:', settings?.character, 'Voice model selected:', modelName, `speed=${style.speed} length_scale=${lengthScale} noise=${noiseScale}`);

      const modelPath = path.join(voicesDir, `${modelName}.onnx`);
      const modelFile = path.basename(modelPath);
      const piperDir = path.dirname(piperBin);
      const styleFlags = `--length_scale ${lengthScale} --noise_scale ${noiseScale} --noise_w ${noiseW}`;

      const isWindows = process.platform === 'win32';
      let piperCmd: string;
      if (isWindows) {
        piperCmd = `cmd /c "type "${textFilePath}" | "${piperBin}" --model "${modelFile}" ${styleFlags} --output_file "${outputPath}""`;
      } else {
        piperCmd = `cat "${textFilePath}" | "${piperBin}" --model "${modelFile}" ${styleFlags} --output_file "${outputPath}"`;
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
      return generateSilentAudio(outputPath, silenceDuration);
    }
  }

  // 2. No TTS provider configured — generate silence
  console.warn(`[TTS] No TTS provider configured (PIPER_BIN_PATH not set) for scene ${sceneId} — using silence`);
  console.log(`[TTS] Using silent audio fallback for scene: ${sceneId}`);
  return generateSilentAudio(outputPath, silenceDuration);
}

