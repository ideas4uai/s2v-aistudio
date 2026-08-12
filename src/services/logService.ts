import * as fs from 'fs';
import * as path from 'path';

/**
 * Analytics for a single-operator channel.
 *
 * This file was a stub — `logUserEvent` was an empty function, so the two call sites in
 * the orchestrator had been reporting into nothing since they were written.
 *
 * Storage is one append-only JSONL file. That is a deliberate choice, not a placeholder:
 * events are write-once and read rarely, the volume is a handful per render, and a plain
 * file is greppable, survives a crash mid-write (one truncated last line, never a corrupt
 * database), needs no schema migration and adds no dependency. A real database earns its
 * place when there are concurrent writers or millions of rows; there is one process here.
 *
 * ponytail: single-file append, no rotation. Add rotation if the file gets unwieldy —
 * at ~10 events per render that is years away.
 */

export const logService = {
  log: (message: string) => console.log(message),
  error: (message: string, error?: any) => console.error(message, error),
};

export type AnalyticsEvent = {
  at: string;
  type: string;
  projectId?: string;
  [key: string]: unknown;
};

export function getAnalyticsPath(): string {
  return process.env.ANALYTICS_PATH || path.join(process.cwd(), 'analytics', 'events.jsonl');
}

/**
 * Appends one event.
 *
 * Never throws. Analytics is an observer: a failure to record that a render happened
 * must not be able to fail the render. Errors go to the console and are dropped.
 */
export function logEvent(type: string, projectId?: string, data: Record<string, unknown> = {}): void {
  try {
    const file = getAnalyticsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const event: AnalyticsEvent = { at: new Date().toISOString(), type, ...(projectId ? { projectId } : {}), ...data };
    // One appendFileSync per event. Sync on purpose: the process may exit right after a
    // terminal event, and an async write queued behind it would be lost.
    fs.appendFileSync(file, JSON.stringify(event) + '\n');
  } catch (err: any) {
    console.warn('[Analytics] Could not record event:', type, err?.message);
  }
}

/** Kept for the existing orchestrator call sites, which are async. */
export const logUserEvent = async (event: string, projectId: string, metadata: any = {}) => {
  logEvent(event, projectId, metadata ?? {});
};

export function readEvents(file: string = getAnalyticsPath()): AnalyticsEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return []; // nothing logged yet
  }
  const events: AnalyticsEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A torn final line from a crash mid-append. Skip it rather than lose the file.
    }
  }
  return events;
}

export type EventQuery = {
  type?: string;
  projectId?: string;
  since?: string;
  limit?: number;
};

/** Newest first, because every question anyone asks of this starts with "what just happened". */
export function queryEvents(q: EventQuery = {}, file: string = getAnalyticsPath()): AnalyticsEvent[] {
  const sinceMs = q.since ? Date.parse(q.since) : null;
  const matched = readEvents(file).filter((e) =>
    (!q.type || e.type === q.type)
    && (!q.projectId || e.projectId === q.projectId)
    && (sinceMs === null || Number.isNaN(sinceMs) || Date.parse(e.at) >= sinceMs));
  matched.reverse();
  return q.limit && q.limit > 0 ? matched.slice(0, q.limit) : matched;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Per-render cost, in USD.
 *
 * Only the image calls cost money in the current setup: text generation is on the free
 * Gemini tier and Kokoro TTS runs locally on the CPU, so its cost is electricity, not
 * API spend. The rate is configurable because published prices move and a number baked
 * into a build goes stale silently.
 *
 * This is an estimate and is labelled as one everywhere it surfaces. It counts images
 * actually generated, so a fully cached re-render correctly costs nothing.
 */
export const IMAGE_COST_USD = Number(process.env.ANALYTICS_IMAGE_COST_USD ?? 0.039);

export function estimateCostUsd(imagesGenerated: number): number {
  return Number((Math.max(0, imagesGenerated) * IMAGE_COST_USD).toFixed(4));
}

export type AnalyticsSummary = {
  generatedAt: string;
  totalEvents: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  countsByType: Record<string, number>;
  renders: {
    started: number;
    completed: number;
    failed: number;
    successRate: number | null;
    medianDurationSec: number | null;
    totalDurationSec: number;
  };
  qualityGate: { passed: number; failed: number; averageScore: number | null };
  cloudBackup: { uploaded: number; failed: number };
  publish: { uploaded: number; failed: number };
  cost: { imagesGenerated: number; estimatedUsd: number; imageRateUsd: number; note: string };
};

export function summarise(file: string = getAnalyticsPath()): AnalyticsSummary {
  const events = readEvents(file);

  const countsByType: Record<string, number> = {};
  for (const e of events) countsByType[e.type] = (countsByType[e.type] || 0) + 1;

  const durations = events
    .filter((e) => e.type === 'render_completed')
    .map((e) => num(e.durationSec))
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b);
  // Median, not mean: one 14-minute cold render would otherwise hide a hundred fast
  // incremental ones, and "how long does a render take" means the typical case.
  const median = durations.length
    ? durations.length % 2
      ? durations[(durations.length - 1) / 2]
      : (durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2
    : null;

  const scores = events
    .filter((e) => e.type === 'quality_gate')
    .map((e) => num(e.score))
    .filter((s): s is number => s !== null);

  const gatePassed = events.filter((e) => e.type === 'quality_gate' && e.passed === true).length;
  const gateFailed = events.filter((e) => e.type === 'quality_gate' && e.passed === false).length;

  const completed = countsByType['render_completed'] || 0;
  const failed = countsByType['render_failed'] || 0;
  const finished = completed + failed;

  const imagesGenerated = events
    .filter((e) => e.type === 'render_completed')
    .reduce((sum, e) => sum + (num(e.imagesGenerated) ?? 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    totalEvents: events.length,
    firstEventAt: events.length ? events[0].at : null,
    lastEventAt: events.length ? events[events.length - 1].at : null,
    countsByType,
    renders: {
      started: countsByType['render_started'] || 0,
      completed,
      failed,
      successRate: finished ? Number((completed / finished).toFixed(3)) : null,
      medianDurationSec: median === null ? null : Number(median.toFixed(1)),
      totalDurationSec: Number(durations.reduce((a, b) => a + b, 0).toFixed(1)),
    },
    qualityGate: {
      passed: gatePassed,
      failed: gateFailed,
      averageScore: scores.length ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)) : null,
    },
    cloudBackup: {
      uploaded: countsByType['cloud_backup_uploaded'] || 0,
      failed: countsByType['cloud_backup_failed'] || 0,
    },
    publish: {
      uploaded: countsByType['publish_uploaded'] || 0,
      failed: countsByType['publish_failed'] || 0,
    },
    cost: {
      imagesGenerated,
      estimatedUsd: estimateCostUsd(imagesGenerated),
      imageRateUsd: IMAGE_COST_USD,
      note: 'Estimate. Images only — text generation is on the free tier and Kokoro TTS runs locally, '
        + 'so neither is API spend. Set ANALYTICS_IMAGE_COST_USD to match your current rate.',
    },
  };
}
