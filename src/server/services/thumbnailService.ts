import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { isFreshOutput } from '../../services/renderService.js';

/**
 * The custom thumbnail for a project: a frame from the render with the SEO agent's
 * thumbnailText burned onto it.
 *
 * ── Why the video is the source, not the captured frame ───────────────────────
 * The render already grabs a frame at 1.5s, but it uploads it to Supabase and unlinks
 * the local copy, so `thumbnail_path` is a remote URL and there is nothing on disk to
 * composite onto. Re-grabbing from the mp4 costs one ffmpeg seek, works for every
 * project that has ever rendered — including the ones finished long before this
 * feature existed — and means no re-render is needed to get a thumbnail.
 *
 * ── One path, two consumers ───────────────────────────────────────────────────
 * The download button and the publish flow both call ensureThumbnail(). If they each
 * built their own, the file a user downloaded to check could differ from the one the
 * upload actually set, which is exactly the bug that makes a thumbnail feature
 * untrustworthy.
 *
 * Freshness reuses isFreshOutput — the same mtime comparison the render pipeline uses
 * — with the video as the source, so a re-render invalidates the thumbnail for free.
 * The text is not a file, so it is compared separately via a sidecar.
 */

const ffmpegPath = ffmpegStatic as string;

/** The moment the render's own capture uses. Far enough in to be past a fade-up. */
export const GRAB_AT_SECONDS = 1.5;

export function thumbnailDir(): string {
  return process.env.THUMBNAIL_DIR
    || path.join(process.env.OUTPUTS_DIR || path.join(process.cwd(), 'outputs'), 'thumbnails');
}

export const thumbnailPath = (projectId: string): string =>
  path.join(thumbnailDir(), `${projectId}.jpg`);

/** Records the text the current file was drawn with, so changed copy invalidates it. */
const stampPath = (projectId: string): string =>
  path.join(thumbnailDir(), `${projectId}.txt`);

/** The headline for a project, or '' when the SEO agent has not produced one. */
export function thumbnailTextOf(project: any): string {
  const seo = project?.seo_metadata || project?.seoMetadata || {};
  return String(seo.thumbnailText || '').trim();
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.stdout.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => { proc.kill(); resolve({ ok: false, err: `${cmd} timed out` }); }, timeoutMs);
    proc.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, err }); });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, err: e.message }); });
  });
}

export type ThumbnailResult = {
  path: string;
  /** False when the headline could not be drawn and this is the bare captured frame. */
  hasText: boolean;
  regenerated: boolean;
  /** Why the text is missing, for the UI to show rather than silently look plain. */
  note?: string;
};

/**
 * Produces the composited thumbnail, reusing the existing file when it is still current.
 *
 * Never throws for a missing headline or a failed composite — a plain frame is a
 * perfectly good thumbnail and refusing to produce one would take the download button
 * down with it. It DOES throw when there is no video, because then there is nothing to
 * make a thumbnail from and saying so is the only useful answer.
 */
export async function ensureThumbnail(
  projectId: string,
  videoPath: string,
  text: string,
): Promise<ThumbnailResult> {
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error('This project has no rendered video to take a thumbnail from.');
  }

  const out = thumbnailPath(projectId);
  const stamp = stampPath(projectId);
  const wanted = text.trim();
  const drawnWith = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf-8') : null;

  if (isFreshOutput(out, videoPath) && drawnWith === wanted) {
    return { path: out, hasText: Boolean(wanted), regenerated: false };
  }

  fs.mkdirSync(thumbnailDir(), { recursive: true });
  const frame = path.join(os.tmpdir(), `thumb-frame-${projectId}-${Date.now()}.jpg`);

  const grab = await run(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(GRAB_AT_SECONDS), '-i', videoPath,
    '-vframes', '1', '-q:v', '2', '-y', frame,
  ], 60_000);

  if (!grab.ok || !fs.existsSync(frame)) {
    throw new Error(`Could not read a frame from the video: ${grab.err.slice(-200) || 'ffmpeg failed'}`);
  }

  let hasText = false;
  let note: string | undefined;

  if (wanted) {
    const script = path.join(process.cwd(), 'src', 'scripts', 'thumbnail_text.py');
    const draw = await run('py', [script, '--input', frame, '--text', wanted, '--output', out], 90_000);
    hasText = draw.ok && fs.existsSync(out);
    if (!hasText) note = `The headline could not be drawn (${draw.err.trim().slice(-160) || 'compositor failed'}); this is the plain frame.`;
  } else {
    note = 'This project has no thumbnailText yet, so the frame is unlettered.';
  }

  // Whatever happened to the text, there must still be a thumbnail at the end of this.
  if (!hasText) fs.copyFileSync(frame, out);
  fs.writeFileSync(stamp, hasText ? wanted : '');
  fs.promises.unlink(frame).catch(() => {});

  return { path: out, hasText, regenerated: true, note };
}
