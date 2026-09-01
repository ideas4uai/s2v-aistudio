import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
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

/** Detection passes unioned per still. See detectTextRegions for why this is 2. */
const PASSES = Number(process.env.DEFOCUS_PASSES || '2');

/** Where the defocused copy of `src` lives. Kept beside it so one delete clears both. */
export const defocusedPathFor = (src: string): string =>
  path.join(path.dirname(src), `${path.basename(src, path.extname(src))}_df.png`);

/** A box as the detector reports it: normalised 0-1000, Gemini's own convention. */
export interface TextBox { ymin: number; xmin: number; ymax: number; xmax: number }

const DETECT_PROMPT = `Find every region of this image where written characters are ACTUALLY LEGIBLE.

Return ONLY JSON, no prose and no markdown fence:
{"regions": [{"ymin": 0, "xmin": 0, "ymax": 0, "xmax": 0, "what": "short description"}]}

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
): Promise<{ boxes: number[][]; labels: string[]; seconds: number }> {
  const t0 = Date.now();
  // Two passes, unioned. The strict legibility bar above is what keeps a rack of
  // indicator LEDs from being read as rows of characters, and it holds across repeated
  // passes -- but at that bar a single pass also misses real text about a quarter of the
  // time, and measured over three passes each of those misses was sampling noise rather
  // than a stable judgement. Seven more seconds against a 430s upscale is not a cost
  // worth optimising, and boxes that overlap simply soften the same pixels twice.
  const boxes: number[][] = [];
  const labels: string[] = [];
  for (let i = 0; i < Math.max(1, passes); i++) {
    const found = await detectOnce(imagePath, size);
    boxes.push(...found.boxes);
    labels.push(...found.labels);
  }
  return { boxes, labels, seconds: (Date.now() - t0) / 1000 };
}

/** One detection call. Returns [] on any failure, which leaves the still as it is. */
async function detectOnce(
  imagePath: string,
  size: { width: number; height: number },
): Promise<{ boxes: number[][]; labels: string[] }> {
  const empty = { boxes: [] as number[][], labels: [] as string[] };
  try {
    const b64 = fs.readFileSync(imagePath).toString('base64');
    const raw = await AIService.analyzeImage(b64, DETECT_PROMPT, { json: true });
    const parsed = JSON.parse(String(raw).replace(/```json|```/g, '').trim());
    const regions: any[] = Array.isArray(parsed?.regions) ? parsed.regions : [];
    const boxes: number[][] = [];
    const labels: string[] = [];
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
    }
    return { boxes, labels };
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
  opts: { env?: NodeJS.ProcessEnv; size?: { width: number; height: number } } = {},
): Promise<string> {
  const env = opts.env || process.env;
  if (!defocusEnabled(env) || !src || !fs.existsSync(src)) return src;

  const out = defocusedPathFor(src);
  // Same mtime rule as the upscale: the vision call is paid once per still, not once
  // per render, and regenerating the image invalidates the copy.
  if (isFreshOutput(out, src)) return out;

  try {
    const size = opts.size || (await imageSize(src));
    if (!size) return src;
    const { boxes, labels, seconds } = await detectTextRegions(src, size);
    if (!boxes.length) {
      console.log(`[Defocus] no text found in ${path.basename(src)} (${seconds.toFixed(1)}s)`);
      return src;
    }
    const note = await runWorker(src, out, boxes);
    if (note?.ok && fs.existsSync(out)) {
      console.log(`[Defocus] softened ${boxes.length} region(s) in ${path.basename(src)}` +
        ` (${seconds.toFixed(1)}s detect) — ${labels.join('; ').slice(0, 120)}`);
      return out;
    }
  } catch (e: any) {
    console.warn('[Defocus] skipped:', String(e?.message).slice(0, 120));
  }
  return src;
}

/** Width and height of a PNG/JPEG, read via the worker so nothing new is imported. */
async function imageSize(src: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const proc = spawn('py', ['-c',
      `import cv2,json,sys;i=cv2.imread(sys.argv[1]);print(json.dumps({'width':i.shape[1],'height':i.shape[0]} if i is not None else {}))`,
      src]);
    let out = '';
    const timer = setTimeout(() => { proc.kill(); resolve(null); }, 20000);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out.trim());
        resolve(j?.width && j?.height ? j : null);
      } catch { resolve(null); }
    });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

function runWorker(src: string, dst: string, boxes: number[][]): Promise<any> {
  return new Promise((resolve) => {
    const script = path.join(process.cwd(), 'src/scripts/text_defocus.py');
    const proc = spawn('py', [script, src, dst, '--boxes', JSON.stringify(boxes)]);
    let out = '';
    let err = '';
    const timer = setTimeout(() => { proc.kill(); resolve(null); }, 60000);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && err.trim()) console.warn('[Defocus] worker:', err.trim().slice(0, 200));
      try { resolve(JSON.parse(out.trim())); } catch { resolve(null); }
    });
    proc.on('error', (e) => { clearTimeout(timer); console.warn('[Defocus] spawn:', e.message); resolve(null); });
  });
}
