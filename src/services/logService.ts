import { AsyncLocalStorage } from 'async_hooks';
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

/**
 * Which project the work happening right now belongs to.
 *
 * Text generation happens four call levels below the orchestrator, inside agents that
 * take a brief rather than a project. Threading a projectId through every agent
 * signature to satisfy an observer would put analytics plumbing in the middle of the
 * craft code; an async-scoped value keeps it at the two ends that actually care.
 */
const projectScope = new AsyncLocalStorage<string>();

/** Runs `fn` with every nested usage record attributed to this project. */
export function withProjectScope<T>(projectId: string, fn: () => T): T {
  return projectScope.run(projectId, fn);
}

export function currentProjectId(): string | undefined {
  return projectScope.getStore();
}

/**
 * One text-generation call.
 *
 * Tokens when the provider reports them, characters always. Gemini returns
 * usageMetadata on a normal response but not on every error path, and a proxy that is
 * always present beats a precise number that is sometimes missing -- the question this
 * answers is "what did this render consume", and a gap in the series breaks it.
 *
 * Cost is deliberately NOT estimated here. Text runs on the free tier in this setup, so
 * a dollar figure would be invented rather than measured. Set ANALYTICS_TEXT_USD_PER_MTOK
 * when that changes and estimateTextCostUsd starts returning real numbers.
 */
export function logTextUsage(data: {
  task?: string;
  model?: string;
  promptChars: number;
  responseChars: number;
  usage?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | null;
}): void {
  const u = data.usage || {};
  logEvent('ai_text', currentProjectId(), {
    task: data.task || 'general',
    model: data.model,
    promptChars: data.promptChars,
    responseChars: data.responseChars,
    promptTokens: u.promptTokenCount ?? null,
    responseTokens: u.candidatesTokenCount ?? null,
    totalTokens: u.totalTokenCount ?? null,
  });
}

/** Per-million-token rate. Zero by default because text is on the free tier here. */
export const TEXT_USD_PER_MTOK = Number(process.env.ANALYTICS_TEXT_USD_PER_MTOK ?? 0);

export function estimateTextCostUsd(totalTokens: number): number {
  return Number(((Math.max(0, totalTokens) / 1_000_000) * TEXT_USD_PER_MTOK).toFixed(6));
}

export type ProjectUsage = {
  projectId: string;
  renders: number;
  lastRenderAt: string | null;
  durationSec: number;
  imagesGenerated: number;
  audioClips: number;
  textCalls: number;
  totalTokens: number | null;
  /** Null when no call reported tokens, so a zero cannot be read as "free". */
  promptChars: number;
  estimatedUsd: { images: number; text: number; total: number };
  note: string;
};

/**
 * What one project actually consumed.
 *
 * The summary answers "what has this installation spent"; this answers "what did THIS
 * video cost", which is the question a price has to be built on.
 */
export function projectUsage(projectId: string, file: string = getAnalyticsPath()): ProjectUsage {
  const events = readEvents(file).filter((e) => e.projectId === projectId);
  const completed = events.filter((e) => e.type === 'render_completed');
  const text = events.filter((e) => e.type === 'ai_text');

  const sum = (list: AnalyticsEvent[], field: string) =>
    list.reduce((acc, e) => acc + (num(e[field]) ?? 0), 0);

  const reported = text.filter((e) => num(e.totalTokens) !== null);
  const totalTokens = reported.length ? sum(reported, 'totalTokens') : null;
  const images = sum(completed, 'imagesGenerated');
  const imageUsd = estimateCostUsd(images);
  const textUsd = estimateTextCostUsd(totalTokens ?? 0);

  return {
    projectId,
    renders: completed.length,
    lastRenderAt: completed.length ? String(completed[completed.length - 1].at) : null,
    durationSec: Number(sum(completed, 'durationSec').toFixed(1)),
    imagesGenerated: images,
    audioClips: events.filter((e) => e.type === 'tts_generated').length,
    textCalls: text.length,
    totalTokens,
    promptChars: sum(text, 'promptChars'),
    estimatedUsd: {
      images: imageUsd,
      text: textUsd,
      total: Number((imageUsd + textUsd).toFixed(6)),
    },
    note: TEXT_USD_PER_MTOK === 0
      ? 'Text cost is 0 because this install runs Gemini on the free tier and TTS locally. Tokens are still counted. Set ANALYTICS_TEXT_USD_PER_MTOK to price them.'
      : 'Estimate from recorded image counts and reported token counts.',
  };
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
