import type { ChildProcess } from 'child_process';

/**
 * Kills `proc` when `signal` aborts, and returns the unsubscribe to call once the
 * process is done with.
 *
 * Cancelling a render used to leave its workers running. POST /cancel aborts the
 * project's AbortController and flips the status, but nothing downstream listened:
 * the only kill path in upscale.ts and textDefocus.ts was the timeout, 15 minutes
 * away. Observed live — a cancelled render's Real-ESRGAN worker was still holding
 * 2519MB 28 seconds later, and would have run to completion.
 *
 * The signal is already per-project, which is what makes this safe: it kills that
 * render's own child and cannot touch a concurrent render's worker. A global sweep
 * (taskkill /F /IM py.exe /T) would kill both.
 *
 * proc.kill() is enough here, measured rather than assumed: the venv launcher spawns
 * the real interpreter as a child (pid 2484 -> 4620, 4MB -> 2519MB), and killing the
 * launcher took both down inside 8 seconds, from model load and from deep in the tile
 * loop. No taskkill /T needed.
 */
export function killOnAbort(proc: ChildProcess, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const kill = () => { try { proc.kill(); } catch { /* already gone */ } };
  if (signal.aborted) { kill(); return () => {}; }
  signal.addEventListener('abort', kill, { once: true });
  // Without this the listener outlives the process, and a long render accumulates one
  // dead reference per still on the signal it shares across every scene.
  return () => signal.removeEventListener('abort', kill);
}
