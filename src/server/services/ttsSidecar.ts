import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import readline from 'readline';

/**
 * Client for the long-lived Python TTS workers (`src/scripts/tts_sidecar.py`).
 *
 * A worker is started on first use and kept for the life of the server process.
 * Loading Kokoro costs ~15s and an episode is 6-10 scenes, so spawning per scene
 * would spend more time loading models than synthesising with them.
 *
 * There are two interpreters, not one, and that is forced rather than chosen:
 * chatterbox-tts pins torch 2.6 / numpy 1.26 / transformers 5.2, and installing it
 * alongside Kokoro downgrades all three and breaks Kokoro outright
 * (`ModuleNotFoundError: Could not import module 'AlbertModel'`). They get one
 * environment each.
 *
 *   KOKORO -> TTS_PYTHON   (default `python`)   — the default engine, every render
 *   CLONE  -> CLONE_PYTHON (default .venv-clone) — cloning and cloned-voice synthesis
 *
 * Neither is the `py` launcher, which resolves to 3.11 here — the interpreter the
 * render engine (cv2, metro_engine_v4) depends on. Keeping TTS off it means a TTS
 * dependency change can never break a render.
 */

const SCRIPT = path.join(process.cwd(), 'src', 'scripts', 'tts_sidecar.py');
const READY_TIMEOUT_MS = 180_000;

export type SidecarKind = 'kokoro' | 'clone';

export function pythonFor(kind: SidecarKind): string {
  if (kind === 'clone') {
    return process.env.CLONE_PYTHON
      || path.join(process.cwd(), '.venv-clone', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  }
  return process.env.TTS_PYTHON || 'python';
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

type Sidecar = {
  child: ChildProcessWithoutNullStreams | null;
  ready: Promise<void> | null;
  pending: Map<string, Pending>;
};

const sidecars: Record<SidecarKind, Sidecar> = {
  kokoro: { child: null, ready: null, pending: new Map() },
  clone: { child: null, ready: null, pending: new Map() },
};

let seq = 0;

export class SidecarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SidecarError';
  }
}

function failAll(sc: Sidecar, reason: string) {
  for (const [, p] of sc.pending) {
    clearTimeout(p.timer);
    p.reject(new SidecarError(reason));
  }
  sc.pending.clear();
}

function start(kind: SidecarKind): Promise<void> {
  const sc = sidecars[kind];
  const bin = pythonFor(kind);
  const proc = spawn(bin, ['-u', SCRIPT], { windowsHide: true, cwd: process.cwd() });
  sc.child = proc;

  // stderr carries model-loading chatter and tracebacks. It is diagnostic only —
  // the protocol lives entirely on stdout.
  proc.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) console.log(`[TTS/${kind}] ${s.split('\n').slice(-3).join(' | ')}`);
  });

  const readyPromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new SidecarError(`${kind} TTS sidecar did not become ready within ${READY_TIMEOUT_MS}ms`)),
      READY_TIMEOUT_MS,
    );

    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        // Not protocol traffic. The worker points fd 1 at stderr during requests
        // precisely so this stays empty, but a library that writes before the first
        // request could still land here — log it rather than dying on it.
        console.log(`[TTS/${kind}] ${line}`);
        return;
      }
      if (msg.id === '__ready__') {
        clearTimeout(timer);
        console.log(`[TTS] ${kind} sidecar ready (python ${msg.python})`);
        resolve();
        return;
      }
      const p = sc.pending.get(msg.id);
      if (!p) return;
      sc.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(new SidecarError(msg.error || 'unknown sidecar error'));
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new SidecarError(
        `Could not start "${bin}" for the ${kind} sidecar: ${err.message}. ` +
        (kind === 'clone'
          ? 'Create it with: python -m venv .venv-clone && .venv-clone/Scripts/python -m pip install chatterbox-tts psutil soundfile'
          : 'Set TTS_PYTHON to a Python 3 with kokoro installed (pip install "kokoro>=0.9.2" soundfile).'),
      ));
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      sc.child = null;
      sc.ready = null;
      const why = `${kind} TTS sidecar exited with code ${code}`;
      failAll(sc, why);
      reject(new SidecarError(why));
    });
  });

  // An exit after startup rejects an already-settled promise, which is a no-op, but
  // an unhandled rejection would still take the server down — same hazard as the
  // audio/visual promise guards in orchestrator.ts.
  readyPromise.catch(() => {});
  return readyPromise;
}

export async function sidecarRequest(
  kind: SidecarKind,
  req: Record<string, unknown>,
  timeoutMs = 600_000,
): Promise<any> {
  const sc = sidecars[kind];
  if (!sc.ready) sc.ready = start(kind);
  await sc.ready;
  if (!sc.child) throw new SidecarError(`${kind} TTS sidecar is not running`);

  const id = String(++seq);
  const proc = sc.child;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sc.pending.delete(id);
      reject(new SidecarError(`${kind} sidecar request "${req.op}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    sc.pending.set(id, { resolve, reject, timer });
    proc.stdin.write(JSON.stringify({ ...req, id }) + '\n', (err) => {
      if (!err) return;
      sc.pending.delete(id);
      clearTimeout(timer);
      reject(new SidecarError(`Failed to write to the ${kind} TTS sidecar: ${err.message}`));
    });
  });
}

/** True if a sidecar can be started and answers. Used by the health check and the UI. */
export async function sidecarAvailable(kind: SidecarKind): Promise<{ ok: boolean; error?: string }> {
  try {
    await sidecarRequest(kind, { op: 'ping' }, READY_TIMEOUT_MS + 10_000);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export function stopSidecars() {
  for (const kind of Object.keys(sidecars) as SidecarKind[]) {
    const sc = sidecars[kind];
    failAll(sc, `${kind} TTS sidecar stopped`);
    sc.child?.kill();
    sc.child = null;
    sc.ready = null;
  }
}
