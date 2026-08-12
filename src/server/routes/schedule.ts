import { Router } from 'express';
import {
  readJobs, createJob, approveJob, cancelJob, checkGates, type ScheduleAction,
} from '../services/scheduleService.js';
import { runJob } from '../services/scheduleRunner.js';
import { loadProject } from '../../pipeline/orchestrator.js';

export const scheduleRouter = Router();

const ACTIONS: ScheduleAction[] = ['render', 'publish', 'render_and_publish'];

/** Every job, newest first. */
scheduleRouter.get('/', (_req, res) => {
  res.json(readJobs().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

/**
 * Queues a job. It is created blocked on approval — scheduling something is not the
 * same as approving it, and conflating the two would remove the gate by accident.
 */
scheduleRouter.post('/', async (req, res) => {
  const { projectId, action, runAt, privacyStatus } = req.body || {};
  try {
    if (!projectId) return res.status(400).json({ error: 'projectId is required.' });
    if (!ACTIONS.includes(action)) {
      return res.status(400).json({ error: `action must be one of: ${ACTIONS.join(', ')}` });
    }
    try {
      await loadProject(projectId);
    } catch {
      return res.status(404).json({ error: `Project ${projectId} not found.` });
    }
    res.status(201).json(createJob({ projectId, action, runAt, privacyStatus }));
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Could not schedule job.' });
  }
});

/** The human approval step. Until this happens the job cannot run, whatever the clock says. */
scheduleRouter.post('/:id/approve', (req, res) => {
  const job = approveJob(req.params.id, req.body?.approvedBy || 'operator');
  if (!job) return res.status(404).json({ error: 'Scheduled job not found.' });
  res.json(job);
});

scheduleRouter.delete('/:id', (req, res) => {
  const job = cancelJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Scheduled job not found.' });
  res.json(job);
});

/**
 * What the gates say about a job right now, without running it.
 *
 * Being able to ask "would this go out, and if not why not" without waiting for the
 * scheduled time is the difference between a gate you trust and one you hope about.
 */
scheduleRouter.get('/:id/gates', async (req, res) => {
  const job = readJobs().find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Scheduled job not found.' });
  try {
    const project = await loadProject(job.projectId);
    const verdict = checkGates(job, project, null);
    res.json({
      jobId: job.id,
      status: job.status,
      approved: !!job.approvedAt,
      qualityGate: (project as any).quality_gate
        ? { passed: (project as any).quality_gate.passed, score: (project as any).quality_gate.score }
        : null,
      ...verdict,
    });
  } catch {
    res.status(404).json({ error: 'Project not found.' });
  }
});

/** Runs a job now, gates and all. For testing a schedule without waiting for the clock. */
scheduleRouter.post('/:id/run-now', async (req, res) => {
  const job = readJobs().find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Scheduled job not found.' });
  await runJob(job);
  res.json(readJobs().find((j) => j.id === req.params.id));
});
