import { exec, spawn } from 'child_process';
import { upscaleImage, upscaleEnabled } from './upscale.js';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ffmpeg from 'ffmpeg-static';
import { generateCaptions } from './captionService.js';
import {
  planOverlay, sceneVisualKey, transitionBetween, transitionColor, type OverlayWord,
  OVERLAY_RESTATES_NARRATION, type OverlayKind,
} from './overlayPlan.js';
import { planSfxCues, renderSfxBed, sfxHeadroom, resolveSfxVolume } from './sfx.js';
import { arcPosition, NO_ARC } from './colourArc.js';
import { progressBus, ProgressStage } from '../server/progressBus.js';
import { getChannel as getChannelSync } from '../server/services/channelStore.js';

const execAsync = promisify(exec);

let rembgRunning = false;
// Same reason as rembgRunning: the Metro engine is internally parallel, so running
// several at once oversubscribes the machine rather than going faster.
let metroRunning = false;

/**
 * Whether a cached render output can still be trusted.
 *
 * True only when `output` exists AND is at least as new as every source that fed it.
 * The render pipeline caches almost every intermediate on disk, and an existence-only
 * check reuses work built from inputs that have since changed — a re-recorded voice, an
 * edited script, a regenerated image. That failure is silent and survives all the way to
 * the published file: it is how three "one TTS engine each" comparison renders shipped
 * identical narration from a week-old render.
 *
 * Sources that do not exist locally (an http asset URL, an optional input) are skipped
 * rather than treated as stale — something absent cannot have changed after the output.
 */
/**
 * Where a visual's rendered clip lives.
 *
 * The motion is part of the identity, not just an argument. Keyed on visual_id alone,
 * changing the Cinematic Effect on an existing project silently reused the clip with
 * the old movement: the still had not changed, so the mtime guard saw nothing stale.
 * Motion is not a file, so it cannot be caught by comparing timestamps — it has to be
 * in the name.
 */
export function visualClipPath(
  tmpDir: string, projectId: string, visualId: string, motion?: string, overlay?: string,
): string {
  // Same default as the render body below, or the path and the content disagree.
  const m = String(motion || 'zoom_in').replace(/[^a-z0-9_-]/gi, '');
  // The overlay is not a file either, so the same rule applies to it: a scene whose
  // kinetic text changed is not the clip already on disk. Empty when the scene has no
  // overlay, which keeps every existing project's path exactly as it was.
  const o = overlay ? `_${String(overlay).replace(/[^a-z0-9]/gi, '')}` : '';
  return path.join(tmpDir, `${projectId}_visual_${visualId}_${m}${o}.mp4`);
}

/**
 * Move a finished clip into place.
 *
 * Rename, not copy-then-delete. Every engine writes its clip under a working name and
 * then put it where the pipeline expects it, which meant writing the whole file a second
 * time — 210 MB of pure duplication on a five-scene episode, on a laptop disk. Falls back
 * to a copy if the two ever land on different volumes, where rename cannot work.
 */
function moveInto(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
    try { fs.unlinkSync(src); } catch { /* non-fatal */ }
  }
}

/**
 * Report a reuse-or-rebuild decision for live progress.
 *
 * Emitted from inside the functions that make the call, not from the caller. The caller
 * cannot know: renderVisualClip and assembleSceneSegment both check freshness internally
 * and return a cached path without doing any work, so announcing "regenerating" before
 * invoking them reported every cache hit as a 40-second render.
 */
function emitStep(project: any, scene: any, stage: ProgressStage, message: string, reused: boolean) {
  const projectId = project?.project_id;
  if (!projectId || !scene) return;
  const scenes = project?.scenes || [];
  const idx = scenes.findIndex((s: any) => s?.scene_id === scene.scene_id) + 1;
  progressBus.emit({
    projectId, stage, message, reused,
    sceneIndex: idx > 0 ? idx : undefined,
    sceneTotal: scenes.length || undefined,
  });
}

/**
 * The channel watermark for a project, or null when there is nothing to burn in.
 *
 * ── Where it goes, and why there ──────────────────────────────────────────────
 * Bottom LEFT. The other three candidates are taken:
 *   bottom-right   the entity-image attribution credit (0.96W, 0.982H) — a licence
 *                  requirement, so it cannot move and must not be covered
 *   bottom-centre  the captions (ASS Alignment 2, MarginV 22% of H)
 *   top            where kinetic text and the diagram/comparison overlays play
 * Bottom-left sits at the credit's own baseline, mirrored across the frame, ~20% of
 * the height below the caption band. Nothing else draws there.
 *
 * ── How big, how faint ───────────────────────────────────────────────────────
 * Deliberately the same restraint the credit already uses: alpha 0.30 against the
 * credit's 0.28, and 9% of frame width. On a 1080x1920 short that is a 97px logo at
 * just under a third opacity — legible when looked for, invisible when not, which is
 * the point of a watermark rather than a logo bug.
 */
export const WATERMARK = { widthFrac: 0.09, alpha: 0.30, marginXFrac: 0.04, bottomFrac: 0.982 };

export function channelWatermarkPath(project: any): string | null {
  const id = project?.channel_id;
  if (!id) return null;
  try {
    // Required lazily: renderService is imported by tests that never touch YouTube, and
    // the store reads config/ at call time rather than at module load.
    const rec = getChannelSync(id);
    if (rec?.logoPath && fs.existsSync(rec.logoPath)) return rec.logoPath;
  } catch { /* no channel store on this install */ }
  return null;
}

/**
 * The filter graph for one encode, with the watermark composited in if there is one.
 *
 * Returns the extra `-i` and a -filter_complex, or the plain -vf when there is no
 * watermark — an unbranded project must produce byte-comparable output to what it
 * produced before this existed, so the no-watermark path is left exactly as it was.
 *
 * The captions are applied AFTER the overlay so a watermark can never sit on top of a
 * caption, even if a future size change made the two regions meet.
 */
export function buildVideoFilter(
  logoPath: string | null, sizeFilter: string, assFilter: string, capW: number,
): { inputArg: string; filterArg: string; mapArgs: string } {
  if (!logoPath) {
    return {
      inputArg: '',
      filterArg: `-vf "setpts=PTS-STARTPTS${sizeFilter}${assFilter}"`,
      mapArgs: '',
    };
  }
  const w = Math.max(24, Math.round(capW * WATERMARK.widthFrac));
  const x = `${WATERMARK.marginXFrac}*W`;
  // Anchored by its BOTTOM edge at the same 0.982H the credit uses, so logos of
  // different aspect ratios all sit on one line rather than floating at different heights.
  const y = `${WATERMARK.bottomFrac}*H-h`;
  const ass = assFilter ? assFilter.replace(/^,/, '') : '';
  const chain = [
    `[2:v]scale=${w}:-1,format=rgba,colorchannelmixer=aa=${WATERMARK.alpha}[wm]`,
    `[0:v]setpts=PTS-STARTPTS${sizeFilter}[base]`,
    ass ? `[base][wm]overlay=${x}:${y}[ov];[ov]${ass}[v]` : `[base][wm]overlay=${x}:${y}[v]`,
  ].join(';');
  return {
    inputArg: `-i "${logoPath}"`,
    filterArg: `-filter_complex "${chain}"`,
    mapArgs: '-map "[v]" -map 1:a',
  };
}

export function isFreshOutput(output: string, ...sources: (string | undefined | null)[]): boolean {
  if (!fs.existsSync(output)) return false;
  const outputMtime = fs.statSync(output).mtimeMs;
  return sources.every((src) => {
    if (!src || !fs.existsSync(src)) return true;
    return fs.statSync(src).mtimeMs <= outputMtime;
  });
}

/** 9:16 projects: explicit aspect setting, universe shorts, or story episodes. */
export const isShortsProject = (project: any): boolean =>
  project?.settings?.aspectRatio === '9:16'
  || !!project?.universe
  || project?.projectType === 'story_episode';

/**
 * Final frame size for a project. exportResolution is '720p' | '1080p' | '4k';
 * preview renders are pinned to the 720 class whatever the setting says.
 */
