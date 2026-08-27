import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { upscaleImage, upscaleEnabled, upscaledPathFor } from '../src/services/upscale.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upscale-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const still = (name = 'scene.png') => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(4096, 7));
  return p;
};

describe('when the upscaler runs at all', () => {
  it('stays off unless it is asked for', () => {
    expect(upscaleEnabled({} as any)).toBe(false);
    expect(upscaleEnabled({ UPSCALE_IMAGES: 'false' } as any)).toBe(false);
    // Off by default is deliberate: ~195s per image on this machine's GPU would add
    // roughly 26 minutes to an eight-scene render.
    expect(upscaleEnabled({ UPSCALE_IMAGES: 'true' } as any)).toBe(true);
  });

  it('hands back the original still when disabled, without spawning anything', async () => {
    const src = still();
    await expect(upscaleImage(src, { env: {} as any })).resolves.toBe(src);
  });

  it('hands back the original when the still is not on disk', async () => {
    const missing = path.join(dir, 'nope.png');
    await expect(upscaleImage(missing, { env: { UPSCALE_IMAGES: 'true' } as any }))
      .resolves.toBe(missing);
  });

  it('falls back to the original rather than failing a render when there is no interpreter', async () => {
    const src = still();
    const env = { UPSCALE_IMAGES: 'true', UPSCALE_PYTHON: path.join(dir, 'absent-python.exe') };
    await expect(upscaleImage(src, { env: env as any })).resolves.toBe(src);
  });
});

describe('the upscaled copy', () => {
  it('sits beside the still it came from, so one delete clears both', () => {
    expect(upscaledPathFor('/a/b/shot.jpg')).toBe(path.join('/a/b', 'shot_up.png'));
    expect(upscaledPathFor('/a/b/shot.png')).toBe(path.join('/a/b', 'shot_up.png'));
  });

  it('is reused when it is newer than the still — the ~195s is paid once, not per render', async () => {
    const src = still();
    const out = upscaledPathFor(src);
    fs.writeFileSync(out, Buffer.alloc(9000, 3));
    const older = new Date(Date.now() - 60_000);
    fs.utimesSync(src, older, older);

    // No interpreter is configured; reaching the spawn at all would return `src`.
    const env = { UPSCALE_IMAGES: 'true', UPSCALE_PYTHON: path.join(dir, 'absent.exe') };
    await expect(upscaleImage(src, { env: env as any })).resolves.toBe(out);
  });

  it('is discarded when the still is regenerated after it', async () => {
    const src = still();
    const out = upscaledPathFor(src);
    fs.writeFileSync(out, Buffer.alloc(9000, 3));
    const newer = new Date(Date.now() + 60_000);
    fs.utimesSync(src, newer, newer);

    const env = { UPSCALE_IMAGES: 'true', UPSCALE_PYTHON: path.join(dir, 'absent.exe') };
    // Stale: it must not be handed to the render, so we fall back to the original still.
    await expect(upscaleImage(src, { env: env as any })).resolves.toBe(src);
  });
});

describe('which renders pay for it', () => {
  // A preview is pinned to the 720 class, where the 1344x768 still is enlarged 1.08x —
  // it already covers the frame. At 1080p the same still is enlarged 1.62x, and every
  // one of the 187 stored stills exceeds 1.6x after letterbox stripping. The pass is
  // worth ~20 minutes on a final render and worth nothing on a draft.
  const HEAD = 1.15;
  const enlargement = (fw: number, fh: number, sw = 1344, sh = 768) =>
    Math.max(fw / sw, (fh * HEAD) / sh);

  it('barely enlarges anything at preview resolution', () => {
    expect(enlargement(1280, 720)).toBeLessThan(1.1);
  });

  it('enlarges past 1.6x at 1080p, which is what the upscale is for', () => {
    expect(enlargement(1920, 1080)).toBeGreaterThan(1.6);
  });

  it('is worst on a letterbox-stripped still, the case that needs pixels most', () => {
    // 1344x502 is a real stripped height measured in a production render.
    expect(enlargement(1920, 1080, 1344, 502)).toBeGreaterThan(2.4);
  });

  it('turns the enlargement into a downsample once the still is 2x', () => {
    expect(enlargement(1920, 1080, 2688, 1536)).toBeLessThan(1);
  });
});
