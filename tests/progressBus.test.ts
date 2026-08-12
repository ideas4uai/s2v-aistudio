import { describe, it, expect, beforeEach } from 'vitest';
import { progressBus, isTerminal, ProgressEvent } from '../src/server/progressBus.js';

// Live render progress. The two properties worth pinning are the ones that are cheap to
// get wrong and expensive to notice: a client must never receive another project's
// events, and a client that goes away must not leave a listener behind. This thread has
// already produced orphaned server processes and orphaned ffmpeg; an orphaned listener
// per abandoned tab is the same failure wearing different clothes.

const A = 'project-a';
const B = 'project-b';

beforeEach(() => {
  progressBus.forget(A);
  progressBus.forget(B);
});

describe('per-project scoping', () => {
  it('does not deliver one project\'s events to another project\'s subscriber', () => {
    const gotA: ProgressEvent[] = [];
    const gotB: ProgressEvent[] = [];
    const offA = progressBus.subscribe(A, (e) => gotA.push(e));
    const offB = progressBus.subscribe(B, (e) => gotB.push(e));

    progressBus.emit({ projectId: A, stage: 'scene', message: 'a1' });
    progressBus.emit({ projectId: B, stage: 'scene', message: 'b1' });
    progressBus.emit({ projectId: A, stage: 'segment', message: 'a2' });

    expect(gotA.map((e) => e.message)).toEqual(['a1', 'a2']);
    expect(gotB.map((e) => e.message)).toEqual(['b1']);
    expect(gotA.every((e) => e.projectId === A)).toBe(true);
    offA(); offB();
  });

  it('keeps the latest event per project separately', () => {
    progressBus.emit({ projectId: A, stage: 'tts', message: 'a-latest' });
    progressBus.emit({ projectId: B, stage: 'stitch', message: 'b-latest' });
    expect(progressBus.latest(A)?.message).toBe('a-latest');
    expect(progressBus.latest(B)?.message).toBe('b-latest');
  });
});

describe('listener lifecycle', () => {
  it('releases the listener when the subscriber unsubscribes', () => {
    expect(progressBus.listenerCount(A)).toBe(0);
    const off1 = progressBus.subscribe(A, () => {});
    const off2 = progressBus.subscribe(A, () => {});
    expect(progressBus.listenerCount(A)).toBe(2);
    off1();
    expect(progressBus.listenerCount(A)).toBe(1);
    off2();
    // The leak check: a disconnected client must leave nothing behind.
    expect(progressBus.listenerCount(A)).toBe(0);
  });

  it('does not accumulate listeners across repeated connect/disconnect cycles', () => {
    for (let i = 0; i < 200; i++) progressBus.subscribe(A, () => {})();
    expect(progressBus.listenerCount(A)).toBe(0);
  });
});

describe('reconnect mid-render', () => {
  it('replays the current stage to a client that connects late', () => {
    progressBus.emit({
      projectId: A, stage: 'synthesis', message: 'Rendering animation',
      sceneIndex: 3, sceneTotal: 6, reused: false,
    });

    // What the SSE route sends on connect: a refresh mid-render should land on the
    // current stage, not an empty panel until the next event happens to fire — which
    // during frame synthesis can be 40s away.
    const replay = progressBus.latest(A);
    expect(replay?.stage).toBe('synthesis');
    expect(replay?.sceneIndex).toBe(3);
    expect(replay?.reused).toBe(false);
  });

  it('has nothing to replay once the render has finished', () => {
    progressBus.emit({ projectId: A, stage: 'scene', message: 'working' });
    progressBus.emit({ projectId: A, stage: 'done', message: 'Render complete' });
    // Retaining a terminal event would show a finished render as in-progress to the
    // next client that connects.
    expect(progressBus.latest(A)).toBeUndefined();
  });
});

describe('terminal stages', () => {
  it('treats done, failed and cancelled as terminal and nothing else', () => {
    expect(isTerminal('done')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    for (const stage of ['init', 'scene', 'tts', 'synthesis', 'segment', 'stitch',
                         'quality_gate', 'cloud_backup'] as const) {
      expect(isTerminal(stage)).toBe(false);
    }
  });

  it('carries the pipeline\'s own failure reason, not a generic message', () => {
    const seen: ProgressEvent[] = [];
    const off = progressBus.subscribe(A, (e) => seen.push(e));
    progressBus.emit({
      projectId: A, stage: 'failed', message: 'Error: voice model not installed',
      error: 'voice model not installed',
    });
    off();
    expect(seen[0].stage).toBe('failed');
    expect(seen[0].error).toBe('voice model not installed');
  });
});

describe('the cached-vs-regenerating signal', () => {
  it('distinguishes a reused step from a regenerated one', () => {
    const seen: ProgressEvent[] = [];
    const off = progressBus.subscribe(A, (e) => seen.push(e));
    progressBus.emit({ projectId: A, stage: 'tts', message: 'Narration already recorded', reused: true, sceneIndex: 1, sceneTotal: 5 });
    progressBus.emit({ projectId: A, stage: 'synthesis', message: 'Rendering animation', reused: false, sceneIndex: 2, sceneTotal: 5 });
    off();
    expect(seen[0].reused).toBe(true);
    expect(seen[1].reused).toBe(false);
  });

  it('stamps every event with a time', () => {
    const seen: ProgressEvent[] = [];
    const off = progressBus.subscribe(A, (e) => seen.push(e));
    progressBus.emit({ projectId: A, stage: 'scene', message: 'x' });
    off();
    expect(Number.isNaN(Date.parse(seen[0].at))).toBe(false);
  });
});