export const outputResolution = (
  exportResolution: string | undefined,
  isShorts: boolean,
  isPreview = false
): { w: number; h: number } => {
  const [short, long] = (isPreview || exportResolution === '720p') ? [720, 1280]
    : exportResolution === '4k' ? [2160, 3840]
    : [1080, 1920];
  return isShorts ? { w: short, h: long } : { w: long, h: short };
};

/**
 * Executes a command but allows it to be aborted via signal.
 */
async function guardedExec(command: string, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('ABORTED');
  
  return new Promise((resolve, reject) => {
    // 64MB of room for output nobody reads. ffmpeg writes a progress line to stderr
    // for every frame, and Node's default 1MB cap does not truncate — it KILLS the
    // child and rejects with ERR_CHILD_PROCESS_STDIO_MAXBUFFER. So a segment encode
    // died purely for being long enough to be chatty, which made the failure look
    // like a codec problem and made it depend on scene duration.
    const process = exec(command, { signal, maxBuffer: 1 << 26 }, (error, stdout, stderr) => {
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
    width?: number;
    height?: number;
    /** Draft render: skip the depth-parallax pass, which is the engine's biggest cost. */
    draft?: boolean;
    /** 0 at the episode's open, 1 at its close; -1 for no colour arc. See colourArc.ts. */
    arcPos?: number;
    /** JSON motion-graphics spec. V4 only; absent means the clip renders as before. */
    overlayPath?: string;
    /**
     * Called with whether the engine actually drew the overlay.
     *
     * The caller used to infer this from `Boolean(overlayPath)` — i.e. from having
     * asked, not from it having happened. metro_engine_v4 loads the spec through
     * motion_overlay.load_overlay, which returns None (and says so) when PIL is
     * missing, no font resolves, or the spec is unrenderable, and then renders the
     * clip perfectly well without any overlay. Since the caption pass now stands
     * down where an overlay is drawn, guessing here would mute a beat that has no
     * overlay on it.
     */
    onOverlayDrawn?: (drawn: boolean) => void;
    /** Transition overrides. Must be symmetric with the neighbouring clip's opposite half. */
    inTransition?: string;
    outTransition?: string;
    transitionColor?: string;
  } = {}
): Promise<boolean> {
  // Serialize engine runs, for the same reason callRembg does: the engine splits
  // one clip across four worker processes, and the orchestrator renders scenes
  // three at a time. That is twelve CPU-bound processes plus a depth model on an
  // eight-thread laptop, and it does not go faster — it thrashes. Measured: with
  // every scene now unified (so every scene runs the engine, where before most
  // fell through to ffmpeg), the first batch of three hit the 15-minute timeout
  // and fell back to the 30fps Ken Burns path, which is how a render that was
  // meant to be 24fps came out at 30. Serialised, the same clip takes ~22s.
  while (metroRunning) {
    await new Promise((r) => setTimeout(r, 2000));
  }
  metroRunning = true;
  try {
    return await runSceneAnimator(backgroundPath, characterPath, outputPath, duration, emotion, sceneType, _ffmpegPath, opts);
  } finally {
    metroRunning = false;
  }
}

function runSceneAnimator(
  backgroundPath: string,
  characterPath: string,
  outputPath: string,
  duration: number,
  emotion: string,
  sceneType: string,
  _ffmpegPath: string,
  opts: Parameters<typeof callSceneAnimatorV3>[7] = {},
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
      '--width',      String(opts.width || 1080),
      '--height',     String(opts.height || 1920),
      '--arc',        String(opts.arcPos ?? NO_ARC),
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
    // V4 only: doraemon_engine.py and v3 have no --overlay and argparse would exit(2).
    if (useV4 && !useDoraemon && opts.overlayPath && fs.existsSync(opts.overlayPath)) {
      args.push('--overlay', opts.overlayPath);
    }
    if (useV4 && !useDoraemon) {
      if (opts.inTransition) args.push('--in_transition', opts.inTransition);
      if (opts.outTransition) args.push('--out_transition', opts.outTransition);
      if (opts.transitionColor) args.push('--transition_color', opts.transitionColor);
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

    // Depth parallax is the single most expensive thing the engine does. A draft
    // turns it off for this child only, leaving the operator's USE_DEPTH_PARALLAX
    // default untouched for final renders.
    const childEnv = opts.draft
      ? { ...process.env, USE_DEPTH_PARALLAX: 'false' }
      : process.env;
    if (opts.draft) console.log('[SceneAnimV3] Draft render — depth parallax disabled');

    const proc = spawn('py', args, { env: childEnv });
    let stderr = '';
    // load_overlay() prints "[Overlay] <kind> overlay, ..." only once it has a
    // renderable layer, and "Spec present but not renderable" when it does not.
    // Watching for the positive line is how we know rather than assume.
    let sawOverlay = false;

    proc.stdout.on('data', (d) => {
      process.stdout.write(d);
      if (/\[Overlay\] \w+ overlay,/.test(d.toString())) sawOverlay = true;
    });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => { proc.kill(); console.error('[SceneAnimV3] Timeout'); resolve(false); }, 900000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      opts.onOverlayDrawn?.(sawOverlay);
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

/**
 * Draw the overlay onto a clip the Metro engine did not render.
 *
 * Metro composites its overlay inline during frame synthesis, for free. Everything else
 * — the ffmpeg Ken Burns path, which is what a topic video with no character layer
 * actually uses — has no frame loop to hook into, so the overlay is drawn in a second
 * pass over the finished clip. That costs one decode/encode of a few seconds of video,
 * and only on the two or three scenes a plan gives an overlay to.
 *
 * Best-effort: a failure leaves the original clip in place rather than failing the scene.
 */
/**
 * Records the overlay that is actually on the clip, so the caption pass can stand
 * down for the window it occupies.
 *
 * Deliberately records the *outcome*, not the plan. The captions are the fallback:
 * if the engine did not draw the overlay, or the second pass produced nothing
 * usable, or the cutout path skipped it entirely, this stays unset and every cue
 * renders as normal. A beat can therefore lose its overlay and still have text —
 * what it can never do is show both.
 *
 * Written onto the scene, which is persisted, so a later run that reuses the cached
 * clip inherits what was true when that clip was made rather than guessing.
 */
function markOverlayDrawn(scene: any, spec: { kind: string; start: number; end: number } | null, drawn: boolean): void {
  if (!scene) return;
  if (spec && drawn) scene.overlay_drawn = { kind: spec.kind, start: spec.start, end: spec.end };
  else delete scene.overlay_drawn;
}

/** One frame at 24fps is 41.7ms, so a 40ms in-fade is complete by the next frame. */
const FADE_IN_MS = 40;
const FADE_OUT_MS = 90;

/**
 * Fade envelope for one caption cue, in milliseconds.
 *
 * Asymmetric on purpose. The fade started life symmetric at 110ms and put the
 * captions measurably behind the audio: on a real render the first cue was
 * scheduled at 0.231s — 19ms BEFORE the 0.250s speech onset detectSpeechSpan
 * measured, so the timing data was already right — and did not cross visibility
 * until 0.375s. That is 125ms late, past the +/-100ms tolerance the original
 * caption-sync work set, and on a 344ms cue it left only 124ms at full opacity.
 *
 * In fast so the cue lands on the word; out slow because that is the half that
 * actually stops three-word cues strobing, and being late to leave costs nothing.
 * Both scale down on short cues so a cue never spends more time fading than shown.
 */
export function cueFade(durationSec: number): { inMs: number; outMs: number } {
  const ms = Math.max(0, durationSec * 1000);
  return {
    inMs: Math.floor(Math.min(FADE_IN_MS, ms / 8)),
    outMs: Math.floor(Math.min(FADE_OUT_MS, ms / 4)),
  };
}

/**
 * The window where an overlay is already showing the narration, so captions must not.
 *
 * Reads `overlay_drawn`, which records what was actually rendered rather than what was
 * planned — see markOverlayDrawn. Null means "draw every cue", which is the safe
 * default and the reason a failed overlay can never leave a beat with no text at all.
 */
export function mutedCaptionWindow(scene: any): { start: number; end: number } | null {
  const drawn = scene?.overlay_drawn as { kind: OverlayKind; start: number; end: number } | undefined;
  if (!drawn || !OVERLAY_RESTATES_NARRATION.has(drawn.kind)) return null;
  if (!(drawn.end > drawn.start)) return null;
  return { start: drawn.start, end: drawn.end };
}

/** Returns whether the overlay actually made it onto the clip. */
async function compositeOverlay(clipPath: string, overlayPath: string, emotion: string): Promise<boolean> {
  const script = path.join(process.cwd(), 'src/scripts/motion_overlay.py');
  const withOverlay = clipPath.replace(/\.mp4$/, '.ovl.mp4');
  await new Promise<void>((resolve) => {
    const proc = spawn('py', [
      script, '--input', clipPath, '--spec', overlayPath,
      '--output', withOverlay, '--emotion', emotion || 'neutral',
    ]);
    proc.stdout.on('data', (d) => process.stdout.write(d));
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill(); resolve(); }, 300000);
    proc.on('close', () => { clearTimeout(timer); if (stderr) console.warn('[Overlay]', stderr.slice(-300)); resolve(); });
    proc.on('error', (e) => { clearTimeout(timer); console.warn('[Overlay] Spawn failed:', e.message); resolve(); });
  });
  if (fs.existsSync(withOverlay) && fs.statSync(withOverlay).size > 10000) {
    moveInto(withOverlay, clipPath);
    return true;
  }
  console.warn('[Overlay] Pass produced nothing usable — keeping the clip as rendered');
  try { if (fs.existsSync(withOverlay)) fs.unlinkSync(withOverlay); } catch { /* non-fatal */ }
  return false;
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

  // Project-prefixed like renderVisualClip's own output: visual ids are only unique
  // within a project, and duplicating a project copies its visuals verbatim.
  const projectId = project?.project_id || 'test';
  const outputPath = path.join(tmpDir, `${projectId}_${visual.visual_id}_multiframe.mp4`);
  // What this concat is actually built from is the per-frame clips below — frames carry a
  // prompt, not an asset_path, so guarding on asset_path alone would compare against
  // nothing and never invalidate. Both are passed: asset_path is set on some frame shapes,
  // and isFreshOutput ignores sources that aren't on disk.
  const frameSources = (visual.frames || []).flatMap((f: any) => [
    f.asset_path,
    visualClipPath(tmpDir, projectId, f.frame_id, f.motion),
  ]);
  if (isFreshOutput(outputPath, ...frameSources)) return outputPath;

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

  const listPath = path.join(tmpDir, `${projectId}_${visual.visual_id}_frames.txt`);
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

/** `WxH` string for the blue-slate fallback clips — same mapping as the real render. */
const fallbackSize = (project: any): string => {
  const isPreview = project?.quality === 'draft' || project?.preview_mode || false;
  const { w, h } = outputResolution(project?.settings?.exportResolution, isShortsProject(project), isPreview);
  return `${w}x${h}`;
};

export const renderVisualClip = async (visual: any, project: any, signal?: AbortSignal, scene?: any, audioDuration?: number) => {
  if (visual.frames && visual.frames.length > 1) {
    return renderMultiFrameVisual(visual, project, signal);
  }

  const tmpDir = path.join(os.tmpdir(), 'ais-renderer');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // The motion-graphics overlay for this scene, if the plan gives it one. Computed
  // before the freshness check because it is part of the clip's identity: see
  // visualClipPath. planOverlay returns null for most scenes, which is the point.
  const overlaySpec = scene
    ? planOverlay(scene, project, audioDuration || visual.duration_target || 5)
    : null;
  // The transitions on either side of this clip, decided from what the neighbouring
  // beats are doing. Both halves of one cut are computed from the same pair, so clip N
  // and clip N+1 agree without the engine having to check.
  const sceneList: any[] = project?.scenes || [];
  const sceneIdx = scene ? sceneList.findIndex((s: any) => s?.scene_id === scene.scene_id) : -1;
  const neighbourSpec = (j: number) => (sceneList[j]
    ? planOverlay(sceneList[j], project, audioDuration || visual.duration_target || 5) : null);
  const inTransition = sceneIdx > 0 ? transitionBetween(neighbourSpec(sceneIdx - 1), overlaySpec) : '';
  // Where this scene sits in the episode, for the colour arc. Same index the transitions
  // and the cache key are computed from, so the grade rides the same ordering the edit does.
  const arcPos = arcPosition(sceneIdx, sceneList.length);
  const outTransition = sceneIdx >= 0 ? transitionBetween(overlaySpec, neighbourSpec(sceneIdx + 1)) : '';
  const clipSeconds = audioDuration || visual.duration_target || 5;
  const outputPath = visualClipPath(
    tmpDir, String(project.project_id), visual.visual_id, visual.motion_instruction,
    scene ? sceneVisualKey(scene, project, clipSeconds) : '',
  );
  // Same staleness rule as the multi-frame path: a regenerated still must invalidate the
  // clip built from it, or an image edit never reaches the video. The motion lives in the
  // path itself, so changing the Cinematic Effect lands on a different file.
  if (isFreshOutput(outputPath, visual.asset_path)) {
    emitStep(project, scene, 'synthesis', 'Animation already rendered', true);
    return outputPath;
  }
  emitStep(project, scene, 'synthesis', 'Rendering animation', false);

  const duration = visual.duration_target || 5;
  let imagePath = visual.asset_path;

  // Sharpen the still before anything magnifies it. Off unless UPSCALE_IMAGES=true; see
  // upscale.ts for why (~195s per image on this GPU). Done here rather than at generation
  // so stills that already exist on disk are covered too, and so the mtime cache can skip
  // the work on every render after the first. A character scene also gets GFPGAN, decided
  // from the scene's own character field — the pipeline already knows who is on screen,
  // so no second face detector is introduced.
  if (upscaleEnabled()) {
    const hasFace = !!(scene as any)?.character && (scene as any).character !== 'NARRATOR';
    if (imagePath) imagePath = await upscaleImage(imagePath, { face: hasFace });
    if ((scene as any)?.background_path) {
      (scene as any).background_path =
        await upscaleImage((scene as any).background_path, { face: hasFace });
    }
  }

  // Written next to the clip it belongs to, under the same key, so two scenes never
  // share a spec file and a stale one can never be picked up by the wrong render.
  let overlayPath = '';
  // Metro composites the overlay during frame synthesis; the other paths need a second
  // pass at the end. This tracks which of the two happened.
  let engineDrewOverlay = false;
  if (overlaySpec) {
    overlayPath = path.join(tmpDir, `${project.project_id}_${visual.visual_id}_${sceneVisualKey(scene, project, clipSeconds)}.overlay.json`);
    fs.writeFileSync(overlayPath, JSON.stringify(overlaySpec), 'utf8');
    console.log(
      `[Overlay] Scene ${scene?.scene_id ?? '?'}: ${overlaySpec.kind}`,
      `${overlaySpec.start.toFixed(2)}s→${overlaySpec.end.toFixed(2)}s`,
      // Whatever this treatment actually puts on screen — the words list is empty for
      // the structured ones, and a log line reading `""` says nothing.
      overlaySpec.figure ? `figure "${overlaySpec.figure}"`
        : overlaySpec.steps ? `steps: ${overlaySpec.steps.map((s: OverlayWord) => s.text).join(' -> ')}`
        : overlaySpec.sides ? `sides: ${overlaySpec.sides.map((s: OverlayWord) => s.text).join(' | ')}`
        : overlaySpec.name ? `card "${overlaySpec.name}"`
        : `"${overlaySpec.words.map((w: OverlayWord) => w.text).join(' ')}"`,
    );
  }

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
          const isShorts = isShortsProject(project);

          const { w, h } = outputResolution(project?.settings?.exportResolution, isShorts, isPreview);

          // Metro/Doraemon engines always render at 1080p-class; only the aspect follows settings.
          // (Their --width/--height args are parsed but ignored — doraemon_engine.py
          // composites against module-level OUT_W/OUT_H.) assembleSceneSegment scales
          // the finished segment to w x h, so every path lands on the export resolution.
          const engineW = isShorts ? 1080 : 1920;
          const engineH = isShorts ? 1920 : 1080;

          // For 4K use explicit output dimensions; for 1080p scale to 4000px on the long axis for Ken Burns headroom.
          // Cover-crop to the output aspect first: zoompan stretches its crop window
          // to s=WxH, so any source aspect mismatch became visible distortion.
          const coverCrop = `crop='min(iw,ih*${w}/${h})':'min(ih,iw*${h}/${w})'`;
          // 4000px of headroom is wasted work when the output is 720-class — half it there.
          const kbLong = (isShorts ? h : w) >= 1920 ? 4000 : 2560;
          const scaleFilter = is4k
            ? (isShorts ? `scale=2160:3840:force_original_aspect_ratio=increase,${coverCrop}` : `scale=3840:2160:force_original_aspect_ratio=increase,${coverCrop}`)
            : (isShorts ? `scale=-1:${kbLong},${coverCrop}`   : `scale=${kbLong}:-1,${coverCrop}`);
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
                  width: engineW,
                  height: engineH,
                  draft: isPreview,
                arcPos,
                }
              );
              if (cutoutSuccess) {
                // The cutout engine is not given --overlay, so nothing was drawn:
                // record that plainly rather than letting a stale flag suppress captions.
                markOverlayDrawn(scene, overlaySpec, false);
                moveInto(cutoutPath, outputPath);
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
                width: engineW,
                height: engineH,
                draft: isPreview,
                arcPos,
                overlayPath,
                onOverlayDrawn: (drawn) => { engineDrewOverlay = drawn; },
                inTransition,
                outTransition,
                transitionColor: transitionColor(project),
              }
            );
            if (unifiedSuccess) {
              markOverlayDrawn(scene, overlaySpec, engineDrewOverlay);
              moveInto(unifiedPath, outputPath);
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
                width: engineW,
                height: engineH,
                draft: isPreview,
                arcPos,
                overlayPath,
                onOverlayDrawn: (drawn) => { engineDrewOverlay = drawn; },
                inTransition,
                outTransition,
                transitionColor: transitionColor(project),
              }
            );
            if (compositeSuccess) {
              console.log('[RenderVisual] Composite succeeded — writing to output');
              // renderVisualClip returns video-only; assembleSceneSegment adds audio downstream.
              // mergeVideoAudio is available for direct use if the caller needs a self-contained clip.
              moveInto(compositedPath, outputPath);
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
                moveInto(animatedPath, outputPath);
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
            moveInto(animatedPath, outputPath);
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
           await guardedExec(`"${ffmpeg}" -f lavfi -i color=c=blue:s=${fallbackSize(project)}:d=${duration} -y -c:v libx264 -pix_fmt yuv420p "${outputPath}"`, signal);
        }
     } else {
         await guardedExec(`"${ffmpeg}" -f lavfi -i color=c=blue:s=${fallbackSize(project)}:d=${duration} -y -c:v libx264 -pix_fmt yuv420p "${outputPath}"`, signal);
     }
     // Metro draws its own overlay inline; every other path needs the second pass.
     if (overlayPath && !engineDrewOverlay) {
       engineDrewOverlay = await compositeOverlay(outputPath, overlayPath, (visual as any).emotion || scene?.emotion || 'neutral');
     }
     markOverlayDrawn(scene, overlaySpec, engineDrewOverlay);
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

