import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ffmpeg from 'ffmpeg-static';

const execAsync = promisify(exec);

let rembgRunning = false;

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

async function callSceneAnimatorV3(
  backgroundPath: string,
  characterPath: string,
  outputPath: string,
  duration: number,
  emotion: string = 'neutral',
  sceneType: string = 'street',
  _ffmpegPath: string,
  opts: {
    prevSceneType?: string;
    nextSceneType?: string;
    renderMode?: string;
    characterName?: string;
    audioPath?: string;
    partsDir?: string;
  } = {}
): Promise<boolean> {
  return new Promise((resolve) => {
    const useV4 = process.env.USE_METRO_V4 === 'true';
    // Doraemon Engine: cutout limited-animation path. Only active when the flag
    // is set AND the scene asked for it — otherwise behaviour is unchanged.
    const useDoraemon = process.env.USE_DORAEMON === 'true' && opts.renderMode === 'cutout';
    const scriptPath = path.join(
      process.cwd(),
      useDoraemon ? 'src/scripts/doraemon_engine.py'
        : useV4 ? 'src/scripts/metro_engine_v4.py'
        : 'src/scripts/scene_animator_v3.py'
    );
    const fps = (useV4 || useDoraemon) ? (process.env.METRO_V4_FPS || '24') : '12';
    const args = [
      scriptPath,
      '--background', backgroundPath,
      '--character',  characterPath,
      '--output',     outputPath,
      '--duration',   duration.toString(),
      '--emotion',    emotion,
      '--scene_type', sceneType,
      '--fps',        fps,
      '--width',      '1080',
      '--height',     '1920',
    ];
    if (useV4 || useDoraemon) {
      // Only forward scene types that Metro V4 has explicit transition rules for.
      // Generic pipeline types ('hook', 'build', 'cta', 'default') fall through to
      // choose_transition's default 'fade_black', creating unwanted dark frames.
      // Passing '' causes choose_transition to return None → hard cut, no fade.
      const V4_TRANSITION_TYPES = new Set(['street', 'black', 'grid', 'bedroom']);
      const prevT = V4_TRANSITION_TYPES.has(opts.prevSceneType || '') ? (opts.prevSceneType || '') : '';
      const nextT = V4_TRANSITION_TYPES.has(opts.nextSceneType || '') ? (opts.nextSceneType || '') : '';
      args.push('--prev_scene_type', prevT);
      args.push('--next_scene_type', nextT);
    }
    if (useDoraemon) {
      const charName = (opts.characterName || 'veer').toLowerCase();
      args.push('--character_name', charName);
      // Use caller-resolved parts dir (handles UUID-named dirs) or fall back to name-based.
      const resolvedPartsDir = opts.partsDir || path.join(process.cwd(), 'assets', 'characters', charName);
      args.push('--parts_dir', resolvedPartsDir);
      args.push('--render_mode', 'cutout');
      // Audio drives lip-sync; without it the engine renders a static wide shot.
      if (opts.audioPath && fs.existsSync(opts.audioPath)) {
        args.push('--audio', opts.audioPath);
      }
    }

    const engineLabel = useDoraemon ? 'Doraemon' : useV4 ? 'V4' : 'v3';
    console.log(`[SceneAnimV3] Starting Metro engine (${engineLabel}, ${fps}fps)`);
    console.log('[SceneAnimV3] Background:', path.basename(backgroundPath));
    console.log('[SceneAnimV3] Character:', characterPath ? path.basename(characterPath) : 'none (unified)');
    console.log('[SceneAnimV3] Duration:', duration, 's');
    console.log('[SceneAnimV3] Emotion:', emotion);

    const proc = spawn('py', args);
    let stderr = '';

    proc.stdout.on('data', (d) => { process.stdout.write(d); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => { proc.kill(); console.error('[SceneAnimV3] Timeout'); resolve(false); }, 900000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const exists = fs.existsSync(outputPath);
        const size   = exists ? fs.statSync(outputPath).size : 0;
        console.log('[SceneAnimV3] Complete.', Math.round(size / 1024), 'KB');
        resolve(exists && size > 10000);
      } else {
        console.error('[SceneAnimV3] Failed:', stderr.slice(-300));
        resolve(false);
      }
    });

    proc.on('error', (e) => { clearTimeout(timer); console.error('[SceneAnimV3] Spawn error:', e); resolve(false); });
  });
}

