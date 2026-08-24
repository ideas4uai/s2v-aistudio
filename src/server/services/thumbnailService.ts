import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { isFreshOutput } from '../../services/renderService.js';
import { getChannel } from './channelStore.js';

/**
 * The custom thumbnail for a project: a designed composition, not a video frame.
 *
 * ── Why the base is scene art, not the render ─────────────────────────────────
 * The first version grabbed a frame 1.5s into the finished mp4. That is the worst
 * available copy of the episode's own pictures: h.264 output at ~185KB against the
 * ~1.2MB original, whatever the video happened to be showing at that second, and
 * carrying the burned-in caption from that moment. The episode already generated
 * original stills, so the thumbnail uses those — no extra API call, no extra latency,
 * strictly better pixels.
 *
 * ── Why the video is still here ───────────────────────────────────────────────
 * Not every project has scene art on disk. Rather than have two thumbnail styles, a
 * project with no stills gets a frame extracted and fed through the SAME compositor,
 * so the layout is identical and only the picture inside it is worse.
 *
 * ── What the compositor has to be told ────────────────────────────────────────
 * The channel logo is passed explicitly. The old thumbnail inherited the watermark for
 * free because its frame came from an already-watermarked render; scene art has never
 * been near the renderer, so without this the thumbnail would silently lose the
 * branding the video has.
 */

const ffmpegPath = ffmpegStatic as string;

/** The moment a frame is taken from, when there is no scene art to use instead. */
export const GRAB_AT_SECONDS = 1.5;

export function thumbnailDir(): string {
  return process.env.THUMBNAIL_DIR
    || path.join(process.env.OUTPUTS_DIR || path.join(process.cwd(), 'outputs'), 'thumbnails');
}

export const thumbnailPath = (projectId: string): string =>
  path.join(thumbnailDir(), `${projectId}.jpg`);

/** Records what the current file was drawn from, so changed copy or art invalidates it. */
const stampPath = (projectId: string): string =>
  path.join(thumbnailDir(), `${projectId}.txt`);

/** The headline for a project, or '' when the SEO agent has not produced one. */
export function thumbnailTextOf(project: any): string {
  const seo = project?.seo_metadata || project?.seoMetadata || {};
  return String(seo.thumbnailText || '').trim();
}

/**
 * Every generated still this project has on disk, in scene order.
 *
 * Order is preserved but does not decide anything — the compositor scores them and
 * picks. Approved visuals come first because an approved image is one a human has
 * already looked at and accepted.
 */
export function sceneImagesOf(project: any): string[] {
  const approved: string[] = [];
  const rest: string[] = [];
  for (const scene of project?.scenes || []) {
    for (const visual of scene?.visuals || []) {
      const p = visual?.asset_path;
      if (!p || typeof p !== 'string') continue;
      try {
        if (!fs.statSync(p).isFile()) continue;
      } catch { continue; }
      (visual.approved ? approved : rest).push(p);
    }
  }
  return [...approved, ...rest];
}

/**
 * Runs the compositor, once more if the first attempt died without saying why.
 *
 * The Windows `py` launcher intermittently fails to start when several renders and
 * tests are spawning Python at once — the same contention that vite.config.ts caps
 * maxWorkers for. It surfaces as a non-zero exit with nothing on stderr, which is
 * exactly what a lost thumbnail at publish time looks like: the video goes out wearing
 * YouTube's auto-generated frame for no stated reason.
 *
 * Only a silent failure is retried. A compositor that actually objected to its input
 * has written the reason to stderr, and running it again would just print it twice.
 */
async function runCompositor(args: string[], timeoutMs: number) {
  let last: { ok: boolean; err: string; code: number | null } = { ok: false, err: '', code: null };
  // Backoff, not an immediate retry: the failure is contention for the interpreter, and
  // trying again in the same instant just meets the same contention. Two short waits
  // cost nothing on the normal path, where the first attempt succeeds.
  for (const waitMs of [0, 250, 750]) {
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
    last = await run('py', args, timeoutMs);
    // Anything on stderr means the compositor ran and objected. That is an answer, not
    // a failure to start, and repeating it would only print the same complaint again.
    if (last.ok || last.err.trim()) return last;
  }
  return last;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; err: string; code: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.stdout.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => { proc.kill(); resolve({ ok: false, err: `${cmd} timed out`, code: null }); }, timeoutMs);
    proc.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, err, code }); });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, err: e.message, code: null }); });
  });
}