/**
 * Where the audible speech actually starts and ends inside an assembled segment.
 *
 * Captions must be spread over the speech, not over the whole segment. A segment is
 * `speech + target-length hold (pad_seconds) + apad tail`, all of which is silence
 * after the narration ends — spreading captions across it drags every caption after
 * the first progressively later than the words it is captioning.
 *
 * This has to be measured rather than derived: `silenceremove` strips an unknown
 * amount of internal silence before the padding is applied, so segment_duration minus
 * pad_seconds does not give the speech end (measured 4.40s by arithmetic vs 3.73s
 * actual on one test scene). Measure the file the captions are burned onto.
 */
const detectSpeechSpan = async (file: string, totalDuration: number): Promise<{ start: number; end: number }> => {
  const fallback = { start: 0, end: totalDuration };
  // Every return of `fallback` is a measurement that did not happen, and it is not a
  // harmless one: "the whole segment is speech" puts the first caption on the leading
  // silence and stretches the layout across a tail with no words in it. It used to be
  // silent, so a render that fell back looked exactly like one that measured — which
  // is how two scenes of nine shipped with speech 0.000→segment-end and their first
  // caption 0.24s early. Say which branch fired, always.
  const gaveUp = (why: string) => {
    console.warn(
      `[RenderService] Speech span not measurable on ${path.basename(file)} (${why}) — ` +
      `treating the whole ${totalDuration.toFixed(3)}s segment as speech`);
    return fallback;
  };
  // One retry, because the failure this guards against is transient rather than a
  // property of the file. Measured on a nine-scene render: two segments came back
  // "no silence at all" while three concurrent scenes were encoding, and both files
  // measured cleanly on a second pass with nothing changed — 0.239s and 0.237s of
  // leading silence, exactly the two scenes whose first caption shipped 0.24s early.
  // The call costs ~1.7s and only runs again when the first one found nothing.
  const detect = async (): Promise<string> => {
    for (let attempt = 1; ; attempt++) {
      const { stderr } = await execAsync(
        `"${ffmpeg}" -i "${file}" -af silencedetect=noise=-40dB:d=0.2 -f null -`,
        { timeout: 30000, maxBuffer: 1 << 22 }
      );
      if (attempt >= 2 || /silence_start:/.test(stderr)) return stderr;
      console.warn(`[RenderService] No silence found in ${path.basename(file)} on the first pass — measuring again`);
    }
  };
  try {
    const stderr = await detect();
    const starts = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => parseFloat(m[1]));
    const ends = [...stderr.matchAll(/silence_end:\s*(-?[\d.]+)/g)].map((m) => parseFloat(m[1]));
    if (starts.length === 0) return gaveUp('silencedetect reported no silence at all');

    // ffmpeg closes a trailing silence at EOF rather than leaving it open, so pair
    // them up positionally and treat a missing close as "runs to the end".
    const periods = starts.map((s, i) => ({ start: s, end: i < ends.length ? ends[i] : totalDuration }));

    const first = periods[0];
    const start = first.start <= 0.05 ? first.end : 0;

    const last = periods[periods.length - 1];
    const end = last.end >= totalDuration - 0.2 ? last.start : totalDuration;

    // Never hand back a degenerate span — a scene that is entirely silence, or a
    // detector misfire, should fall back to the old whole-segment behaviour.
    if (!(end > start) || end - start < 0.2) {
      return gaveUp(`the detected span ${start.toFixed(3)}→${end.toFixed(3)}s is degenerate`);
    }
    return { start, end: Math.min(end, totalDuration) };
  } catch (e: any) {
    return gaveUp(e?.message || String(e));
  }
};

