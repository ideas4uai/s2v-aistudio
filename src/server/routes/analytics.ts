import { Router } from 'express';
import { queryEvents, summarise, logEvent } from '../../services/logService.js';

/**
 * Read access to the event log.
 *
 * Analytics that nobody can look at is the same as no analytics — which is what this
 * project had, since logUserEvent was an empty function. Two endpoints: the rolled-up
 * numbers, and the raw events behind them so any figure can be checked rather than
 * trusted.
 */
export const analyticsRouter = Router();

/** Headline numbers: renders, success rate, durations, quality scores, estimated spend. */
analyticsRouter.get('/summary', (_req, res) => {
  try {
    res.json(summarise());
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to summarise analytics' });
  }
});

/** Raw events, newest first. ?type= &projectId= &since= &limit= */
analyticsRouter.get('/events', (req, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    res.json(queryEvents({
      type: req.query.type as string | undefined,
      projectId: req.query.projectId as string | undefined,
      since: req.query.since as string | undefined,
      // Capped: this reads the whole file, and an unbounded default would happily
      // serialise years of events into one response.
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 200,
    }));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to read analytics' });
  }
});

/**
 * Records an event from the browser.
 *
 * Deliberately narrow: the UI can say a user did something, but it cannot claim a render
 * completed or a video was published. Those are server-side facts, and accepting them
 * from a client would let the dashboard be talked into reporting work that never
 * happened.
 */
const CLIENT_EVENTS = new Set(['ui_preview_played', 'ui_download_clicked', 'ui_publish_clicked']);

analyticsRouter.post('/events', (req, res) => {
  const { type, projectId, data } = req.body || {};
  if (!CLIENT_EVENTS.has(type)) {
    return res.status(400).json({ error: `"${type}" is not a client-reportable event.` });
  }
  logEvent(type, projectId, typeof data === 'object' && data ? data : {});
  res.json({ ok: true });
});
