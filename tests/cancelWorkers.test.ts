import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { killOnAbort } from '../src/services/spawnAbort.js';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('cancelling a render kills its workers', () => {
  it('kills the child when the signal aborts', async () => {
    // The bug this covers: POST /cancel aborted the project's controller and flipped the
    // status, but nothing downstream listened. A Real-ESRGAN worker holding 2519MB was
    // still alive 28s after cancel reported success, and had to be killed by hand.
    const ac = new AbortController();
    const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const stop = killOnAbort(proc, ac.signal);
    const exited = new Promise<void>((r) => proc.on('close', () => r()));

    await settle(300);
    expect(alive(proc.pid!)).toBe(true);

    ac.abort();
    await exited;
    stop();
    expect(alive(proc.pid!)).toBe(false);
  }, 20_000);

  it('kills immediately when handed a signal that has already aborted', async () => {
    // A cancel that lands between spawn and the listener being attached must not leave
    // the worker running until its 15-minute timeout.
    const ac = new AbortController();
    ac.abort();
    const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const exited = new Promise<void>((r) => proc.on('close', () => r()));
    killOnAbort(proc, ac.signal);
    await exited;
    expect(alive(proc.pid!)).toBe(false);
  }, 20_000);

  it('leaves other renders alone — the signal is per-project', async () => {
    // Verified live on two concurrent renders: cancelling A killed A's worker inside
    // ~2-7s and released 3.3GB, while B's worker kept running untouched. A global sweep
    // (taskkill /F /IM py.exe /T) would have taken both.
    const a = new AbortController();
    const b = new AbortController();
    const pa = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const pb = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    killOnAbort(pa, a.signal);
    killOnAbort(pb, b.signal);
    const aExit = new Promise<void>((r) => pa.on('close', () => r()));

    await settle(300);
    a.abort();
    await aExit;

    expect(alive(pa.pid!)).toBe(false);
    expect(alive(pb.pid!)).toBe(true);
    pb.kill();
  }, 20_000);

  it('stops listening once the process is done, so a long render leaks no listeners', () => {
    const ac = new AbortController();
    const proc = spawn(process.execPath, ['-e', '0']);
    const before = (ac.signal as any).listenerCount?.('abort') ?? 0;
    const stop = killOnAbort(proc, ac.signal);
    stop();
    const after = (ac.signal as any).listenerCount?.('abort') ?? 0;
    expect(after).toBe(before);
    proc.kill();
  });

  it('is wired into both still passes, with the render own signal', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/services/renderService.ts'), 'utf8');
    expect(src).toContain('defocusImage(p, { signal })');
    expect(src).toContain('upscaleImage(p, { signal })');
  });

  it('is accepted by the workers that actually hold the memory', () => {
    const up = fs.readFileSync(path.join(process.cwd(), 'src/services/upscale.ts'), 'utf8');
    const df = fs.readFileSync(path.join(process.cwd(), 'src/services/textDefocus.ts'), 'utf8');
    for (const s of [up, df]) expect(s).toContain('killOnAbort(proc, signal)');
  });
});
