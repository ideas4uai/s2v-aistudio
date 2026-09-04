import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { isFreshOutput } from './renderService.js';
import { killOnAbort } from './spawnAbort.js';

/**
 * Runs a generated still through Real-ESRGAN before the render magnifies it.
 *
 * The image model is pinned at 1.03 MP and ignores every request for more, so the
 * render was always enlarging a 1 MP source to fill a 2.07 MP frame — worse once
 * letterbox bars come off a still that was already small. Upscaling 2x hands the render
 * a 4.1 MP source it DOWNsamples instead, which is the whole point.
 *
 * OFF BY DEFAULT, and that is a hardware call rather than a preference: measured on this
 * machine's 940MX, x4plus takes ~195s for one 1344x768 still (192.7s and 197.5s on two
 * clean runs). Eight scenes is roughly 26 minutes added to a render that otherwise takes
 * ten, so switching it on silently would make every render look hung. The cost is paid
 * once per still, not once per render — see the freshness check below. Set
 * UPSCALE_IMAGES=true to enable it; same env-flag shape as USE_DEPTH_PARALLAX.
 *
 * Order matters: letterbox bars come off FIRST, then this runs. Upscaling first would
 * spend those minutes sharpening black bars that are about to be discarded — up to 53%
 * of the image on the worst stills — and would harden the bar/picture boundary into an
 * edge artifact. Stripping first also makes the remaining picture smaller, which is
 * exactly the case that needs the pixels most.
 */
export const upscaleEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.UPSCALE_IMAGES === 'true';

/** Where the upscaled copy of `src` lives. Kept beside it so one delete clears both. */
export const upscaledPathFor = (src: string): string =>
  path.join(path.dirname(src), `${path.basename(src, path.extname(src))}_up.png`);

/**
 * Returns the path the render should use: the upscaled copy when one is available and
 * current, otherwise `src` unchanged. Never throws and never blocks a render — a missing
 * venv, a cold GPU or a timeout all fall back to the original image.
 *
 * There is deliberately no face-restoration pass. GFPGAN was built and measured here
 * and made things worse: it restores every face at a fixed 512x512 and pastes back, so
 * on a 2x-upscaled still (close-up faces run ~863px) it re-enlarges the restored face
 * 1.69x and smooths away the detail this pass just recovered — laplacian variance
 * 310.8 -> 88.8, against 77.4 for no upscale at all.
 */
export async function upscaleImage(
  src: string,
  opts: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<string> {
  const env = opts.env || process.env;
  if (!upscaleEnabled(env) || !src || !fs.existsSync(src)) return src;

  const out = upscaledPathFor(src);
  // mtime-based, same rule the rest of the render uses: regenerate the still and the
  // upscale goes stale with it; leave it alone and the ~195s is paid exactly once.
  if (isFreshOutput(out, src)) return out;

  const python = env.UPSCALE_PYTHON || path.join(process.cwd(), '.venv-upscale/Scripts/python.exe');
  if (!fs.existsSync(python)) {
    console.warn('[Upscale] skipped — no interpreter at', python);
    return src;
  }

  const args = [path.join(process.cwd(), 'src/scripts/upscale_worker.py'), src, out, '--scale', '2'];

  const ok = await run(python, args, Number(env.UPSCALE_TIMEOUT_MS || 15 * 60 * 1000), opts.signal);
  if (ok && fs.existsSync(out) && fs.statSync(out).size > 1024) return out;

  try { fs.unlinkSync(out); } catch { /* nothing half-written to clear */ }
  return src;
}

function run(python: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(python, args);
    let tail = '';
    const timer = setTimeout(() => { proc.kill(); resolve(false); }, timeoutMs);
    const stopWatching = killOnAbort(proc, signal);
    // The worker prints a per-tile progress line; only the final JSON is worth keeping.
    proc.stdout.on('data', (d) => { tail = (tail + d.toString()).slice(-400); });
    proc.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-400); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const line = tail.trim().split('\n').pop() || '';
      if (code === 0) console.log('[Upscale]', line);
      else console.warn('[Upscale] failed, using the original still:', line.slice(0, 200));
      resolve(code === 0);
    });
    proc.on('error', (e) => { clearTimeout(timer); stopWatching(); console.warn('[Upscale] spawn:', e.message); resolve(false); });
  });
}
