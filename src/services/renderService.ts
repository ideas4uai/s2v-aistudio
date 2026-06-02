import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ffmpeg from 'ffmpeg-static';

const execAsync = promisify(exec);

/**
 * Executes a command but allows it to be aborted via signal.
 */
async function guardedExec(command: string, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('ABORTED');
  
  return new Promise((resolve, reject) => {
    const process = exec(command, { signal }, (error, stdout, stderr) => {
      if (error) {
        if (error.name === 'AbortError') {
          reject(new Error('PIPELINE_CANCELLED'));
        } else {
          reject(error);
        }
      } else {
        resolve({ stdout, stderr });
      }
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        process.kill('SIGKILL');
      }, { once: true });
    }
  });
}

async function callAnimator(
  config: Record<string, any>
): Promise<string | null> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  const configPath = path.join(
    os.tmpdir(),
    `animator_config_${Date.now()}.json`
  );
  console.log('[Animator] callAnimator called');
  console.log('[Animator] config:', JSON.stringify(config).slice(0, 100));
  try {
    await fs.promises.writeFile(configPath, JSON.stringify(config));

    const pythonCmd = process.platform === 'win32' ? 'py' : 'python3';
    console.log('[Animator] pythonCmd:', pythonCmd);
    try {
      const { execFileSync } = await import('child_process');
      execFileSync(pythonCmd, ['-c', 'import cv2'], { timeout: 5000 });
      console.log('[Animator] cv2 confirmed available');
    } catch {
      console.warn('[Animator] cv2 not available, will use Ken Burns fallback');
    }

    const scriptPath = path.join(
      process.cwd(), 'src', 'scripts', 'animator.py'
    );
    console.log('[Animator] scriptPath exists:', fs.existsSync(scriptPath), scriptPath);

    const { stdout } = await execFileAsync(
      pythonCmd,
      [scriptPath, configPath],
      { timeout: 120000 }
    );

    const result = JSON.parse(stdout.trim());
    if (result.error) throw new Error(result.error);
    return config.output;
  } catch (err: any) {
    console.warn('[Animator] Python animation failed, using Ken Burns fallback:', err.message?.split('\n')[0]);
    return null;
  } finally {
    fs.promises.unlink(configPath).catch(() => {});
  }
}

async function renderMultiFrameVisual(visual: any, project: any, signal?: AbortSignal): Promise<string> {
  const tmpDir = path.join(os.tmpdir(), 'ais-renderer');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const outputPath = path.join(tmpDir, `${visual.visual_id}_multiframe.mp4`);
  if (fs.existsSync(outputPath)) return outputPath;

  const frameClips: string[] = [];
  for (const frame of visual.frames!) {
    const frameVisual = {
      ...visual,
      visual_id: frame.frame_id,
      asset_path: frame.asset_path,
      duration_target: frame.duration,
      motion_instruction: frame.motion,
      frames: undefined,
    };
    const clip = await renderVisualClip(frameVisual, project, signal);
    if (clip) frameClips.push(clip);
  }

  if (frameClips.length === 0) return '';
  if (frameClips.length === 1) return frameClips[0];

  const listPath = path.join(tmpDir, `${visual.visual_id}_frames.txt`);
  fs.writeFileSync(listPath, frameClips.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));

  await guardedExec(
    `"${ffmpeg}" -f concat -safe 0 -i "${listPath}" -c copy -y "${outputPath}"`,
    signal
  );
  return outputPath;
}

async function ensureLocalImage(
  imagePath: string,
  tempDir: string,
  uniqueId: string,
  signal?: AbortSignal
): Promise<string> {
  if (!imagePath.startsWith('http')) return imagePath;
  const ext = imagePath.includes('.png') ? '.png' : '.jpg';
  const localPath = path.join(tempDir, `${uniqueId}_ref${ext}`);
  if (fs.existsSync(localPath)) return localPath;
  console.log('[RenderService] Downloading reference image to local temp:', imagePath.slice(-40));
  const response = await fetch(imagePath, signal ? { signal: signal as any } : {});
  if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(localPath, buffer);
  console.log('[RenderService] Downloaded:', localPath, buffer.length, 'bytes');
  return localPath;
}

