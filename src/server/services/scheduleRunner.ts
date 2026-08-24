import {
  due, updateJob, checkGates, readJobs, type ScheduledJob,
} from './scheduleService.js';
import { loadProject, patchProject, runPipeline } from '../../pipeline/orchestrator.js';
import { buildMetadata, uploadVideo } from './youtubeService.js';
import { resolveChannel } from './channelStore.js';
import { ensureThumbnail, thumbnailTextOf } from './thumbnailService.js';
import { resolveOutputFile } from '../routes/projects.js';
import { logEvent } from '../../services/logService.js';
import * as fs from 'fs';

/**
 * Executes scheduled jobs whose time has come and whose gates are clear.
 *
 * Separate from scheduleService so the gate logic stays pure and testable — this file
 * is the part that has side effects, and it is deliberately the smaller of the two.
 */

const TICK_MS = Number(process.env.SCHEDULE_TICK_MS || 60_000);
let timer: NodeJS.Timeout | null = null;
/** One job at a time. A render already saturates this machine; two would just thrash. */
let running = false;

async function findWorkflowRun(project: any): Promise<{ status?: string } | null> {
  if (!project?.contentStudio?.episodeId) return null;
  try {
    const { StudioStore } = await import('../../content-studio/store.js');
    const runs = (await StudioStore.list('workflow_runs', project.userId)) as any[];
    return runs.find((r) => r.episodeId === project.contentStudio.episodeId) || null;
  } catch {
    // The studio store being unavailable must not silently open the approval gate.
    // Returning undefined leaves the gate to the job's own approval flag; a run that
    // exists and is awaiting approval can only ever block, never allow.
    return null;
  }
}

async function publish(job: ScheduledJob, project: any): Promise<Record<string, unknown>> {
  const filePath = resolveOutputFile(project.output_path);
  if (!fs.existsSync(filePath)) throw new Error(`Rendered file is missing from disk: ${filePath}`);

  // Same order as the interactive publish route: the project's own tag decides, and
  // last-used is only ever the fallback. Omitting this made the scheduler resolve to
  // last-used alone, so an unattended publish of a project tagged to one channel
  // followed whatever was published manually last — the precise mistake the tag exists
  // to prevent, on the one path with nobody watching.
  const target = resolveChannel({ projectChannelId: project.channel_id });
  if (!target) throw new Error('No YouTube channel is connected.');

  // Same thumbnail the interactive route and the download button produce. Built
  // best-effort: an unattended publish must not be abandoned because a headline could
  // not be drawn, but it also must not quietly differ from what a manual publish does.
  let thumbFile: string | undefined;
  try {
    thumbFile = (await ensureThumbnail(job.projectId, filePath, thumbnailTextOf(project))).path;
  } catch (e: any) {
    console.warn(`[Schedule] ${job.id} no custom thumbnail: ${e?.message || e}`);
  }

  const result = await uploadVideo(filePath, buildMetadata(project), job.privacyStatus, target.channelId, thumbFile);
  await patchProject(job.projectId, (p: any) => {
    p.youtube = {
      videoId: result.videoId, url: result.url, privacyStatus: result.privacyStatus,
      title: result.title, publishedAt: new Date().toISOString(), scheduledJobId: job.id,
      channelId: result.channelId, channelTitle: result.channelTitle,
      thumbnailSet: result.thumbnail?.set ?? false,
      thumbnailError: result.thumbnail?.error,
    };
  }, 'scheduled-publish');
  logEvent('publish_uploaded', job.projectId, {
    videoId: result.videoId, privacyStatus: result.privacyStatus, scheduled: true,
    channelId: result.channelId, thumbnailSet: result.thumbnail?.set ?? false,
    thumbnailReason: result.thumbnail?.reason,
  });
  if (result.thumbnail && !result.thumbnail.set) {
    console.warn(`[Schedule] ${job.id} published but the thumbnail did not stick: ${result.thumbnail.error}`);
  }
  return result as unknown as Record<string, unknown>;
}

export async function runJob(job: ScheduledJob): Promise<void> {
  let project: any;
  try {
    project = await loadProject(job.projectId);
  } catch {
    updateJob(job.id, { status: 'failed', error: 'Project not found.', finishedAt: new Date().toISOString() });
    logEvent('schedule_failed', job.projectId, { jobId: job.id, error: 'Project not found.' });
    return;
  }

  // Gates are re-checked here, at the moment of running — not when the job was created.
  // A story can be un-approved and a re-render can fail the quality gate between the
  // two, and the answer that matters is the one true right now.
  const verdict = checkGates(job, project, await findWorkflowRun(project));
  if (!verdict.allowed) {
    updateJob(job.id, { status: 'blocked', blockedReason: verdict.reason, lastCheckedAt: new Date().toISOString() });
    logEvent('schedule_blocked', job.projectId, { jobId: job.id, action: job.action, reason: verdict.reason });
    console.warn(`[Schedule] ${job.id} held: ${verdict.reason}`);
    return;
  }

  updateJob(job.id, { status: 'running', startedAt: new Date().toISOString(), attempts: job.attempts + 1, blockedReason: undefined });
  logEvent('schedule_started', job.projectId, { jobId: job.id, action: job.action });

  try {
    if (job.action === 'render' || job.action === 'render_and_publish') {
      await runPipeline(job.projectId);
    }

    let result: Record<string, unknown> = {};
    if (job.action === 'publish' || job.action === 'render_and_publish') {
      // Re-read: the render just rewrote output_path and the quality gate verdict.
      const rendered = await loadProject(job.projectId);
      // The gate is checked again against what was actually produced. A render_and_publish
      // job that renders something bad must stop here rather than publish it — this is
      // the case the whole feature exists to get right.
      const post = checkGates(job, rendered, await findWorkflowRun(rendered));
      if (!post.allowed) {
        updateJob(job.id, { status: 'blocked', blockedReason: post.reason, lastCheckedAt: new Date().toISOString() });
        logEvent('schedule_blocked', job.projectId, { jobId: job.id, action: job.action, reason: post.reason, afterRender: true });
        console.warn(`[Schedule] ${job.id} rendered but held before publish: ${post.reason}`);
        return;
      }
      result = await publish(job, rendered);
    }

    updateJob(job.id, { status: 'done', finishedAt: new Date().toISOString(), result });
    logEvent('schedule_completed', job.projectId, { jobId: job.id, action: job.action, ...result });
    console.log(`[Schedule] ${job.id} completed (${job.action})`);
  } catch (err: any) {
    const message = err?.message || String(err);
    updateJob(job.id, { status: 'failed', error: message, finishedAt: new Date().toISOString() });
    logEvent('schedule_failed', job.projectId, { jobId: job.id, action: job.action, error: message });
    console.error(`[Schedule] ${job.id} FAILED: ${message}`);
  }
}

export async function tick(now: number = Date.now()): Promise<void> {
  if (running) return;
  const jobs = due(now);
  if (!jobs.length) return;
  running = true;
  try {
    for (const job of jobs) await runJob(job);
  } finally {
    running = false;
  }
}

export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(() => { void tick().catch((e) => console.error('[Schedule] tick failed:', e?.message)); }, TICK_MS);
  // Not ref'd: a pending timer must not be the reason the process refuses to exit.
  timer.unref?.();
  const pending = readJobs().filter((j) => j.status === 'pending' || j.status === 'blocked').length;
  console.log(`[Schedule] Scheduler started (every ${TICK_MS / 1000}s, ${pending} job(s) outstanding)`);
  void tick().catch(() => {});
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