export type ThumbnailResult = {
  path: string;
  /** 'scene' when built from the episode's own art, 'frame' when from the video. */
  source: 'scene' | 'frame';
  hasText: boolean;
  regenerated: boolean;
  note?: string;
};

/** Which pictures a project's thumbnail should be built from, and how good they are. */
export function thumbnailSources(project: any, videoPath: string): { images: string[]; source: 'scene' | 'frame' } {
  const scenes = sceneImagesOf(project);
  if (scenes.length) return { images: scenes, source: 'scene' };
  return { images: videoPath && fs.existsSync(videoPath) ? [videoPath] : [], source: 'frame' };
}

/**
 * Produces the composited thumbnail, reusing the existing file when nothing it was
 * built from has changed.
 *
 * Throws only when there is no picture to build from at all. A missing headline is not
 * an error — the layout still works, it just has no words in it — because refusing
 * would take the download button down with it.
 */
export async function ensureThumbnail(
  projectId: string,
  project: any,
  videoPath: string,
): Promise<ThumbnailResult> {
  const { images, source } = thumbnailSources(project, videoPath);
  if (!images.length) {
    throw new Error('This project has neither scene images nor a rendered video to build a thumbnail from.');
  }

  const text = thumbnailTextOf(project);
  const channel = getChannel(project?.channel_id);
  const logo = channel?.logoPath && fs.existsSync(channel.logoPath) ? channel.logoPath : '';
  const kicker = channel?.title || '';

  const out = thumbnailPath(projectId);
  const stamp = stampPath(projectId);
  // Everything that changes the picture is in the stamp, because only the mtimes of
  // files can be compared and the headline, the kicker and WHICH images exist are not
  // files. A changed headline used to be the only one of these that was noticed.
  const recipe = JSON.stringify({ text, kicker, logo, source, images });
  const previous = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf-8') : null;

  if (previous === recipe && isFreshOutput(out, ...images, logo || undefined)) {
    return { path: out, source, hasText: Boolean(text), regenerated: false };
  }

  fs.mkdirSync(thumbnailDir(), { recursive: true });

  // A frame-sourced project needs the frame pulled out first; scene art is already a
  // set of images the compositor can read directly.
  let inputs = images;
  let scratch = '';
  if (source === 'frame') {
    scratch = path.join(os.tmpdir(), `thumb-frame-${projectId}-${Date.now()}.jpg`);
    const grab = await run(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(GRAB_AT_SECONDS), '-i', images[0],
      '-vframes', '1', '-q:v', '2', '-y', scratch,
    ], 60_000);
    if (!grab.ok || !fs.existsSync(scratch)) {
      throw new Error(`Could not read a frame from the video: ${grab.err.slice(-200) || 'ffmpeg failed'}`);
    }
    inputs = [scratch];
  }

  const script = path.join(process.cwd(), 'src', 'scripts', 'thumbnail_compose.py');
  const args = [script, '--input', ...inputs, '--output', out, '--text', text || ' '];
  if (kicker) args.push('--kicker', kicker);
  if (logo) args.push('--logo', logo);

  const drew = await runCompositor(args, 180_000);
  if (scratch) fs.promises.unlink(scratch).catch(() => {});

  if (!drew.ok || !fs.existsSync(out)) {
    // The exit code and whether the file landed are both in here on purpose: a message
    // that says only "compositor failed" cannot distinguish a compositor that refused
    // from one that wrote the file and was not believed.
    throw new Error(
      `The thumbnail could not be composed (exit ${drew.code}, wrote=${fs.existsSync(out)}): `
      + `${drew.err.trim().slice(-200) || 'no output'}`);
  }

  fs.writeFileSync(stamp, recipe);
  return {
    path: out, source, regenerated: true, hasText: Boolean(text),
    note: text ? undefined : 'This project has no thumbnailText yet, so the panel has no headline.',
  };
}