/**
 * Measure when each narration word is spoken, and store it on the scene.
 *
 * Everything that puts something on screen or in the mix at a word — the captions,
 * the kinetic overlay, the tick effect — reads wordTimings(), which until now divided
 * the speech span equally between the words. That assumes every word takes the same
 * time to say. Measured against forced alignment across nine real scenes it left the
 * captions up to 0.47s late even on a clean scene, and no weighting heuristic closed
 * it: character- and syllable-weighted division both left the worst case at ~0.45s.
 *
 * Best effort by design. An unavailable aligner, a failed match, an engine that is not
 * running — all of them leave word_timings unset and the even division in place, which
 * is what shipped before this and is wrong by a fraction of a second rather than fatal.
 */
async function measureWordTimings(scene: any, processedAudio: string, speechStart: number): Promise<void> {
  const text = String(scene?.caption_text || scene?.narration_text || '').trim();
  if (!text) return;
  const { alignWords } = await import('../server/services/ttsSidecar.js');
  const words = await alignWords(processedAudio, text);
  // Leave nothing behind on failure rather than a marker, so the next render tries
  // again. An aligner that was down for one render should not condemn the scene to
  // even division until somebody edits its script.
  if (!words.length) { delete scene.word_timings; return; }
  // faster-whisper reports the first word of a file at 0.000 whatever the leading
  // silence is; detectSpeechSpan measured that silence on this same file and agrees
  // with the burned captions to within 9ms, so it wins for the one word it covers.
  const first = words[0];
  if (first.start < speechStart) first.start = Math.min(speechStart, first.end);
  scene.word_timings = words;
}