export const renderVisualClip = async (visual: any, project: any, signal?: AbortSignal, scene?: any, audioDuration?: number) => {
  if (visual.frames && visual.frames.length > 1) {
    return renderMultiFrameVisual(visual, project, signal);
  }

  const tmpDir = path.join(os.tmpdir(), 'ais-renderer');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const outputPath = path.join(tmpDir, `${project.project_id}_visual_${visual.visual_id}.mp4`);
  if (fs.existsSync(outputPath)) return outputPath;

  const duration = visual.duration_target || 5;
  let imagePath = visual.asset_path;

  try {
     if (imagePath) {
        if (signal?.aborted) throw new Error('PIPELINE_CANCELLED');
        imagePath = await ensureLocalImage(imagePath, tmpDir, visual.visual_id, signal);

        if (fs.existsSync(imagePath)) {
          // If the asset is already a video
          if (imagePath.endsWith('.mp4')) {
             return imagePath; // We can use it directly or re-encode it? For now, assume it's good.
          }

          const emotion = (visual as any).emotion || 'neutral';
          const isTalking = scene?.narration_text?.length > 0;
          const isAction = ['excited', 'angry', 'surprised'].includes(emotion);
          const animatedPath = path.join(tmpDir, `${visual.visual_id}_animated.mp4`);
          const audioPath = scene?.narration_path;
          const localAudioPath = audioPath;

          // Use passed-in audio duration (probed by orchestrator after TTS completes)
          const animatorDuration = (audioDuration && audioDuration > 0) ? audioDuration : duration;
          console.log('[RenderVisual] Animator duration:', animatorDuration, 'source:', audioDuration ? 'audio probe' : 'duration_target');

          console.log('[RenderVisual] animatedPath:', animatedPath.slice(-50));
          console.log('[RenderVisual] isTalking:', isTalking, 'audioPath:', audioPath ? audioPath.slice(-40) : 'NONE');
          // Always use breathing — talking effect assumes close-up face, not full-body character images
          console.log('[RenderVisual] Calling callAnimator — effect: breathing');
          await callAnimator({
            effect: 'breathing',
            input: imagePath,
            output: animatedPath,
            duration: animatorDuration
          });

          if (emotion !== 'neutral' && emotion !== 'informative') {
            await callAnimator({
              effect: 'emotion',
              input: imagePath,
              output: path.join(tmpDir, `${visual.visual_id}_sym.png`),
              emotion: emotion,
              duration: duration
            });
          }

          if (isAction) {
            await callAnimator({
              effect: 'speed_lines',
              input: imagePath,
              output: path.join(tmpDir, `${visual.visual_id}_action.mp4`),
              duration: 1.5
            });
          }

          // Create video from image!
          const fps = 30;
          const frames = Math.ceil(duration * fps);
          const isPreview = project?.quality === 'draft' || project?.preview_mode || false;
          const is4k = project?.settings?.exportResolution === '4k' && !isPreview;
          const isShorts = project?.settings?.aspectRatio === '9:16'
            || !!project?.universe
            || project?.projectType === 'story_episode';

          const w = isPreview ? (isShorts ? 720  : 1280)
                  : is4k      ? (isShorts ? 2160 : 3840)
                  :              (isShorts ? 1080 : 1920);
          const h = isPreview ? (isShorts ? 1280 : 720)
                  : is4k      ? (isShorts ? 3840 : 2160)
                  :              (isShorts ? 1920 : 1080);

          // For 4K use explicit output dimensions; for 1080p scale to 4000px on the long axis for Ken Burns headroom
          const scaleFilter = is4k
            ? (isShorts ? 'scale=2160:3840' : 'scale=3840:2160')
            : (isShorts ? 'scale=-1:4000'   : 'scale=4000:-1');
          const zoomIncrement = (0.1 / frames).toFixed(6);
          const motion = visual.motion_instruction || 'zoom_in';
          let zoompanExpr: string;
          switch (motion) {
            case 'zoom_out':
              zoompanExpr = `z='if(eq(on,0),1.1,max(zoom-${zoomIncrement},1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
              break;
            case 'pan_right':
              zoompanExpr = `z='1.05':x='(iw-iw/zoom)*(on/${frames})':y='ih/2-(ih/zoom/2)'`;
              break;
            case 'pan_left':
              zoompanExpr = `z='1.05':x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)'`;
              break;
            case 'zoom_in':
            default:
              zoompanExpr = `z='min(zoom+${zoomIncrement},1.1)':x='iw/2-(iw/zoom/2)+sin(on/${frames})*20':y='ih/2-(ih/zoom/2)'`;
              break;
          }
          const filter = `${scaleFilter},zoompan=${zoompanExpr}:d=${frames}:s=${w}x${h}:fps=30,trim=duration=${duration}`;

          let animatorSucceeded = fs.existsSync(animatedPath) && fs.statSync(animatedPath).size >= 1000;
          if (fs.existsSync(animatedPath) && !animatorSucceeded) {
            console.warn('[RenderVisual] Animator output missing or empty — falling back to Ken Burns');
          }
          console.log('[RenderVisual] animatorSucceeded:', animatorSucceeded, '— using', animatorSucceeded ? 'animator output directly' : 'Ken Burns fallback');

          if (animatorSucceeded) {
            fs.copyFileSync(animatedPath, outputPath);
            console.log('[RenderVisual] Using animator output directly — Ken Burns skipped');
            fs.promises.unlink(animatedPath).catch(() => {});
          } else {
            console.log('[RenderVisual] Animator not used — applying Ken Burns fallback');
            const storedPreset = project?.settings?.exportPreset;
            const preset = isPreview ? 'ultrafast' : (storedPreset || 'fast');
            const qualityFlags = isPreview ? '' : is4k ? '-crf 18 -b:v 8M' : '-crf 20 -b:v 4M';
            await guardedExec(`"${ffmpeg}" -loop 1 -i "${imagePath}" -c:v libx264 -preset ${preset} ${qualityFlags} -r 30 -t ${duration} -pix_fmt yuv420p -vf "${filter}" -y "${outputPath}"`, signal);
          }
        } else {
           const fallbackRes = project?.settings?.aspectRatio === '9:16' ? '1080x1920' : '1920x1080';
           await guardedExec(`"${ffmpeg}" -f lavfi -i color=c=blue:s=${fallbackRes}:d=${duration} -y -c:v libx264 -pix_fmt yuv420p "${outputPath}"`, signal);
        }
     } else {
         const fallbackRes = project?.settings?.aspectRatio === '9:16' ? '1080x1920' : '1920x1080';
         await guardedExec(`"${ffmpeg}" -f lavfi -i color=c=blue:s=${fallbackRes}:d=${duration} -y -c:v libx264 -pix_fmt yuv420p "${outputPath}"`, signal);
     }
     return outputPath;
  } catch(e: any) {
     if (e.message === 'PIPELINE_CANCELLED' || e.name === 'AbortError') throw new Error('PIPELINE_CANCELLED');
     console.error('ffmpeg renderVisualClip failed', e);
     return "";
  }
};

