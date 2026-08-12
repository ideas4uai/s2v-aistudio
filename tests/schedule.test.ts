import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createJob, readJobs, approveJob, cancelJob, due, updateJob,
  checkApprovalGate, checkQualityGate, checkGates, type ScheduledJob,
} from '../src/server/services/scheduleService.js';

// Scheduled jobs are the only path where a video can reach a channel with nobody
// watching. Both gates are therefore load-bearing, and every test here is about one of
// them failing closed: an unapproved job, a story still awaiting sign-off, or a render
// that failed quality must all end with nothing published.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-test-'));
  process.env.SCHEDULE_PATH = path.join(dir, 'schedule.json');
  process.env.ANALYTICS_PATH = path.join(dir, 'events.jsonl');
});

afterEach(() => {
  delete process.env.SCHEDULE_PATH;
  delete process.env.ANALYTICS_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();
const anHourAgo = () => new Date(Date.now() - 3600_000).toISOString();

const passingProject = (over: any = {}) => ({
  project_id: 'p1', output_path: 'E:/out/v.mp4',
  quality_gate: { passed: true, score: 100, failures: [] }, ...over,
});
const failingProject = (over: any = {}) => ({
  project_id: 'p1', output_path: 'E:/out/v.mp4',
  quality_gate: { passed: false, score: 42, failures: ['Audio is silent for 3 of 5 scenes'] }, ...over,
});

describe('creating a job', () => {
  it('starts blocked on approval, not merely waiting for its time', () => {
    // Scheduling something is not approving it. If a new job were 'pending', the
    // approval gate would be removed by accident the moment the clock caught up.
    const job = createJob({ projectId: 'p1', action: 'publish', runAt: inAnHour() });
    expect(job.status).toBe('blocked');
    expect(job.approvedAt).toBeUndefined();
    expect(job.blockedReason).toMatch(/approval/i);
  });

  it('defaults to unlisted, so unattended publishing never goes straight to public', () => {
    expect(createJob({ projectId: 'p1', action: 'publish', runAt: inAnHour() }).privacyStatus).toBe('unlisted');
  });

  it('rejects an unparseable time rather than storing a job that can never run', () => {
    expect(() => createJob({ projectId: 'p1', action: 'publish', runAt: 'next tuesday' })).toThrow(/valid time/i);
  });

  it('persists across a reload', () => {
    const job = createJob({ projectId: 'p1', action: 'render', runAt: inAnHour() });
    expect(readJobs().map((j) => j.id)).toEqual([job.id]);
  });
});

describe('which jobs are due', () => {
  it('does not pick up an approved job before its time', () => {
    const job = createJob({ projectId: 'p1', action: 'publish', runAt: inAnHour() });
    approveJob(job.id);
    expect(due(Date.now())).toHaveLength(0);
  });

  it('does not pick up an unapproved job even long after its time', () => {
    // The clock never substitutes for a human.
    createJob({ projectId: 'p1', action: 'publish', runAt: anHourAgo() });
    expect(due(Date.now())).toHaveLength(0);
  });

  it('picks up an approved job once its time has passed', () => {
    const job = createJob({ projectId: 'p1', action: 'publish', runAt: anHourAgo() });
    approveJob(job.id);
    expect(due(Date.now()).map((j) => j.id)).toEqual([job.id]);
  });

  it('still runs a slot that was missed while the server was down', () => {
    const job = createJob({ projectId: 'p1', action: 'publish', runAt: new Date(Date.now() - 86_400_000).toISOString() });
    approveJob(job.id);
    expect(due(Date.now())).toHaveLength(1);
  });

  it('ignores cancelled and finished jobs', () => {
    const a = createJob({ projectId: 'p1', action: 'publish', runAt: anHourAgo() });
    approveJob(a.id);
    cancelJob(a.id);
    const b = createJob({ projectId: 'p2', action: 'publish', runAt: anHourAgo() });
    approveJob(b.id);
    updateJob(b.id, { status: 'done' });
    expect(due(Date.now())).toHaveLength(0);
  });
});

describe('gate 1 — human approval', () => {
  const job = (over: Partial<ScheduledJob> = {}) => ({
    id: 'j1', projectId: 'p1', action: 'publish', runAt: anHourAgo(), status: 'pending',
    privacyStatus: 'unlisted', createdAt: anHourAgo(), attempts: 0, ...over,
  } as ScheduledJob);

  it('refuses a job nobody approved', () => {
    expect(checkApprovalGate(job(), passingProject())).toMatchObject({ allowed: false });
  });

  it('allows an approved job on a project with no Content Studio origin', () => {
    expect(checkApprovalGate(job({ approvedAt: anHourAgo() }), passingProject())).toEqual({ allowed: true });
  });

  it('refuses when the Content Studio story is still awaiting approval', () => {
    // The gate the plan explicitly asked to keep in the loop: approving a slot must
    // not stand in for approving the story that fills it.
    const project = passingProject({ contentStudio: { episodeId: 'e1', packageId: 'pk1' } });
    const verdict = checkApprovalGate(job({ approvedAt: anHourAgo() }), project, { status: 'awaiting_approval' });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/awaiting approval/i);
  });

  it('allows once that story has been approved', () => {
    const project = passingProject({ contentStudio: { episodeId: 'e1', packageId: 'pk1' } });
    expect(checkApprovalGate(job({ approvedAt: anHourAgo() }), project, { status: 'running' })).toEqual({ allowed: true });
  });
});

describe('gate 2 — quality', () => {
  const approved = (action: ScheduledJob['action']) => ({
    id: 'j1', projectId: 'p1', action, runAt: anHourAgo(), status: 'pending',
    privacyStatus: 'unlisted', createdAt: anHourAgo(), attempts: 0, approvedAt: anHourAgo(),
  } as ScheduledJob);

  it('does not publish a video that failed the gate', () => {
    const verdict = checkQualityGate(approved('publish'), failingProject());
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/quality gate failed/i);
    // The reason has to carry the failures, or the held job is a mystery in the morning.
    expect(verdict.reason).toMatch(/Audio is silent/);
  });

  it('says the hold is for human review, not a retryable error', () => {
    expect(checkQualityGate(approved('publish'), failingProject()).reason).toMatch(/human review/i);
  });

  it('does not publish a project that has never been through the gate', () => {
    expect(checkQualityGate(approved('publish'), { project_id: 'p1', output_path: 'x.mp4' }).allowed).toBe(false);
  });

  it('publishes a video that passed', () => {
    expect(checkQualityGate(approved('publish'), passingProject())).toEqual({ allowed: true });
  });

  it('lets a render-only job through, since the gate needs something to judge', () => {
    expect(checkQualityGate(approved('render'), { project_id: 'p1' })).toEqual({ allowed: true });
  });

  it('gates render_and_publish, because it ends in a publish', () => {
    expect(checkQualityGate(approved('render_and_publish'), failingProject()).allowed).toBe(false);
  });

  it('has no force option — overruling the gate is not something a timer does', () => {
    const forced = { ...approved('publish'), force: true } as any;
    expect(checkQualityGate(forced, failingProject()).allowed).toBe(false);
  });
});

describe('both gates together', () => {
  const base = {
    id: 'j1', projectId: 'p1', action: 'publish' as const, runAt: anHourAgo(),
    status: 'pending' as const, privacyStatus: 'unlisted' as const, createdAt: anHourAgo(), attempts: 0,
  };

  it('reports the approval gate first when both would block', () => {
    const verdict = checkGates(base as ScheduledJob, failingProject());
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/approval/i);
  });

  it('only allows when approved AND quality passed', () => {
    expect(checkGates({ ...base, approvedAt: anHourAgo() } as ScheduledJob, failingProject()).allowed).toBe(false);
    expect(checkGates(base as ScheduledJob, passingProject()).allowed).toBe(false);
    expect(checkGates({ ...base, approvedAt: anHourAgo() } as ScheduledJob, passingProject()).allowed).toBe(true);
  });
});
