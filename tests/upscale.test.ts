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