/**
 * Produce the segment's audio track and measure its speech span.
 *
 * Split out of assembleSceneSegment so it can run BEFORE the visual clip is rendered.
 * The motion-graphics overlay is drawn into the clip by the engine, so it needs to know
 * when the words are actually spoken while there is still a frame to draw on — and the
 * only honest source for that is this measurement, the same one the captions use.
 * Deriving a second set of timings from the scene duration is precisely the bug
 * speechWindow() exists to prevent.
 *
 * Idempotent and cached: the WAV is deterministic given the narration and the pad, so a
 * second call with a fresh file re-reads the stored span instead of re-encoding.
 */
export async function prepareSceneAudio(
  scene: any, audioPath: any, project?: any, signal?: AbortSignal,
): Promise<{ processedAudio: string; segmentDuration: number } | null> {
  const tmpDir = path.join(os.tmpdir(), 'ais-renderer', project?.project_id || 'test');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const processedAudio = path.join(tmpDir, `${scene.scene_id}_audio.wav`);

  const audioValid = (() => {
    try { return audioPath && fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000; }
    catch { return false; }
  })();

  const padSeconds = Number(scene.pad_seconds) || 0;
  let outputDuration = scene.duration_target || 5;
  if (audioValid) {
    const probed = await getAudioDuration(audioPath);
    if (probed > 0) outputDuration = probed;
  }

  // Already built for this narration, and already measured — nothing to redo.
  if (isFreshOutput(processedAudio, audioValid ? audioPath : undefined)
      && Number(scene.speech_end) > Number(scene.speech_start)) {
    const known = await getAudioDuration(processedAudio);
    if (known > 0) {
      // The span was measured on a previous run but the word timings may not have
      // been — a scene rendered before alignment existed, or one whose aligner was
      // down at the time. The audio is right here and unchanged, so measure now
      // rather than shipping the even division for the life of the project.
      if (!Array.isArray(scene.word_timings)) {
        await measureWordTimings(scene, processedAudio, Number(scene.speech_start) || 0);
      }
      return { processedAudio, segmentDuration: known };
    }
  }

  const audioInputArg = audioValid ? `-i "${audioPath}"` : `-f lavfi -i anullsrc=r=44100:cl=stereo`;
  const audioFilterChain = audioValid
    ? `-af "asetpts=PTS-STARTPTS,silenceremove=stop_periods=-1:stop_duration=0.05:stop_threshold=-40dB,apad${padSeconds > 0 ? '' : '=pad_dur=0.1'}"`
    : `-af asetpts=PTS-STARTPTS`;
  // See the note at the original site: apad is unbounded whenever there is a hold to
  // fill, so this command must carry its own limit or ffmpeg pads silence until the
  // disk is full. It once wrote a 240 GB WAV in about twenty minutes.
  const audioCapArg = `-t ${(
    !audioValid ? outputDuration
      : padSeconds > 0 ? outputDuration + padSeconds
      : outputDuration + 0.1
  ).toFixed(3)}`;

  try {
    await guardedExec(`"${ffmpeg}" ${audioInputArg} ${audioFilterChain} -c:a pcm_s16le -ar 44100 -ac 2 ${audioCapArg} -y "${processedAudio}"`, signal);
    const segmentDuration = await getAudioDuration(processedAudio);
    if (segmentDuration > outputDuration + padSeconds + 1) {
      try { fs.unlinkSync(processedAudio); } catch { /* non-fatal */ }
      throw new Error(
        `processed audio ran to ${segmentDuration.toFixed(1)}s for a scene budgeted at ` +
        `${(outputDuration + padSeconds).toFixed(1)}s — the audio pass lost its duration cap`);
    }
    if (segmentDuration > 0) {
      scene.duration_actual = segmentDuration;
      const span = await detectSpeechSpan(processedAudio, segmentDuration);
      scene.speech_start = Number(span.start.toFixed(3));
      scene.speech_end = Number(span.end.toFixed(3));
      await measureWordTimings(scene, processedAudio, span.start);
      console.log(
        `[RenderService] Scene ${scene.scene_id} segment ${segmentDuration.toFixed(3)}s, ` +
        `speech ${span.start.toFixed(3)}→${span.end.toFixed(3)}s ` +
        `(${scene.word_timings?.length ? `${scene.word_timings.length} words aligned` : 'captions divided evenly'})`
      );
    }
    return { processedAudio, segmentDuration };
  } catch (e: any) {
    if (e.message === 'PIPELINE_CANCELLED') throw e;
    console.warn('[RenderService] Audio pass failed:', e?.message || e);
    return null;
  }
}