export const validateVisualClip = async (visual: any) => {};

export async function getAudioDuration(audioPath: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`,
      { timeout: 10000 }
    );
    const dur = parseFloat(stdout.trim());
    if (!isNaN(dur) && dur > 0) return dur;
  } catch {}
  // ffmpeg fallback: probing with no output writes Duration to stderr and exits non-zero
  try {
    await execAsync(`"${ffmpeg}" -i "${audioPath}"`, { timeout: 10000 });
  } catch (e: any) {
    const info = String(e.stderr || '') + String(e.message || '');
    const m = info.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (m) return +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
  }
  return -1;
}

export const assembleSceneSegment = async (scene: any, audioPath: any, cacheKey: any, signal?: AbortSignal) => {
  const tmpDir = path.join(os.tmpdir(), 'ais-renderer');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const outputPath = path.join(tmpDir, `${scene.scene_id}_segment.mp4`);
  
  const visualPath = (scene.visuals?.[0] as any)?.rendered_path;
  if (!visualPath || !fs.existsSync(visualPath)) {
    console.error('[RenderService] No rendered visual for scene:', scene.scene_id, 'visual path:', visualPath);
    return '';
  }

  const audioValid = (() => {
    try { return audioPath && fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000; }
    catch { return false; }
  })();

  const fallbackDuration = scene.duration_target || 5;

  // Probe actual audio duration so video matches narration length exactly
  let outputDuration = fallbackDuration;
  if (audioValid) {
    const probed = await getAudioDuration(audioPath);
    if (probed > 0) {
      outputDuration = probed;
      scene.duration_actual = probed;
      console.log(`[RenderService] Scene ${scene.scene_id} audio duration: ${probed.toFixed(3)}s`);
    }
  } else {
    console.warn(`[RenderService] Audio invalid or missing for scene ${scene.scene_id} — using generated silence`);
  }

  const audioInputArg = audioValid
    ? `-i "${audioPath}"`
    : `-f lavfi -i anullsrc=r=44100:cl=stereo`;
  const audioOutputOpts = audioValid
    ? '-c:a aac -ar 44100 -ac 2 -b:a 192k'
    : '-c:a aac';

  try {
     await guardedExec(`"${ffmpeg}" -stream_loop -1 -i "${visualPath}" ${audioInputArg} -vf setpts=PTS-STARTPTS -af asetpts=PTS-STARTPTS -c:v libx264 -preset fast -crf 20 ${audioOutputOpts} -t ${outputDuration} -y "${outputPath}"`, signal);
     return outputPath;
  } catch(e: any) {
     if (e.message === 'PIPELINE_CANCELLED') throw e;
     console.error('assembly ffmpeg failed', e);
     return visualPath;
  }
};

export const renderCaptions = async (scene: any, signal?: AbortSignal) => {
  console.log('[Captions] Starting for scene:', scene.scene_id, 'chunks:', scene.caption_chunks?.length ?? 0, 'segment_path:', scene.segment_path?.slice(-40));
  if (!scene.segment_path || !scene.caption_chunks || scene.caption_chunks.length === 0) {
    return scene.segment_path;
  }

  const inputPath = scene.segment_path;
  const outputPath = inputPath.replace('_segment.mp4', '_captioned.mp4');
  if (fs.existsSync(outputPath)) return outputPath;

  const toAssTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.floor((seconds % 1) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  };

  const assHeader = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,1,2,80,80,120,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;

  // Split long chunks into 2-3 word groups for mobile readability
  const wordChunks: { start: number; end: number; text: string }[] = [];
  for (const chunk of scene.caption_chunks) {
    const words = String(chunk.text).trim().split(/\s+/);
    if (words.length <= 3) { wordChunks.push(chunk); continue; }
    const groups: string[] = [];
    for (let i = 0; i < words.length; i += 3) groups.push(words.slice(i, i + 3).join(' '));
    const groupDur = (chunk.end - chunk.start) / groups.length;
    groups.forEach((text, i) => wordChunks.push({ start: chunk.start + i * groupDur, end: chunk.start + (i + 1) * groupDur, text }));
  }

  const assEvents = wordChunks.map((chunk) => {
    const start = toAssTime(chunk.start);
    const end = toAssTime(chunk.end);
    const text = chunk.text.replace(/\n/g, '\\N');
    return `Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`;
  }).join('\n');

  const assPath = inputPath.replace('_segment.mp4', '_captions.ass');
  fs.writeFileSync(assPath, assHeader + assEvents, 'utf8');

  const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  const subtitleFilter = `ass='${escapedAss}'`;

  try {
    const isPreview = scene.quality === 'draft' || scene.preview_mode || false;
    const preset = isPreview ? 'ultrafast' : 'fast';
    await guardedExec(`"${ffmpeg}" -i "${inputPath}" -vf "${subtitleFilter}" -c:v libx264 -preset ${preset} -crf 18 -b:v 4M -c:a copy -y "${outputPath}"`, signal);
    console.log('[Captions] Output file exists:', fs.existsSync(outputPath), outputPath.slice(-40));
    return outputPath;
  } catch(e: any) {
    if (e.message === 'PIPELINE_CANCELLED') throw e;
    console.error('renderCaptions ffmpeg failed', e);
    return inputPath;
  }
};

export const stitchScenes = async (scenes: any, project: any, signal?: AbortSignal) => {
  if (!scenes || scenes.length === 0) return "";
  
  const projectId = project?.project_id || 'test';
  const tmpDir = path.join(os.tmpdir(), 'ais-renderer', projectId);
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const outputPath = path.join(tmpDir, `final_${new Date().getTime()}.mp4`);
  const listFile = path.join(tmpDir, `list_${new Date().getTime()}.txt`);
  
  let listContent = '';
  for (const scene of scenes) {
    const scenePath = (scene as any).segment_path || scene.rendered_path || scene.video_path;
    if (scenePath) {
      try {
        const { stdout } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${scenePath}"`, { timeout: 10000 });
        const dur = parseFloat(stdout.trim());
        console.log('[Stitch] Segment duration:', isNaN(dur) ? '?' : dur.toFixed(2) + 's', 'path:', scenePath.slice(-40));
      } catch {
        console.log('[Stitch] Could not probe:', scenePath.slice(-40));
      }
      listContent += `file '${scenePath.replace(/'/g, "'\\''")}'\n`;
    }
  }
  
  fs.writeFileSync(listFile, listContent);
  
  try {
     await guardedExec(`"${ffmpeg}" -fflags +genpts -f concat -safe 0 -i "${listFile}" -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS" -af asetpts=PTS-STARTPTS -c:v libx264 -preset fast -crf 20 -c:a aac -ar 44100 -ac 2 -b:a 192k -y "${outputPath}"`, signal);

     const musicTrack = project?.settings?.musicTrack || project?.music_track;
     const musicVolume = project?.settings?.musicVolume ?? project?.music_volume ?? 0.08;
     console.log('[Music] Track:', musicTrack, 'Volume:', musicVolume);
     if (musicTrack) {
       const musicDir = process.env.MUSIC_DIR || path.join(process.cwd(), 'music');
       const musicPath = path.join(musicDir, musicTrack);
       console.log('[Music] File exists:', fs.existsSync(musicPath), musicPath);
       if (fs.existsSync(musicPath)) {
         const volume = Number(musicVolume).toFixed(2);
         const outputWithMusic = path.join(tmpDir, `final_music_${Date.now()}.mp4`);
         try {
           await guardedExec(
             `"${ffmpeg}" -i "${outputPath}" -stream_loop -1 -i "${musicPath}" -filter_complex "[0:a]aformat=sample_rates=44100:channel_layouts=stereo[a0];[1:a]volume=${volume}[bg];[a0][bg]amix=inputs=2:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -ar 44100 -ac 2 -b:a 192k -y "${outputWithMusic}"`,
             signal
           );
           fs.promises.unlink(outputPath).catch(() => {});
           return outputWithMusic;
         } catch (musicErr: any) {
           console.warn('[Stitch] Music mix failed, using unmixed video:', musicErr?.message);
         }
       } else {
         console.warn(`[Stitch] Music file not found: ${musicPath}`);
       }
     }

     if (project) {
        project.output_path = `/api/assets/download?path=${encodeURIComponent(outputPath)}`;
     }

     return outputPath;
  } catch (e: any) {
     if (e.message === 'PIPELINE_CANCELLED') throw e;
     console.error('stitch ffmpeg failed', e);
     return (scenes[0].rendered_path || scenes[0].video_path) as string;
  }
};