async function compositeCharacterOverBackground(
  backgroundPath: string,
  characterPngPath: string,
  outputPath: string,
  duration: number,
  ffmpegPath: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const args = [
      '-loop', '1', '-t', duration.toString(), '-i', backgroundPath,
      '-loop', '1', '-i', characterPngPath,
      '-filter_complex',
      '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[bg];' +
      '[1:v]scale=-1:1344:flags=lanczos[char];' +
      '[bg][char]overlay=x=(W-w)/2:y=H-h-80[composited]',
      '-map', '[composited]',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-r', '24',
      '-t', duration.toString(), '-y', outputPath,
    ];

    console.log('[Composite] Running FFmpeg overlay...');
    console.log('[Composite] Duration:', duration, 's');
    console.log('[Composite] Background:', path.basename(backgroundPath));
    console.log('[Composite] Character:', path.basename(characterPngPath));

    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        const exists = fs.existsSync(outputPath);
        const size = exists ? fs.statSync(outputPath).size : 0;
        console.log('[Composite] Success. Output size:', Math.round(size / 1024), 'KB');
        resolve(exists && size > 50000);
      } else {
        const lines = stderr.split('\n').filter(l => l.trim()).slice(-20).join('\n');
        console.error('[Composite] Failed:', lines);
        resolve(false);
      }
    });

    proc.on('error', (e) => { console.error('[Composite] Spawn:', e); resolve(false); });
    setTimeout(() => { proc.kill(); console.error('[Composite] Timeout'); resolve(false); }, 180000);
  });
}

async function mergeVideoAudio(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  ffmpegPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', videoPath, '-i', audioPath,
      '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k',
      '-shortest', '-y', outputPath,
    ];
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) { console.log('[MergeAudio] Complete:', path.basename(outputPath)); resolve(); }
      else reject(new Error('mergeVideoAudio failed: ' + stderr.slice(-500)));
    });
    proc.on('error', reject);
  });
}

