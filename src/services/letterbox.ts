import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

/**
 * Removes the black bars the image model bakes into a generated still.
 *
 * Asked for 16:9, the model honours that as a *canvas* and then often draws a film
 * still on it — picture in the middle, bars top and bottom. Nothing downstream took
 * them off: the render scales whatever it is given to fill the frame, so the bars were
 * scaled up with it. Measured over this project's 187 stored stills, 24% carry bars,
 * the worst losing 53% of the height; one real 1344x768 still put 33.8% black into a
 * finished 1920x1080 frame.
 *
 * Asking the model not to do it is not a fix — a prompt that said "no letterbox, no
 * black bars" produced more bars than one that never raised the subject. So the bars
 * come off here, after generation, where the answer is deterministic.
 *
 * This sits on the byte path shared by all three writers (assetService, orchestrator,
 * projectController), so every render path and the thumbnail get a clean still.
 * Fails open: any error returns the original bytes rather than losing the image.
 */
export async function stripLetterbox(buffer: Buffer): Promise<Buffer> {
  const dir = path.join(os.tmpdir(), 's2v-letterbox');
  const id = randomUUID();
  const src = path.join(dir, `${id}-in.png`);
  const dst = path.join(dir, `${id}-out.png`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(src, buffer);
    const note = await run(path.join(process.cwd(), 'src/scripts/letterbox_strip.py'), src, dst);
    if (note && note !== 'none' && fs.existsSync(dst)) {
      const out = fs.readFileSync(dst);
      // A near-empty result means the crop went wrong; the original is the safer bytes.
      if (out.length > 1024) {
        console.log(`[Letterbox] stripped ${note}`);
        return out;
      }
    }
  } catch (e: any) {
    console.warn('[Letterbox] skipped:', e?.message);
  } finally {
    for (const f of [src, dst]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  }
  return buffer;
}

function run(script: string, src: string, dst: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn('py', [script, src, dst]);
    let out = '';
    let err = '';
    const timer = setTimeout(() => { proc.kill(); resolve(''); }, 30000);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && err.trim()) console.warn('[Letterbox] worker:', err.trim().slice(0, 200));
      resolve(code === 0 ? out.trim() : '');
    });
    proc.on('error', (e) => { clearTimeout(timer); console.warn('[Letterbox] spawn:', e.message); resolve(''); });
  });
}
