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

export const renderVisualClip = async (visual: any, project: any, signal?: AbortSignal) => {
  const tmpDir = path.join(os.tmpdir(), 'ais-renderer');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  
  const outputPath = path.join(tmpDir, `${project.project_id}_visual_${visual.visual_id}.mp4`);
  if (fs.existsSync(outputPath)) return outputPath;

  const duration = visual.duration_target || 5;
  let imagePath = visual.asset_path;
  
  try {
     if (imagePath) {
        if (imagePath.startsWith('http')) {
            const dlPath = path.join(tmpDir, `dl_${visual.visual_id}.png`);
            if (signal?.aborted) throw new Error('PIPELINE_CANCELLED');
            const res = await fetch(imagePath, { signal: signal as any });
            const buf = await res.arrayBuffer();
            fs.writeFileSync(dlPath, Buffer.from(buf));
            imagePath = dlPath;
        }

        if (fs.existsSync(imagePath)) {
          // If the asset is already a video
          if (imagePath.endsWith('.mp4')) {
             return imagePath; // We can use it directly or re-encode it? For now, assume it's good.
          }

          // Create video from image!
          const fps = 30;
          const frames = Math.ceil(duration * fps);
          const isPreview = project?.quality === 'draft' || project?.preview_mode || false;
          const is4k = project?.settings?.exportResolution === '4k' && !isPreview;
          const isShorts = project?.settings?.aspectRatio === '9:16';

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

          const storedPreset = project?.settings?.exportPreset;
          const preset = isPreview ? 'ultrafast' : (storedPreset || 'fast');
          const qualityFlags = isPreview ? '' : is4k ? '-crf 18 -b:v 8M' : '-crf 20 -b:v 4M';
          await guardedExec(`"${ffmpeg}" -loop 1 -i "${imagePath}" -c:v libx264 -preset ${preset} ${qualityFlags} -r 30 -t ${duration} -pix_fmt yuv420p -vf "${filter}" -y "${outputPath}"`, signal);
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

async function getAudioDuration(audioPath: string): Promise<number> {
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
  
  if (!scene.visuals || !scene.visuals[0] || !scene.visuals[0].rendered_path) return audioPath;

  const visualPath = scene.visuals[0].rendered_path;

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

  const audioInput = audioValid
    ? `-i "${audioPath}" -c:a aac -ar 44100 -ac 2 -b:a 192k`
    : `-f lavfi -i anullsrc=r=44100:cl=stereo -c:a aac -ar 44100 -ac 2 -b:a 192k`;

  try {
     // -stream_loop -1 loops the visual if audio is longer than the rendered clip
     // -t ${outputDuration} cuts output at exact audio length (replaces -shortest)
     await guardedExec(`"${ffmpeg}" -stream_loop -1 -i "${visualPath}" ${audioInput} -c:v copy -t ${outputDuration} -y "${outputPath}"`, signal);
     return outputPath;
  } catch(e: any) {
     if (e.message === 'PIPELINE_CANCELLED') throw e;
     console.error('assembly ffmpeg failed', e);
     return visualPath;
  }
};

export const renderCaptions = async (scene: any, signal?: AbortSignal) => {
  if (!scene.segment_path || !scene.caption_chunks || scene.caption_chunks.length === 0) {
    return scene.segment_path;
  }

  const inputPath = scene.segment_path;
  const outputPath = inputPath.replace('_segment.mp4', '_captioned.mp4');
  if (fs.existsSync(outputPath)) return outputPath;

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };

  let srt = '';
  scene.caption_chunks.forEach((chunk: any, index: number) => {
    srt += `${index + 1}\n${formatTime(chunk.start)} --> ${formatTime(chunk.end)}\n${chunk.text}\n\n`;
  });

  const srtPath = inputPath.replace('_segment.mp4', '_captions.srt');
  fs.writeFileSync(srtPath, srt);

  const escSrt = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:');
  const style = 'FontSize=20,FontName=Arial,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=4,Shadow=2,Alignment=2,MarginV=80';
  const subtitleFilter = `subtitles='${escSrt(srtPath)}':force_style='${style}'`;

  try {
    const isPreview = scene.quality === 'draft' || scene.preview_mode || false;
    const preset = isPreview ? 'ultrafast' : 'fast';
    await guardedExec(`"${ffmpeg}" -i "${inputPath}" -vf "${subtitleFilter}" -c:v libx264 -preset ${preset} -crf 18 -b:v 4M -c:a copy -y "${outputPath}"`, signal);
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
    const scenePath = scene.rendered_path || scene.video_path;
    if (scenePath) {
      listContent += `file '${scenePath.replace(/'/g, "'\\''")}'\n`;
    }
  }
  
  fs.writeFileSync(listFile, listContent);
  
  try {
     await guardedExec(`"${ffmpeg}" -f concat -safe 0 -i "${listFile}" -c copy -y "${outputPath}"`, signal);

     if (project?.music_track) {
       const musicDir = process.env.MUSIC_DIR || path.join(process.cwd(), 'music');
       const musicPath = path.join(musicDir, project.music_track);
       if (fs.existsSync(musicPath)) {
         const volume = Number(project.music_volume ?? 0.08).toFixed(2);
         const outputWithMusic = path.join(tmpDir, `final_music_${Date.now()}.mp4`);
         try {
           await guardedExec(
             `"${ffmpeg}" -i "${outputPath}" -stream_loop -1 -i "${musicPath}" -filter_complex "[1:a]volume=${volume}[bg];[0:a][bg]amix=inputs=2:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -ar 44100 -ac 2 -b:a 192k -y "${outputWithMusic}"`,
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

