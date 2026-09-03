import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { killOnAbort } from './spawnAbort.js';
import { AIService } from './aiService.js';
import { isFreshOutput } from './renderService.js';

/**
 * Softens the fake lettering the image model draws whether or not it was asked to.
 *
 * The prompt-level ban does not work. A controlled A/B over 16 freshly generated images
 * put rendered text in 6/8 without the ban and 5/8 with it, and one of the failures came
 * from a prompt that named no screen, no code and no interface at all — a person leaning
 * back at a desk, answered with a monitor full of code. That is a bias in the weights,
 * not a prompt the model misread, so the fix has to live after generation. The letterbox
 * work reached the same conclusion about black bars and for the same reason.
 *
 * Why this matters more since the upscaler landed: measured on a fresh still, Real-ESRGAN
 * takes a text region from detail 43.7 to 735.2. Soft coloured mush that a viewer skims
 * past becomes hard-edged shapes that read unmistakably as not-quite-letters. The
 * upscaler is not doing anything wrong — it is an amplifier, and this is what it
 * amplifies.
 *
 * OFF BY DEFAULT (DEFOCUS_FAKE_TEXT=true), same shape as UPSCALE_IMAGES: it spends one
 * vision call per still, and a detector that fires on the wrong region costs real detail.
 *
 * Runs BEFORE the upscale, and that ordering is measured rather than assumed — see the
 * note on the call site in renderService.
 */
export const defocusEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.DEFOCUS_FAKE_TEXT === 'true';

/** Detection passes unioned per still. See detectTextRegions for why this is 4. */
const PASSES = Number(process.env.DEFOCUS_PASSES || '4');

/** Where the defocused copy of `src` lives. Kept beside it so one delete clears both. */
export const defocusedPathFor = (src: string): string =>
  path.join(path.dirname(src), `${path.basename(src, path.extname(src))}_df.png`);

/** Where the recorded verdict for `src` lives — written even when nothing was found. */
export const detectionNotePath = (src: string): string =>
  path.join(path.dirname(src), `${path.basename(src, path.extname(src))}_df.json`);

/** A box as the detector reports it: normalised 0-1000, Gemini's own convention. */
export interface TextBox { ymin: number; xmin: number; ymax: number; xmax: number }

const DETECT_PROMPT = `Find every region of this image where written characters are ACTUALLY LEGIBLE.

Return ONLY JSON, no prose and no markdown fence:
{"regions": [{"ymin": 0, "xmin": 0, "ymax": 0, "xmax": 0, "what": "short description", "on": "screen"}]}

Coordinates are normalised 0-1000 with the origin at the top-left.

The test for including a region is strict: you must be able to make out individual character
shapes there -- letters, digits or code tokens -- clearly enough to say what they are. Report
what you can actually resolve, never what you infer must be there because a screen is present.

DO report: readable code or text on a monitor, phone or tablet; readable UI labels, menus and
tabs; signage; readable text printed on equipment. When the characters sit on a screen, bound
the ENTIRE screen -- sidebars, toolbars, tabs and status strips included, edge to edge -- since
those strips carry the same lettering and stay readable when only the middle is softened.

DO NOT report: rows of indicator lights or LEDs on server racks and equipment, however much
they resemble rows of characters; keyboard key legends; blurred, distant or out-of-focus areas
where you can tell something is written but cannot resolve the characters; any surface with no
writing on it. A region you would describe as "probably text" does not qualify.

Set "on" to what the characters are physically written on, which decides how the region is
treated: "screen" when they sit on a display, panel, sign or printed page -- a surface whose
whole job is to carry the lettering; "surface" when they are projected, reflected or overlaid
onto something else, above all a person's face or body. Softening a screen costs nothing
because the screen is only its content; softening a face costs the face. If you are unsure,
answer "screen".

Never bound individual characters. If nothing is legible anywhere, return {"regions": []}.`;

/**
 * Text regions the vision model finds in `imagePath`, as pixel boxes.
 *
 * Returns [] on any failure, which is the safe direction: a missed region leaves the
 * still exactly as it is today, while a spurious one costs real detail.
 */