export const assembleSceneSegment = async (scene: any, audioPath: any, cacheKey: any, signal?: AbortSignal, project?: any) => {
  // Scoped by project, the same way stitchScenes scopes its own output. Scene ids are
  // only unique *within* a project: duplicating a project copies its scenes verbatim,
  // so an unscoped `${scene_id}_segment.mp4` puts two projects on the same file.
  const tmpDir = path.join(os.tmpdir(), 'ais-renderer', project?.project_id || 'test');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const outputPath = path.join(tmpDir, `${scene.scene_id}_segment.mp4`);
  // Captions are burned in the same pass, so a captioned scene lands straight here.
  const captionedPath = path.join(tmpDir, `${scene.scene_id}_captioned.mp4`);
  const hasCaptions = Boolean(scene.caption_text);
  const finalPath = hasCaptions ? captionedPath : outputPath;

  const visualPath = (scene.visuals?.[0] as any)?.rendered_path;
  if (!visualPath || !fs.existsSync(visualPath)) {
    console.error('[RenderService] No rendered visual for scene:', scene.scene_id, 'visual path:', visualPath);
    return '';
  }

  const audioValid = (() => {
    try { return audioPath && fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000; }
    catch { return false; }
  })();

  // Reuse a finished segment only if it is newer than BOTH things it was built from.
  //
  // This has to come BEFORE the probe below. duration_actual is the length of the
  // assembled SEGMENT, but the probe measures the raw narration, which is longer —
  // silenceremove has not run yet. Checking freshness after it meant a reused scene got
  // its stored duration overwritten with the wrong number (measured: 6.88s -> 8.05s) on
  // every subsequent render, with nothing rebuilt that would put it back.
  // The logo is a SOURCE of this segment, so a channel that changes its watermark makes
  // every segment built with the old one stale by mtime — the same rule that already
  // rebuilds a segment when its visual or narration changes. No parallel cache.
  const logoPath = channelWatermarkPath(project);
  if (isFreshOutput(finalPath, visualPath, audioValid ? audioPath : undefined, logoPath)) {
    console.log('[RenderService] Segment still fresh — reusing:', path.basename(finalPath));
    emitStep(project, scene, 'segment', 'Video segment already built', true);
    return finalPath;
  }
  emitStep(project, scene, 'segment', 'Encoding video and burning captions', false);

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

  // Target-length hold: extra still time the orchestrator budgeted for this scene
  // (see planScenePadding). The video input is -stream_loop'd and the clip was
  // rendered at narration+pad, so we just let the segment run that much longer and
  // apad keeps the audio track alive over the hold. Never trims narration.
  const padSeconds = Number(scene.pad_seconds) || 0;

  // Three command variants:
  // audioValid + pad  → apad runs unbounded and -t fixes the segment at narration+pad.
  // audioValid        → silenceremove strips TTS trailing silence (Piper adds 0.33–0.57s/clip),
  //                     apad=0.1 adds a consistent 100ms tail, -shortest ends at padded audio end.
  // audioValid=false  → generated anullsrc silence: silenceremove would eat it all, so fall
  //                     back to -t so the silent segment lasts exactly the scene's target duration.
  const audioFilterChain = audioValid
    ? `-af "asetpts=PTS-STARTPTS,silenceremove=stop_periods=-1:stop_duration=0.05:stop_threshold=-40dB,apad${padSeconds > 0 ? '' : '=pad_dur=0.1'}"`
    : `-af asetpts=PTS-STARTPTS`;
  const durationArg = !audioValid ? `-t ${outputDuration}`
    : padSeconds > 0 ? `-t ${(outputDuration + padSeconds).toFixed(3)}`
    : `-shortest`;

  // Hard bound for the audio-only pass below. `apad` is unbounded whenever there is a
  // hold to fill, and `-shortest` means nothing when a single input is being filtered —
  // so an audio-only command must carry its own limit or ffmpeg pads silence until the
  // disk is full. That is not hypothetical: it wrote a 240 GB WAV in about twenty
  // minutes while this change was being measured. Never let this be implied by another
  // flag. Where silenceremove makes the real output shorter this is only a ceiling; the
  // true length is measured off the file afterwards.
  //
  // Each branch matches the length the old muxed command produced, so segments come out
  // exactly as long as they used to: pad is exact, and the +0.1 is the pad_dur tail.
  const audioCapArg = `-t ${(
    !audioValid ? outputDuration
      : padSeconds > 0 ? outputDuration + padSeconds
      : outputDuration + 0.1
  ).toFixed(3)}`;

  // Normalise the segment to the project's export resolution here: this is the one
  // point every render path (Ken Burns, animator, Metro/Doraemon engines) flows
  // through, and the engines ignore the size we hand them. Downstream stitching is
  // -c copy, so getting it right here is what reaches the final MP4.
  let sizeFilter = '';
  // Caption geometry must match the frame the captions land on. The scale below is the
  // last thing to touch the picture, so these are the final dimensions — no ffprobe of an
  // intermediate needed any more, because there is no intermediate.
  let capW = 1080, capH = 1920;
  if (project) {
    const isPreviewSize = project?.quality === 'draft' || project?.preview_mode || false;
    const { w, h } = outputResolution(project?.settings?.exportResolution, isShortsProject(project), isPreviewSize);
    sizeFilter = `,scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
    capW = w; capH = h;
  }

  try {
     // ── Pass 1 (audio only): the segment's audio track, and the speech span the
     // captions are laid out across. Lives in prepareSceneAudio because the overlay
     // needs the same measurement one step earlier in the render; it is cached, so
     // when the orchestrator has already run it this is a probe, not an encode.
     //
     // Captions anchor to that span, NOT to duration_actual: the segment also holds
     // pad_seconds of deliberate silence, and spreading captions over that is what
     // made them lag further and further behind the narration.
     const prepared = await prepareSceneAudio(scene, audioPath, project, signal);
     if (!prepared) throw new Error('audio pass produced nothing');
     const { processedAudio, segmentDuration } = prepared;

     // ── Captions: chunks depend only on the speech span measured above, never on the
     // video, so they can be laid out before a single frame is encoded.
     let assFilter = '';
     if (hasCaptions) {
       const { chunks } = await generateCaptions(scene, audioPath, 'default');
       scene.caption_chunks = chunks;
       const assPath = writeCaptionAss(scene, tmpDir, capW, capH);
       if (assPath) {
         const escaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
         assFilter = `,ass='${escaped}'`;
       }
     }

     // ── Pass 2 (the only video encode): scale to the export resolution, burn the
     // captions and mux the finished audio, all in one go. The audio is already in its
     // final form, so it is copied through the filter graph untouched.
     // Same preset the two passes it replaces both used. exportPreset deliberately does
     // not feed in here: it governs the Ken Burns path, and routing it in as well would
     // have quietly changed every existing project's output size along with this change.
     const isPreview = project?.quality === 'draft' || project?.preview_mode || false;
     const preset = isPreview ? 'ultrafast' : 'fast';
     const lengthArg = segmentDuration > 0 ? `-t ${segmentDuration.toFixed(3)}` : durationArg;
     // Loop the clip only when it is actually too short to cover the segment.
     //
     // `-stream_loop -1` restarts the input's timestamps on every pass while
     // `setpts=PTS-STARTPTS` keeps rebasing them to zero, so once a loop happens the
     // output timestamps stop moving forward, the muxer drops the frames, and `-t`
     // never arrives. Observed on a multi-frame scene: a 7.0s clip being cut to 4.2s
     // — no loop needed at all — sat at 524KB of output and 40 minutes of CPU without
     // finishing. Looping something already long enough was never useful; not asking
     // for it is what stops the spin.
     const clipDuration = await getAudioDuration(visualPath).catch(() => 0);
     const needed = segmentDuration > 0 ? segmentDuration : outputDuration + padSeconds;
     const loopArg = clipDuration > 0 && clipDuration >= needed - 0.05 ? '' : '-stream_loop -1';
     if (!loopArg) console.log(`[RenderService] Clip already covers the segment (${clipDuration.toFixed(2)}s ≥ ${needed.toFixed(2)}s) — no loop`);
     // crf 20, not the 18 the old caption burn used. The old chain's real quality ceiling
     // was its FIRST pass at crf 20; re-encoding that at 18 could only add generation
     // loss while inflating the file. Measured against a lossless reference of the same
     // scene: old two-pass 7.15 MB / SSIM 0.96902, this 7.24 MB / SSIM 0.97018 — better
     // picture at the same size. crf 18 here doubles the file for no visible gain
     // (15.6 MB), and crf 22 drops below the old quality.
     // The channel watermark rides along in this same encode rather than getting a pass
     // of its own — a second encode would cost another generation of quality on every
     // scene to composite a 97px logo. buildVideoFilter returns the untouched -vf when
     // the project has no channel logo, so unbranded renders are unchanged.
     const wm = buildVideoFilter(logoPath, sizeFilter, assFilter, capW);
     await guardedExec(`"${ffmpeg}" ${loopArg} -i "${visualPath}" -i "${processedAudio}" ${wm.inputArg} ${wm.filterArg} ${wm.mapArgs} -c:v libx264 -preset ${preset} -crf 20 -c:a aac -ar 44100 -ac 2 -b:a 192k ${lengthArg} -y "${finalPath}"`, signal);

     // A truncated encode that ffmpeg still exited 0 on would be cached as valid by the
     // freshness check above and shipped. Cheap to rule out; expensive to miss.
     if (!fs.existsSync(finalPath) || fs.statSync(finalPath).size < 1000) {
       try { fs.unlinkSync(finalPath); } catch { /* already gone */ }
       throw new Error(`segment encode produced no usable file: ${path.basename(finalPath)}`);
     }
     try { fs.unlinkSync(processedAudio); } catch { /* non-fatal */ }
     return finalPath;
  } catch(e: any) {
     if (e.message === 'PIPELINE_CANCELLED') throw e;
     console.error('assembly ffmpeg failed', e);
     // Never leave a partial behind for the next run's freshness check to trust.
     try { if (fs.existsSync(finalPath) && fs.statSync(finalPath).size < 1000) fs.unlinkSync(finalPath); } catch { /* non-fatal */ }
     return visualPath;
  }
};

/**
 * Write the scene's ASS subtitle file and return its path (or '' if there is nothing
 * to burn).
 *
 * `playResX/Y` must be the dimensions of the frame the captions are drawn onto, or
 * libass stretches the geometry — e.g. a portrait caption layout mapped onto 16:9.
 * The caller knows them from the export resolution it is about to scale to.
 */
function writeCaptionAss(scene: any, tmpDir: string, playResX: number, playResY: number): string {
  if (!scene.caption_chunks || scene.caption_chunks.length === 0) return '';

  const toAssTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.floor((seconds % 1) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  };

  // Every caption number below is a fraction of the frame, not a constant.
  //
  // Fontsize was a hardcoded 34 while PlayResY tracks the export resolution, so
  // the type was 1.77% of frame height at 1080p (against a 3.1-5.7% norm for
  // vertical short-form) and swung 3.5x across export settings — 2.66% at 720p,
  // 0.89% at 4K. The motion-graphics overlay in the same frame sizes itself at
  // 4.8-5.2% of height and says so in a comment; the two text systems were three
  // times apart. 0.05 puts them on the same scale.
  //
  // MarginV was 120 — 6.25% off the bottom — which is inside the band YouTube
  // Shorts and TikTok reserve for their own title, handle and description rows
  // (250-320px at 1920). The captions were rendered underneath the platform UI.
  // 0.22 lifts them into the lower-middle third, where short-form captions live.
  const capFont = Math.max(18, Math.round(playResY * 0.05));
  const capOutline = Math.max(2, Math.round(capFont * 0.09));
  const capShadow = Math.max(1, Math.round(capFont * 0.03));
  const capMarginV = Math.round(playResY * 0.22);
  const capMarginH = Math.round(playResX * 0.08);

  const assHeader = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
WrapStyle: 0

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,Arial,${capFont},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,${capOutline},${capShadow},2,${capMarginH},${capMarginH},${capMarginV},1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;

  // Where an overlay is drawing the narration's own words, the caption stands down
  // for exactly that window.
  //
  // Both systems read the same wordTimings(), so on a kinetic or payoff beat they
  // draw the same sentence at the same instant in two places. On a real render the
  // closing beat carried the payoff overlay reading "of faster, more reliable test
  // automation, accelerating your delivery." across the middle of the frame while
  // the caption underneath read the same words three at a time, and in the last
  // frames the two blocks overlapped.
  //
  // The overlay wins because it is the deliberate emphasis treatment — larger,
  // animated, and chosen for this beat. Only the overlapping window is dropped, so
  // a long scene keeps captions either side of it, and only the kinds that restate
  // narration verbatim qualify: a diagram, comparison, stat or namecard shows
  // something derived that the captions do not carry, and both belong on screen.
  //
  // overlay_drawn is set from what was actually rendered, never from the plan, so a
  // failed overlay leaves the captions in place rather than muting the beat.
  const muted = mutedCaptionWindow(scene);

  // Split long chunks into 2-3 word groups for mobile readability
  const wordChunks: { start: number; end: number; text: string }[] = [];
  for (const chunk of scene.caption_chunks) {
    if (muted) {
      // Midpoint, not overlap: a cue straddling the boundary belongs to whichever
      // side it mostly sits in, so one cue cannot half-vanish.
      const mid = (chunk.start + chunk.end) / 2;
      if (mid >= muted.start && mid <= muted.end) continue;
    }
    const words = String(chunk.text).trim().split(/\s+/);
    if (words.length <= 3) { wordChunks.push(chunk); continue; }
    const groups: string[] = [];
    for (let i = 0; i < words.length; i += 3) groups.push(words.slice(i, i + 3).join(' '));
    const groupDur = (chunk.end - chunk.start) / groups.length;
    groups.forEach((text, i) => wordChunks.push({ start: chunk.start + i * groupDur, end: chunk.start + (i + 1) * groupDur, text }));
  }

  // A cue used to hard-cut on and off, which at three words a cue is a lot of
  // switching; a fade fixed that and introduced a sync problem of its own.
  //
  // The fade was symmetric at 110ms. Measured on a real render: the first cue is
  // scheduled at 0.231s (19ms BEFORE the speech onset detectSpeechSpan measured
  // at 0.250s, so the timing data was right), and the caption did not cross
  // visibility until 0.375s — 125ms after the word, past the +/-100ms tolerance
  // the original caption-sync work set. On a 344ms cue, 110+110 left only 124ms
  // at full opacity.
  //
  // So: in fast, out slow. 40ms is under one frame at 24fps, so a cue is at full
  // opacity by the frame after it starts and reads as landing on the word. The
  // out-fade is what actually stops the flicker, and being late off costs nothing.
  const assEvents = wordChunks.map((chunk) => {
    const start = toAssTime(chunk.start);
    const end = toAssTime(chunk.end);
    const text = chunk.text.replace(/\n/g, '\\N');
    const { inMs, outMs } = cueFade(chunk.end - chunk.start);
    return `Dialogue: 0,${start},${end},Default,,0,0,0,,{\\fad(${inMs},${outMs})}${text}`;
  }).join('\n');

  const assPath = path.join(tmpDir, `${scene.scene_id}_captions.ass`);
  fs.writeFileSync(assPath, assHeader + assEvents, 'utf8');
  console.log(`[Captions] Scene ${scene.scene_id}: ${wordChunks.length} cues at ${playResX}x${playResY}`);
  return assPath;
}

/**
 * ffmpeg `-metadata` arguments disclosing that the narration is synthetic.
 *
 * YouTube and other platforms increasingly require creators to declare synthetic
 * speech, and a cloned voice raises the stakes: the file itself should say what made
 * it. These are plain container tags, so they survive `-c copy` and cost nothing.
 *
 * This describes the audio only. It is not a watermark and makes no claim to be one —
 * Chatterbox's built-in Perth watermarking is what survives re-encoding.
 */
async function disclosureMetadataArgs(project: any): Promise<string> {
  const settings = project?.settings || {};
  let voice: string;
  if (settings.clonedVoiceId) {
    const { listVoices } = await import('../server/services/voiceRegistry.js');
    const match = (await listVoices()).find((v) => v.id === settings.clonedVoiceId);
    voice = `cloned voice "${match?.name ?? settings.clonedVoiceId}" (Chatterbox 0.5B, cloned locally)`;
  } else {
    voice = `synthetic voice (${settings.voiceStyle || 'default'})`;
  }
  const disclosure =
    `AI-generated narration: ${voice}. Contains synthetic speech.` +
    (settings.clonedVoiceId ? ` Voice cloned with consent; see project voice audit trail.` : '');

  // Shell-quoted below, so a stray double quote would break the command line.
  const clean = (s: string) => s.replace(/["\\]/g, '').replace(/\s+/g, ' ').trim();
  return `-metadata comment="${clean(disclosure)}" -metadata description="${clean(disclosure)}"`;
}

// Neutral enough to sit under an explainer without competing with it. Prefix, not
// filename: the files on disk are named `04-ambient-background.mp3.mp3`.
const DEFAULT_MUSIC_PREFIX = '04-ambient-background';

/**
 * The music bed for a render.
 *
 * music_track is only ever written by a human choosing one in the editor, so every
 * project created through Automate mode or POST /pipeline/run had none — measured,
 * five of six audited renders carried `music_track: null`. That is what made the
 * dead air literal: astats reported `Max level 0.000000` across 36.2% of one file,
 * every sample a zero, because nothing was running underneath the narration.
 *
 * An explicit empty string still means "no music" — that is a choice. Only an
 * absent field falls back, and the fallback matches by prefix because the files on
 * disk carry a doubled extension (01-lofi-study.mp3.mp3) that any hardcoded name
 * would silently miss.
 */
export function resolveMusicTrack(project: any): string {
  const chosen = project?.settings?.musicTrack ?? project?.music_track;
  if (typeof chosen === 'string') return chosen.trim();
  const musicDir = process.env.MUSIC_DIR || path.join(process.cwd(), 'music');
  try {
    const files = fs.readdirSync(musicDir).filter((f) => /\.(mp3|m4a|wav|ogg)$/i.test(f)).sort();
    if (!files.length) return '';
    return files.find((f) => f.startsWith(DEFAULT_MUSIC_PREFIX)) || files[0];
  } catch {
    return '';
  }
}

export const stitchScenes = async (scenes: any, project: any, signal?: AbortSignal) => {
  if (!scenes || scenes.length === 0) return "";
  
  const projectId = project?.project_id || 'test';
  const tmpDir = path.join(os.tmpdir(), 'ais-renderer', projectId);
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  let outputPath = path.join(tmpDir, `final_${new Date().getTime()}.mp4`);
  const listFile = path.join(tmpDir, `list_${new Date().getTime()}.txt`);
  
  let listContent = '';
  // Each segment's measured length, in concat order. The stitch already probes these to
  // log them; the effects layer needs the same numbers to know where the cuts land, and a
  // measured boundary is the frame the concat actually cuts on rather than what
  // duration_target asked for.
  const stitched: { scene: any; duration: number }[] = [];
  for (const scene of scenes) {
    const scenePath = (scene as any).segment_path || scene.rendered_path || scene.video_path;
    if (scenePath) {
      let dur = NaN;
      try {
        const { stdout } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${scenePath}"`, { timeout: 10000 });
        dur = parseFloat(stdout.trim());
        console.log('[Stitch] Segment duration:', isNaN(dur) ? '?' : dur.toFixed(2) + 's', 'path:', scenePath.slice(-40));
      } catch {
        console.log('[Stitch] Could not probe:', scenePath.slice(-40));
      }
      // What the orchestrator hands this function is a concat entry — a path and a
      // duration — with the scene it came from attached. Everything else here only
      // ever needed the path, so the entry is what gets passed; the effects layer is
      // the first thing that needs the narration and the overlay behind it.
      stitched.push({ scene: (scene as any).scene ?? scene, duration: dur });
      listContent += `file '${scenePath.replace(/'/g, "'\\''")}'\n`;
    }
  }

  fs.writeFileSync(listFile, listContent);
  console.log('[Stitch] Concat list contents:\n', fs.readFileSync(listFile, 'utf8'));

  try {
     // Stream copy requires all segments encoded identically (h264 1080x1920 yuv420p 24fps + aac 44.1kHz stereo,
     // guaranteed by assembleSceneSegment). Filters can't combine with -c copy, so no -vf here.
     const disclosure = await disclosureMetadataArgs(project);
     const stitchCmd = `"${ffmpeg}" -f concat -safe 0 -i "${listFile}" -c copy ${disclosure} -movflags +faststart -y "${outputPath}"`;
     console.log('[Stitch] FFmpeg command:', stitchCmd);
     await guardedExec(stitchCmd, signal);
     try {
       const { stdout: probeDur } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${outputPath}"`, { timeout: 10000 });
       console.log('[Stitch] Output duration:', probeDur.trim(), 'seconds');
     } catch { console.warn('[Stitch] Could not probe output duration'); }

     // ── Master. Runs on every render, not only when someone picked music.
     //
     // There was no mixing stage at all before this: the whole audio chain was
     // asetpts (a timestamp reset), silenceremove (an edit) and apad (padding),
     // none of which touch amplitude, spectrum or dynamics. The narration level
     // in the finished file was whatever Kokoro happened to emit. Measured across
     // six renders including both YouTube uploads: -21.7 to -25.2 LUFS, every one
     // 8-11 LU under YouTube's -14 target. YouTube only attenuates, never boosts,
     // so they play back quieter than everything around them.
     const musicTrack = resolveMusicTrack(project);
     const musicVolume = project?.settings?.musicVolume ?? project?.music_volume ?? 0.08;
     const musicPath = musicTrack
       ? path.join(process.env.MUSIC_DIR || path.join(process.cwd(), 'music'), musicTrack)
       : '';
     const haveMusic = Boolean(musicPath && fs.existsSync(musicPath));
     if (musicTrack && !haveMusic) console.warn(`[Music] Track not found, mastering without it: ${musicPath}`);
     console.log('[Master] Track:', musicTrack || '(none)', 'Volume:', musicVolume, 'Found:', haveMusic);


     // ── The sound-effects layer. ──────────────────────────────────────────────
     //
     // There was no effects layer at all: narration and, since the mixing work, a
     // music bed. Every cut and every graphic landed in silence. The cues are decided
     // by planSfxCues from what the edit is already doing — see sfx.ts — and rendered
     // to one WAV the length of the video, so this costs the master pass one input
     // rather than one per hit.
     //
     // sfxVolume is the trim, and 0 is the way to turn the layer off for a comparison
     // render without touching the code that decides where the effects go.
     const sfxVolume = resolveSfxVolume(project);
     const sfxPath = path.join(tmpDir, `sfx_${Date.now()}.wav`);
     const usable = stitched.every((s) => Number.isFinite(s.duration) && s.duration > 0);
     const sfxCues = usable && sfxVolume > 0
       ? planSfxCues(stitched.map((s) => s.scene), project, stitched.map((s) => s.duration))
       : [];
     if (!usable) console.warn('[SFX] A segment length could not be measured — skipping the effects layer rather than guessing where the cuts are');
     const totalSeconds = stitched.reduce((n, s) => n + (Number.isFinite(s.duration) ? s.duration : 0), 0);
     const haveSfx = renderSfxBed(sfxCues, totalSeconds, sfxPath, sfxVolume);
     // The video is input 0 and the bed, when there is one, is input 1.
     const sfxInput = haveMusic ? 2 : 1;
     if (haveSfx) {
       console.log(
         `[SFX] ${sfxCues.length} cue(s) over ${totalSeconds.toFixed(1)}s,`,
         `peak ${sfxHeadroom(sfxCues, sfxVolume).toFixed(1)} dBFS:`,
         sfxCues.map((c) => `${c.at.toFixed(2)}s ${c.kind} (${c.reason})`).join('; '),
       );
     } else {
       console.log('[SFX] No cue earned an effect on this render — mixing without the layer');
     }

     const mastered = path.join(tmpDir, `final_master_${Date.now()}.mp4`);
     try {
       // Voice chain: high-pass below speech, then gentle 3:1 to give the
       // narration density it never had (measured crest factor 8-11, i.e.
       // completely uncompressed, with 17-19 dB of headroom sitting unused).
       const voice = 'aformat=sample_rates=44100:channel_layouts=stereo,highpass=f=80,'
         + 'acompressor=threshold=-18dB:ratio=3:attack=5:release=120:makeup=2';
       // loudnorm last, so it measures the finished mix. I=-14 is YouTube's own
       // normalisation target; TP=-1.5 leaves headroom for the lossy encode.
       const master = 'loudnorm=I=-14:TP=-1.5:LRA=11';

       // The effects bus is ducked under the voice by its own sidechain, gentler than
       // the music's: 4:1 against the bed's 8:1, so a transition sound in a gap keeps
       // all of its level and one that lands on a line steps back instead of sitting on
       // it. That is what lets the effects be as loud as they now are — see PEAK in
       // sfx.ts for why the first, quieter levels could not be heard at all.
       const duckSfx = `[sfxraw][sk]sidechaincompress=threshold=0.05:ratio=4:attack=5:release=250[sfx];`;
       const sfxIn = `[${sfxInput}:a]aformat=sample_rates=44100:channel_layouts=stereo[sfxraw];`;

       let filter: string;
       if (haveMusic) {
         // normalize=0 is not optional. amix defaults to normalize=1, which scales
         // every input by 1/inputs — adding a bed quietly dropped the narration by
         // 6dB. Measured: narration -32.0dB alone, -38.0dB once music was added.
         //
         // sidechaincompress ducks the bed under the voice instead of leaving it at
         // a static gain. Without it the bed sits ~7.5 dB under the narration where
         // broadcast practice is 15-22, and fights every line.
         //
         // The effects join the bed bus AFTER the music's own sidechain, carrying their
         // own duck instead — the bed has to get out of the way of a line, a transition
         // sound only has to not sit on one.
         filter = `[0:a]${voice},asplit=${haveSfx ? 3 : 2}[v1][vk]${haveSfx ? '[sk]' : ''};`
           + `[1:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${Number(musicVolume).toFixed(2)}[bg];`
           + `[bg][vk]sidechaincompress=threshold=0.03:ratio=8:attack=5:release=300[duck];`
           + (haveSfx
             ? sfxIn + duckSfx + `[duck][sfx]amix=inputs=2:duration=first:normalize=0[bed];`
             : '')
           + `[v1][${haveSfx ? 'bed' : 'duck'}]amix=inputs=2:duration=first:normalize=0[mix];`
           + `[mix]${master}[aout]`;
       } else if (haveSfx) {
         filter = `[0:a]${voice},asplit=2[v1][sk];`
           + sfxIn + duckSfx
           + `[v1][sfx]amix=inputs=2:duration=first:normalize=0[mix];`
           + `[mix]${master}[aout]`;
       } else {
         filter = `[0:a]${voice},${master}[aout]`;
       }
       // Input order is fixed and sfxInput was computed from it: video, then the bed if
       // there is one, then the effects.
       const inputs = [
         `-i "${outputPath}"`,
         haveMusic ? `-stream_loop -1 -i "${musicPath}"` : '',
         haveSfx ? `-i "${sfxPath}"` : '',
       ].filter(Boolean).join(' ');
       await guardedExec(
         `"${ffmpeg}" ${inputs} -filter_complex "${filter}" -map 0:v -map "[aout]" `
         + `-c:v copy -c:a aac -ar 44100 -ac 2 -b:a 192k ${disclosure} -shortest -y "${mastered}"`,
         signal,
       );
       fs.promises.unlink(outputPath).catch(() => {});
       outputPath = mastered;
     } catch (masterErr: any) {
       // Never lose a finished render to the mastering pass.
       console.warn('[Master] Mastering failed, using unmastered video:', masterErr?.message);
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

