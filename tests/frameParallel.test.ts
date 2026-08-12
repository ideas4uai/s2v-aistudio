import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Frame synthesis is split across processes by frame range. render(fi) is NOT a pure
// function of fi — the particle system integrates position on every call — so a worker
// starting mid-clip must replay those steps or dust visibly restarts at each boundary.
//
// These assert that property directly against the engine, rather than through a render:
// a full render takes ~40s and needs a background image, which is not something to put
// in the suite. src/scripts/verify_parallel_frames.py covers the end-to-end comparison
// and is the documented procedure for changes to the synthesis loop.

const ENGINE = 'src/scripts/metro_engine_v4.py';

/** Run a snippet against the engine module and return its stdout. */
function py(snippet: string): string {
  return execFileSync('py', ['-c', snippet], { encoding: 'utf-8', timeout: 60_000 }).trim();
}

describe('parallel frame synthesis', () => {
  it('the engine module exposes the pieces parallelisation depends on', () => {
    const src = fs.readFileSync(ENGINE, 'utf-8');
    expect(src).toContain('def warm_to');
    expect(src).toContain('def _render_range');
    expect(src).toContain('def _worker_count');
    // A wedged worker must not hang the render forever.
    expect(src).toContain('WORKER_TIMEOUT_S');
  });

  it('warm_to(n) leaves particles exactly where n sequential steps would', () => {
    const out = py([
      'import sys; sys.path.insert(0, "src/scripts")',
      'import numpy as np, metro_engine_v4 as m',
      'cfg = m.EngineConfig(w=1920, h=1080, fps=24)',
      'def mk():',
      '    return m.ParticleSystemV4("street", cfg, 0.0, 60, 42)',
      'a = mk()',
      '[a.step(1/24, 0.5) for _ in range(97)]',
      'b = mk()',
      'b.warm_to(97, 1/24, 0.5)',
      'print(int(np.allclose(a.x, b.x) and np.allclose(a.y, b.y)))',
    ].join('\n'));
    // If this is 0, every worker after the first renders the wrong particle state.
    expect(out.trim().endsWith('1')).toBe(true);
  });

  it('an aborted encode leaves no partial file behind', () => {
    // Frames now stream into ffmpeg rather than cv2, so a clip that dies half way is a
    // real, playable-looking mp4 of the wrong length. isFreshOutput would date it after
    // its sources and hand it to the next render as finished work.
    const out = path.join(os.tmpdir(), 'ais-abort-probe.mp4');
    const written = py([
      'import sys, os; sys.path.insert(0, "src/scripts")',
      'import numpy as np, metro_engine_v4 as m',
      `out = r"${out.replace(/\\/g, '/')}"`,
      'w, _ = m.open_writer(out, 24, 320, 240)',
      '[w.write(np.zeros((240, 320, 3), dtype=np.uint8)) for _ in range(10)]',
      'w.abort()',
      'print(int(os.path.exists(out)), int(w.proc.poll() is not None))',
    ].join('\n'));
    // file gone, encoder reaped — no partial, no orphan.
    expect(written.trim().endsWith('0 1')).toBe(true);
  });

  it('worker count auto-detects and is overridable, not pinned to 4', () => {
    const out = py([
      'import sys, os; sys.path.insert(0, "src/scripts")',
      'import metro_engine_v4 as m',
      'os.environ["METRO_V4_WORKERS"] = "3"',
      'print("override", m._worker_count(1000))',
      'os.environ.pop("METRO_V4_WORKERS")',
      'print("auto", m._worker_count(1000) <= (os.cpu_count() or 1))',
      'print("short", m._worker_count(10))',
    ].join('\n'));
    expect(out).toContain('override 3');
    expect(out).toContain('auto True');
    // Short clips stay sequential: spawn cost exceeds the saving.
    expect(out).toContain('short 1');
  });
});