export async function detectTextRegions(
  imagePath: string,
  size: { width: number; height: number },
  passes = PASSES,
): Promise<{ boxes: number[][]; labels: string[]; modes: string[]; complete: boolean; seconds: number }> {
  const t0 = Date.now();
  // Four passes, unioned. The strict legibility bar above is what keeps a rack of
  // indicator LEDs from being read as rows of characters, and it holds across repeated
  // passes -- but at that bar one pass is far less repeatable than first estimated, so
  // two of them were not enough. Head to head on a real failing still (fake code on a
  // monitor, in the corners and dim), 8 trials each: 2 passes fired 3/8, 4 passes fired
  // 6/8. That 2-pass number is exactly what shipped -- two calls on the same file inside
  // one render, one clearing it and one catching it.
  //
  // Do not read the union as independent trials; it is not. Single passes measured 3/8
  // on their own, which would predict 85% for four of them rather than the 75% observed.
  //
  // Four is also not a guess about cost. That render paid 2 calls x 2 passes per still
  // because the caller processed each still twice; the call site now resolves a shared
  // still once, so 1 call x 4 passes is the SAME vision spend as before, and it is paid
  // once ever rather than once per render now the verdict is recorded. Going deeper is
  // tempting -- false positives measured 0/8 on the server-rack LED plate at both depths
  // -- but a hit is not free: the one box that did fire covered half the subject's face
  // as well as the screen. So recall is bought only as far as the old budget pays for it.
  // Boxes that overlap simply soften the same pixels twice. DEFOCUS_PASSES tunes it.
  const boxes: number[][] = [];
  const labels: string[] = [];
  const modes: string[] = [];
  let complete = true;
  for (let i = 0; i < Math.max(1, passes); i++) {
    const found = await detectOnce(imagePath, size);
    if (!found.ok) complete = false;
    boxes.push(...found.boxes);
    labels.push(...found.labels);
    modes.push(...found.modes);
  }
  return { boxes, labels, modes, complete, seconds: (Date.now() - t0) / 1000 };
}

/** One detection call. Returns [] on any failure, which leaves the still as it is. */
async function detectOnce(
  imagePath: string,
  size: { width: number; height: number },
): Promise<{ boxes: number[][]; labels: string[]; modes: string[]; ok: boolean }> {
  const empty = { boxes: [] as number[][], labels: [] as string[], modes: [] as string[], ok: false };
  try {
    const b64 = fs.readFileSync(imagePath).toString('base64');
    const raw = await AIService.analyzeImage(b64, DETECT_PROMPT, { json: true });
    const parsed = JSON.parse(String(raw).replace(/```json|```/g, '').trim());
    const regions: any[] = Array.isArray(parsed?.regions) ? parsed.regions : [];
    const boxes: number[][] = [];
    const labels: string[] = [];
    const modes: string[] = [];
    for (const r of regions) {
      const y0 = Number(r?.ymin), x0 = Number(r?.xmin), y1 = Number(r?.ymax), x1 = Number(r?.xmax);
      if (![y0, x0, y1, x1].every((n) => Number.isFinite(n))) continue;
      const px = [
        Math.round((Math.min(x0, x1) / 1000) * size.width),
        Math.round((Math.min(y0, y1) / 1000) * size.height),
        Math.round((Math.max(x0, x1) / 1000) * size.width),
        Math.round((Math.max(y0, y1) / 1000) * size.height),
      ];
      // A box covering nearly the whole frame is the detector giving up rather than
      // localising, and acting on it would defocus the entire still.
      const area = ((px[2] - px[0]) * (px[3] - px[1])) / (size.width * size.height);
      if (px[2] - px[0] < 8 || px[3] - px[1] < 8 || area > 0.6) continue;
      boxes.push(px);
      labels.push(String(r?.what ?? '').slice(0, 60));
      // Anything but an explicit 'surface' is treated as a screen, which is the
      // unchanged behaviour and the safe direction.
      modes.push(String(r?.on ?? '').toLowerCase() === 'surface' ? 'surface' : 'screen');
    }
    return { boxes, labels, modes, ok: true };
  } catch (e: any) {
    console.warn('[Defocus] detection skipped:', String(e?.message).slice(0, 120));
    return empty;
  }
}

/**
 * Returns the path the render should use: a copy with any text regions defocused when
 * there were any, otherwise `src` unchanged. Never throws and never blocks a render.
 */
