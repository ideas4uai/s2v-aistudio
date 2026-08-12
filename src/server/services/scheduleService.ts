import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import { logEvent } from '../../services/logService.js';

/**
 * Scheduling for a single operator.
 *
 * A JSON file and one setInterval, not a job queue. There is one process, one person,
 * and a handful of jobs a day; Redis and BullMQ would be more moving parts than the
 * thing they schedule. Multi-tenant scale is explicitly a later phase.
 *
 * ponytail: in-process timer, so nothing fires while the server is down. On boot the
 * scheduler picks up anything now overdue and runs it, which is the right behaviour for
 * a missed slot — see catch-up handling in `due`. If unattended scheduling ever has to
 * survive the machine being off, that is an OS-level timer, not a bigger library.
 *
 * The two gates are the entire point of this file. A scheduled job runs unattended, so
 * it is the one path where a bad video could reach a channel with nobody watching:
 *
 *   1. Approval  — a human must have approved the job, and if the project came from
 *                  Content Studio its story stage must not still be awaiting approval.
 *   2. Quality   — a publish job whose render failed the quality gate does not publish.
 *                  There is deliberately no force for scheduled jobs. Overruling the
 *                  gate is a decision someone makes while looking at the video, not
 *                  something a timer does at 6am.
 */

export type ScheduleAction = 'render' | 'publish' | 'render_and_publish';
export type ScheduleStatus = 'pending' | 'blocked' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ScheduledJob {
  id: string;
  projectId: string;
  action: ScheduleAction;
  /** ISO time this job becomes eligible. */
  runAt: string;
  status: ScheduleStatus;
  /** Publish privacy. Defaults to unlisted: unattended publishing should not go straight to public. */
  privacyStatus: 'private' | 'unlisted' | 'public';
  createdAt: string;
  /** Set when a human approves this job. Until then it cannot run, whatever the clock says. */
  approvedAt?: string;
  approvedBy?: string;
  /** Why the last attempt did not proceed. Cleared when it does. */
  blockedReason?: string;
  lastCheckedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  result?: Record<string, unknown>;
  attempts: number;
}

export function schedulePath(): string {
  return process.env.SCHEDULE_PATH || path.join(process.cwd(), 'config', 'schedule.json');
}

export function readJobs(): ScheduledJob[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(schedulePath(), 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeJobs(jobs: ScheduledJob[]): void {
  const file = schedulePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2));
  fs.renameSync(tmp, file);
}

export function createJob(input: {
  projectId: string;
  action: ScheduleAction;
  runAt: string;
  privacyStatus?: 'private' | 'unlisted' | 'public';
}): ScheduledJob {
  const runAtMs = Date.parse(input.runAt);
  if (Number.isNaN(runAtMs)) throw new Error(`runAt is not a valid time: ${input.runAt}`);

  const job: ScheduledJob = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    action: input.action,
    runAt: new Date(runAtMs).toISOString(),
    // Never 'pending-and-ready'. A new job is unapproved by definition, and the status
    // says so rather than looking like it is merely waiting for its time to come.
    status: 'blocked',
    blockedReason: 'Awaiting human approval.',
    privacyStatus: input.privacyStatus || 'unlisted',
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  writeJobs([...readJobs(), job]);
  logEvent('schedule_created', input.projectId, { jobId: job.id, action: job.action, runAt: job.runAt });
  return job;
}

export function updateJob(id: string, patch: Partial<ScheduledJob>): ScheduledJob | null {
  const jobs = readJobs();
  const index = jobs.findIndex((j) => j.id === id);
  if (index === -1) return null;
  jobs[index] = { ...jobs[index], ...patch };
  writeJobs(jobs);
  return jobs[index];
}

export function approveJob(id: string, approvedBy = 'operator'): ScheduledJob | null {
  const job = readJobs().find((j) => j.id === id);
  if (!job) return null;
  if (job.status === 'done' || job.status === 'cancelled') return job;
  const updated = updateJob(id, {
    approvedAt: new Date().toISOString(),
    approvedBy,
    status: 'pending',
    blockedReason: undefined,
  });
  logEvent('schedule_approved', job.projectId, { jobId: id, approvedBy });
  return updated;
}

export function cancelJob(id: string): ScheduledJob | null {
  const job = readJobs().find((j) => j.id === id);
  if (!job) return null;
  const updated = updateJob(id, { status: 'cancelled', finishedAt: new Date().toISOString() });
  logEvent('schedule_cancelled', job.projectId, { jobId: id });
  return updated;
}

/**
 * Jobs eligible to run now.
 *
 * Overdue counts as due. A job whose slot passed while the server was down should run
 * at the next boot rather than be skipped silently — the operator asked for it to
 * happen, not for it to happen in that exact minute.
 */
export function due(now: number = Date.now(), jobs: ScheduledJob[] = readJobs()): ScheduledJob[] {
  return jobs.filter((j) => j.status === 'pending' && j.approvedAt && Date.parse(j.runAt) <= now);
}

export type GateVerdict = { allowed: boolean; reason?: string };

/**
 * Gate 1 — has a human approved this?
 *
 * Two conditions, not one. The job itself must be approved, and a project that came
 * from Content Studio must also have cleared its story approval there. Checking only
 * the job would let someone approve a slot for a story that was never signed off; that
 * is precisely the gate the plan asked to keep in the loop.
 */
export function checkApprovalGate(job: ScheduledJob, project: any, workflowRun?: { status?: string } | null): GateVerdict {
  if (!job.approvedAt) return { allowed: false, reason: 'Awaiting human approval.' };

  if (project?.contentStudio && workflowRun?.status === 'awaiting_approval') {
    return {
      allowed: false,
      reason: 'The Content Studio story for this episode is still awaiting approval.',
    };
  }
  return { allowed: true };
}

/**
 * Gate 2 — is this video good enough to go out unattended?
 *
 * Only publishing is gated: rendering something bad costs CPU, publishing it costs
 * reputation. A render job is allowed through so that the gate has something to judge.
 */
export function checkQualityGate(job: ScheduledJob, project: any): GateVerdict {
  if (job.action === 'render') return { allowed: true };

  const gate = project?.quality_gate;
  if (!gate) {
    return { allowed: false, reason: 'No quality gate result — the project has not completed a render.' };
  }
  if (!gate.passed) {
    return {
      allowed: false,
      reason: `Quality gate failed (score ${gate.score}/100): ${(gate.failures || []).join('; ')}. `
        + 'Held for human review — scheduled publishing does not override the gate.',
    };
  }
  return { allowed: true };
}

/** Both gates, in the order a human would ask them. */
export function checkGates(job: ScheduledJob, project: any, workflowRun?: { status?: string } | null): GateVerdict {
  const approval = checkApprovalGate(job, project, workflowRun);
  if (!approval.allowed) return approval;
  return checkQualityGate(job, project);
}