async function callRembg(inputPath: string, outputPath: string): Promise<boolean> {
  // Serialize rembg calls — concurrent processes compete for CPU and time out
  while (rembgRunning) {
    await new Promise(r => setTimeout(r, 2000));
  }
  rembgRunning = true;
  try {
    return await new Promise((resolve) => {
      const scriptPath = path.join(process.cwd(), 'src/scripts/rembg_worker.py');
      console.log('[Rembg] Removing background:', path.basename(inputPath));

      const proc = spawn('py', [scriptPath, inputPath, outputPath]);
      let stderr = '';

      proc.stdout.on('data', (d) => console.log('[Rembg]', d.toString().trim()));
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code === 0) {
          const exists = fs.existsSync(outputPath);
          const size = exists ? fs.statSync(outputPath).size : 0;
          console.log('[Rembg] Complete. PNG size:', size, 'bytes');
          resolve(exists && size > 10000);
        } else {
          console.error('[Rembg] Failed:', stderr);
          resolve(false);
        }
      });

      proc.on('error', (e) => {
        console.error('[Rembg] Spawn error:', e);
        resolve(false);
      });

      setTimeout(() => { proc.kill(); console.error('[Rembg] Timeout after 60s'); resolve(false); }, 60000);
    });
  } finally {
    rembgRunning = false;
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

  if ((scene as any)?.background_path) {
    console.log('[RenderVisual] Background found — will composite in Stage 2:', (scene as any).background_path.slice(-40));
  }

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
          // Resolve NARRATOR flag once so every downstream guard can use it.
          const isNarratorScene = (scene?.character || '').toUpperCase() === 'NARRATOR';

          // Use passed-in audio duration (probed by orchestrator after TTS completes)
          const animatorDuration = (audioDuration && audioDuration > 0) ? audioDuration : duration;
          console.log('[RenderVisual] Animator duration:', animatorDuration, 'source:', audioDuration ? 'audio probe' : 'duration_target');

          console.log('[RenderVisual] animatedPath:', animatedPath.slice(-50));
          console.log('[RenderVisual] isTalking:', isTalking, 'audioPath:', audioPath ? audioPath.slice(-40) : 'NONE');
          // NARRATOR scenes skip the character animator — imagePath is the background itself.
          if (!isNarratorScene) {
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
          } // end !isNarratorScene

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

          // Stage 2 prep: ensure background file is local (re-download from Supabase if needed)
          if (scene?.background_url && scene?.background_path && !fs.existsSync(scene.background_path)) {
            console.log('[RenderVisual] Re-downloading background from Supabase');
            try {
              const bgDir = path.dirname(scene.background_path);
              if (!fs.existsSync(bgDir)) fs.mkdirSync(bgDir, { recursive: true });
              const bgResp = await fetch(scene.background_url);
              if (bgResp.ok) {
                fs.writeFileSync(scene.background_path, Buffer.from(await bgResp.arrayBuffer()));
                console.log('[RenderVisual] Background re-downloaded:', path.basename(scene.background_path));
              }
            } catch (dlErr: any) {
              console.warn('[RenderVisual] Background re-download failed:', dlErr?.message);
            }
          }

          // Stage 2 prep: run rembg if background_path exists
          // (skipped for unified scenes — the LoRA image already contains the
          // character in the scene, there is nothing to cut out)
          // (skipped for NARRATOR — no character to remove, imagePath IS the background)
          // (skipped for Doraemon cutout — engine uses parts dir, transparent_path is unused)
          const isDoraemonCutout = process.env.USE_DORAEMON === 'true' && scene?.render_mode === 'cutout';
          if (!scene?.unified && !isNarratorScene && !isDoraemonCutout && scene?.background_path && fs.existsSync(scene.background_path)) {
            const sceneId = scene.scene_id || visual.visual_id;
            const transparentPath = path.join(tmpDir, `${sceneId}_transparent.png`);
            if (!fs.existsSync(transparentPath)) {
              console.log('[RenderVisual] Running rembg for character transparency');
              const rembgSuccess = await callRembg(imagePath, transparentPath);
              if (rembgSuccess) {
                scene.transparent_path = transparentPath;
                console.log('[RenderVisual] Character transparent PNG ready');
              } else {
                console.log('[RenderVisual] Rembg failed — will use flat image fallback');
              }
            } else {
              scene.transparent_path = transparentPath;
              console.log('[RenderVisual] Transparent PNG cached — skipping rembg');
            }
          }

          // Cutout scenes (Doraemon Engine): render the talking-head / walk
          // limited-animation directly over the background from pre-built part
          // PNGs. Gated on USE_DORAEMON so the pipeline is untouched when off.
          if (process.env.USE_DORAEMON === 'true' && scene?.render_mode === 'cutout') {
            const cutoutChar = (scene.character || 'veer').toLowerCase();
            let cutoutPartsDir = path.join(process.cwd(), 'assets', 'characters', cutoutChar);
            // When the name-based folder exists but holds no PNGs (e.g. Nova whose
            // assets live under a UUID-named folder), resolve the character's UUID
            // from the universe and use that folder instead.
            if (fs.existsSync(cutoutPartsDir) &&
                !fs.readdirSync(cutoutPartsDir).some((f: string) => f.endsWith('.png'))) {
              const matchedChar = (project as any)?.universe?.characters
                ?.find((c: any) => c.name?.toLowerCase() === cutoutChar);
              if (matchedChar?.id) {
                const uuidDir = path.join(process.cwd(), 'assets', 'characters', matchedChar.id);
                if (fs.existsSync(uuidDir) && fs.readdirSync(uuidDir).some((f: string) => f.endsWith('.png'))) {
                  console.log(`[RenderVisual] Resolved "${cutoutChar}" parts from UUID dir: ${matchedChar.id}`);
                  cutoutPartsDir = uuidDir;
                }
              }
            }
            const hasCutoutParts = fs.existsSync(cutoutPartsDir) &&
              fs.readdirSync(cutoutPartsDir).some((f: string) => f.endsWith('.png'));
            const cutoutBg = (scene.background_path && fs.existsSync(scene.background_path))
              ? scene.background_path : imagePath;
            if (!hasCutoutParts) {
              console.warn(`[RenderVisual] Cutout requested for "${scene.character}" but parts dir not found or empty (${cutoutPartsDir}) — falling back to generative render`);
            } else if (cutoutBg && fs.existsSync(cutoutBg)) {
              console.log('[RenderVisual] Cutout scene: rendering with Doraemon Engine');
              const sceneId = scene.scene_id || visual.visual_id;
              const cutoutPath = path.join(tmpDir, `${sceneId}_composited.mp4`);
              const cutoutSuccess = await callSceneAnimatorV3(
                cutoutBg, '', cutoutPath,
                audioDuration && audioDuration > 0 ? audioDuration : duration,
                scene.emotion || 'neutral',
                scene.scene_type || 'street',
                ffmpeg as string,
                {
                  prevSceneType: scene.prev_scene_type,
                  nextSceneType: scene.next_scene_type,
                  renderMode: scene.render_mode,
                  characterName: scene.character,
                  partsDir: cutoutPartsDir,
                  audioPath: scene.narration_path,
                }
              );
              if (cutoutSuccess) {
                fs.copyFileSync(cutoutPath, outputPath);
                scene.rendered_path = outputPath;
                try {
                  if (fs.existsSync(animatedPath)) fs.unlinkSync(animatedPath);
                  if (fs.existsSync(cutoutPath)) fs.unlinkSync(cutoutPath);
                } catch { /* non-fatal */ }
                console.log('[RenderVisual] Cutout render complete');
                return outputPath;
              }
              console.log('[RenderVisual] Cutout render failed — falling back to Stage 1/2');
            }
          }

          // Unified scenes (Metro V4): the LoRA image IS the full scene —
          // animate it directly with no character layer.
          // Also covers NARRATOR scenes where imagePath was set to background_path
          // and scene.unified was flagged by the orchestrator.
          if (scene?.unified && process.env.USE_METRO_V4 === 'true' && imagePath && fs.existsSync(imagePath)) {
            const unifiedLabel = isNarratorScene ? 'NARRATOR background-only' : 'Unified full-scene LoRA';
            console.log(`[RenderVisual] ${unifiedLabel}: animating with Metro V4 (no character layer)`);
            const sceneId = scene.scene_id || visual.visual_id;
            const unifiedPath = path.join(tmpDir, `${sceneId}_composited.mp4`);
            const unifiedSuccess = await callSceneAnimatorV3(
              imagePath, '', unifiedPath,
              audioDuration && audioDuration > 0 ? audioDuration : duration,
              scene.emotion || 'neutral',
              scene.scene_type || 'street',
              ffmpeg as string,
              {
                prevSceneType: scene.prev_scene_type,
                nextSceneType: scene.next_scene_type,
                renderMode: scene.render_mode,
                characterName: scene.character,
                audioPath: scene.narration_path,
              }
            );
            if (unifiedSuccess) {
              fs.copyFileSync(unifiedPath, outputPath);
              scene.rendered_path = outputPath;
              try {
                if (fs.existsSync(animatedPath)) fs.unlinkSync(animatedPath);
                if (fs.existsSync(unifiedPath)) fs.unlinkSync(unifiedPath);
              } catch { /* non-fatal */ }
              console.log('[RenderVisual] Unified render complete');
              return outputPath;
            }
            console.log('[RenderVisual] Unified render failed — falling back to Stage 1/2');
          }

          // Stage 2 compositing decision
          if (scene?.transparent_path && fs.existsSync(scene.transparent_path) &&
              scene?.background_path && fs.existsSync(scene.background_path)) {
            console.log('[RenderVisual] Stage 2: compositing character over background');
            const sceneId = scene.scene_id || visual.visual_id;
            const compositedPath = path.join(tmpDir, `${sceneId}_composited.mp4`);
            const ffmpegBin = ffmpeg as string;
            const compositeSuccess = await callSceneAnimatorV3(
              scene.background_path, scene.transparent_path, compositedPath,
              audioDuration && audioDuration > 0 ? audioDuration : duration,
              scene.emotion || 'neutral',
              scene.scene_type || 'street',
              ffmpegBin,
              {
                prevSceneType: scene.prev_scene_type,
                nextSceneType: scene.next_scene_type,
                renderMode: scene.render_mode,
                characterName: scene.character,
                audioPath: scene.narration_path,
              }
            );
            if (compositeSuccess) {
              console.log('[RenderVisual] Composite succeeded — writing to output');
              // renderVisualClip returns video-only; assembleSceneSegment adds audio downstream.
              // mergeVideoAudio is available for direct use if the caller needs a self-contained clip.
              fs.copyFileSync(compositedPath, outputPath);
              scene.rendered_path = outputPath;
              // Clean up intermediate files
              try {
                if (fs.existsSync(animatedPath)) fs.unlinkSync(animatedPath);
                if (fs.existsSync(compositedPath)) fs.unlinkSync(compositedPath);
              } catch { /* non-fatal */ }
              console.log('[RenderVisual] Stage 2 render complete');
            } else {
              console.log('[RenderVisual] Composite failed — falling back to Stage 1');
              // Fall through to Stage 1 below
              if (animatorSucceeded) {
                fs.copyFileSync(animatedPath, outputPath);
                fs.promises.unlink(animatedPath).catch(() => {});
              } else {
                const storedPreset = project?.settings?.exportPreset;
                const preset = isPreview ? 'ultrafast' : (storedPreset || 'fast');
                const qualityFlags = isPreview ? '' : is4k ? '-crf 18 -b:v 8M' : '-crf 20 -b:v 4M';
                await guardedExec(`"${ffmpeg}" -loop 1 -i "${imagePath}" -c:v libx264 -preset ${preset} ${qualityFlags} -r 30 -t ${duration} -pix_fmt yuv420p -vf "${filter}" -y "${outputPath}"`, signal);
              }
            }
          } else if (animatorSucceeded) {
            // Stage 1: animator output
            fs.copyFileSync(animatedPath, outputPath);
            console.log('[RenderVisual] Stage 1: using animator output directly — Ken Burns skipped');
            fs.promises.unlink(animatedPath).catch(() => {});
          } else {
            // Stage 1: Ken Burns fallback
            console.log('[RenderVisual] Stage 1: applying Ken Burns fallback');
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

  // Two command variants:
  // audioValid=true  → silenceremove strips TTS trailing silence (Piper adds 0.33–0.57s/clip),
  //                    apad=0.1 adds a consistent 100ms tail, -shortest ends at padded audio end.
  // audioValid=false → generated anullsrc silence: silenceremove would eat it all, so fall
  //                    back to -t so the silent segment lasts exactly the scene's target duration.
  const audioFilterChain = audioValid
    ? `-af "asetpts=PTS-STARTPTS,silenceremove=stop_periods=-1:stop_duration=0.05:stop_threshold=-40dB,apad=pad_dur=0.1"`
    : `-af asetpts=PTS-STARTPTS`;
  const durationArg = audioValid ? `-shortest` : `-t ${outputDuration}`;

  try {
     await guardedExec(`"${ffmpeg}" -stream_loop -1 -i "${visualPath}" ${audioInputArg} -vf setpts=PTS-STARTPTS ${audioFilterChain} -c:v libx264 -preset fast -crf 20 ${audioOutputOpts} ${durationArg} -y "${outputPath}"`, signal);
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
Style: Default,Arial,34,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,1,2,80,80,120,1

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
  console.log('[Stitch] Concat list contents:\n', fs.readFileSync(listFile, 'utf8'));

  try {
     const stitchCmd = `"${ffmpeg}" -f concat -safe 0 -i "${listFile}" -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" -vsync cfr -c:v libx264 -preset fast -crf 20 -c:a aac -ar 44100 -ac 2 -b:a 192k -y "${outputPath}"`;
     console.log('[Stitch] FFmpeg command:', stitchCmd);
     await guardedExec(stitchCmd, signal);
     try {
       const { stdout: probeDur } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${outputPath}"`, { timeout: 10000 });
       console.log('[Stitch] Output duration:', probeDur.trim(), 'seconds');
     } catch { console.warn('[Stitch] Could not probe output duration'); }

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