export async function defocusImage(
  src: string,
  opts: { env?: NodeJS.ProcessEnv; size?: { width: number; height: number }; signal?: AbortSignal } = {},
): Promise<string> {
  const env = opts.env || process.env;
  if (!defocusEnabled(env) || !src || !fs.existsSync(src)) return src;

  const out = defocusedPathFor(src);
  // A softened copy that is newer than its source is the whole answer already.
  if (isFreshOutput(out, src)) return out;

  try {
    // The verdict is decided once per still and written down, INCLUDING "nothing here".
    // Before this, a still the detector cleared produced no file at all, so the mtime
    // check below could never hit for it: every render paid the vision call again, and
    // since a fresh verdict is not fully repeatable it could come back different each
    // time. Recording it makes a given still answer the same way on every later render,
    // and drops the repeat cost to a file read. Regenerating the still invalidates it,
    // same mtime rule the upscale uses.
    let found = readVerdict(src);
    if (!found) {
      const size = opts.size || (await imageSize(src, opts.signal));
      if (!size) return src;
      const { boxes, labels, modes, complete, seconds } = await detectTextRegions(src, size);
      found = { boxes, labels, modes };
      // Only a verdict every pass actually returned is worth remembering. A dropped
      // connection makes detectOnce fail open with no boxes, which is the right call
      // for this render — but recording it would freeze "nothing here" onto the still
      // for good. Caught in testing: one ECONNRESET mid-run cached an empty verdict for
      // a frame that plainly carries fake code.
      if (complete) writeVerdict(src, found);
      console.log(`[Defocus] ${boxes.length ? `found ${boxes.length} region(s)` : 'no text found'}`
        + ` in ${path.basename(src)} (${seconds.toFixed(1)}s`
        + `${complete ? '' : ', incomplete — not recorded'})`);
    }
    if (!found.boxes.length) return src;

    const note = await runWorker(src, out, found.boxes, found.modes ?? [], opts.signal);
    if (note?.ok && fs.existsSync(out)) {
      console.log(`[Defocus] softened ${found.boxes.length} region(s) in ${path.basename(src)}` +
        ` — ${found.labels.join('; ').slice(0, 120)}`);
      return out;
    }
  } catch (e: any) {
    console.warn('[Defocus] skipped:', String(e?.message).slice(0, 120));
  }
  return src;
}

/** The recorded verdict for `src`, or null when there is none current for it. */
export function readVerdict(src: string): { boxes: number[][]; labels: string[]; modes: string[] } | null {
  const note = detectionNotePath(src);
  if (!isFreshOutput(note, src)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(note, 'utf8'));
    // A note written before modes existed reads as all-screen, which is the treatment
    // it actually got, so an old cache stays consistent with the frame beside it.
    return Array.isArray(j?.boxes) ? { boxes: j.boxes, labels: j.labels ?? [], modes: j.modes ?? [] } : null;
  } catch {
    return null; // an unreadable note just means detecting again
  }
}

/** Records a verdict beside the still. Never throws: this is a cache, not the answer. */
function writeVerdict(src: string, v: { boxes: number[][]; labels: string[]; modes: string[] }): void {
  try {
    fs.writeFileSync(detectionNotePath(src), JSON.stringify(v));
  } catch { /* a render that cannot cache still renders */ }
}

/** Width and height of a PNG/JPEG, read via the worker so nothing new is imported. */
async function imageSize(src: string, signal?: AbortSignal): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const proc = spawn('py', ['-c',
      `import cv2,json,sys;i=cv2.imread(sys.argv[1]);print(json.dumps({'width':i.shape[1],'height':i.shape[0]} if i is not None else {}))`,
      src]);
    let out = '';
    const timer = setTimeout(() => { proc.kill(); resolve(null); }, 20000);
    const stopWatching = killOnAbort(proc, signal);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => {
      clearTimeout(timer);
      stopWatching();
      try {
        const j = JSON.parse(out.trim());
        resolve(j?.width && j?.height ? j : null);
      } catch { resolve(null); }
    });
    proc.on('error', () => { clearTimeout(timer); stopWatching(); resolve(null); });
  });
}

function runWorker(src: string, dst: string, boxes: number[][], modes: string[], signal?: AbortSignal): Promise<any> {
  return new Promise((resolve) => {
    const script = path.join(process.cwd(), 'src/scripts/text_defocus.py');
    const proc = spawn('py', [script, src, dst, '--boxes', JSON.stringify(boxes), '--modes', JSON.stringify(modes)]);
    let out = '';
    let err = '';
    const timer = setTimeout(() => { proc.kill(); resolve(null); }, 60000);
    const stopWatching = killOnAbort(proc, signal);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      stopWatching();
      if (code !== 0 && err.trim()) console.warn('[Defocus] worker:', err.trim().slice(0, 200));
      try { resolve(JSON.parse(out.trim())); } catch { resolve(null); }
    });
    proc.on('error', (e) => { clearTimeout(timer); stopWatching(); console.warn('[Defocus] spawn:', e.message); resolve(null); });
  });
}
