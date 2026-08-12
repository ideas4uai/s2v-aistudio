import { EventEmitter } from 'events';

/**
 * Live render progress, per project.
 *
 * A plain in-process EventEmitter and nothing else. SSE is an HTTP response that stays
 * open and a `data:` line per event — there is no library worth adding for that, and a
 * socket layer would be a second transport to keep alive for a single-operator tool whose
 * server is the same process running the render.
 *
 * This is a VIEW of the pipeline, never its state. Every event is emitted from a point
 * where the pipeline had already decided something and usually already logged it; nothing
 * here invents a percentage or infers a stage. If this module vanished, the render would
 * behave identically — which is the property that keeps progress honest.
 */

/** Stages of the render pipeline. Content Studio's idea/story/package stages are its own. */
export type ProgressStage =
  | 'init' | 'script' | 'storyboard'
  | 'scene' | 'tts' | 'image' | 'synthesis' | 'segment' | 'captions'
  | 'stitch' | 'quality_gate' | 'cloud_backup'
  | 'done' | 'failed' | 'cancelled';

export interface ProgressEvent {
  projectId: string;
  stage: ProgressStage;
  /** Human-readable, already the wording the pipeline logs. */
  message: string;
  /** 1-based, only on scene-scoped events. */
  sceneIndex?: number;
  sceneTotal?: number;
  /**
   * True when this step reused cached output instead of doing the work.
   *
   * The single most useful bit on here: a reused scene finishes in milliseconds and a
   * regenerated one takes ~40s, and a spinner cannot tell you which you are waiting for.
   */
  reused?: boolean;
  percent?: number;
  /** Set on 'failed' — the pipeline's own reason, not a generic message. */
  error?: string;
  at: string;
}

/** Terminal stages. The stream closes after these. */
const TERMINAL: ReadonlySet<ProgressStage> = new Set(['done', 'failed', 'cancelled']);

export const isTerminal = (stage: ProgressStage): boolean => TERMINAL.has(stage);

class ProgressBus {
  // Node warns at 10 listeners on one emitter; a browser tab per project is well under
  // that, but the default is a footgun if several tabs watch the same render.
  private readonly emitter = new EventEmitter().setMaxListeners(50);

  /**
   * Last event per project, so a client connecting mid-render sees where things are
   * instead of a blank panel until the next event happens to fire. Frame synthesis can
   * run 40s between events, which is a long time to look at nothing after a refresh.
   */
  private readonly last = new Map<string, ProgressEvent>();

  emit(event: Omit<ProgressEvent, 'at'>): void {
    const full: ProgressEvent = { ...event, at: new Date().toISOString() };
    if (isTerminal(full.stage)) {
      // Nothing more is coming for this render; holding the last event would only serve
      // it to the next connection as though a render were still running.
      this.last.delete(full.projectId);
    } else {
      this.last.set(full.projectId, full);
    }
    // Per-project channel: a subscriber to A is not registered on B's channel at all, so
    // cross-talk is not something to filter for — it cannot be constructed.
    this.emitter.emit(full.projectId, full);
  }

  subscribe(projectId: string, listener: (event: ProgressEvent) => void): () => void {
    this.emitter.on(projectId, listener);
    return () => { this.emitter.off(projectId, listener); };
  }

  /** The most recent event for a project, if a render is in flight. */
  latest(projectId: string): ProgressEvent | undefined {
    return this.last.get(projectId);
  }

  /** Live subscriber count — used by the tests to prove listeners are released. */
  listenerCount(projectId: string): number {
    return this.emitter.listenerCount(projectId);
  }

  /** Drop retained state for a project. Nothing depends on this beyond tests. */
  forget(projectId: string): void {
    this.last.delete(projectId);
  }
}

export const progressBus = new ProgressBus();
