import { Router } from 'express';
import crypto from 'crypto';
import {
  buildAuthUrl, exchangeCode, connectionStatus, disconnect,
  YouTubeNotConfiguredError, missingConfig,
} from '../services/youtubeService.js';
import { logEvent } from '../../services/logService.js';

export const youtubeRouter = Router();

/**
 * OAuth connect/disconnect for the publishing channel.
 *
 * The upload itself lives on the project router, because publishing is something you do
 * to a project; this router is only about the channel connection.
 */

/**
 * One-time `state` values, to bind a callback to the request that started it.
 *
 * Without this, anyone who can reach the callback URL can hand the server an
 * authorisation code and connect a channel of their choosing. Values are single-use and
 * expire, so a stale link cannot be replayed later.
 */
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

function newState(): string {
  const now = Date.now();
  for (const [value, created] of pendingStates) {
    if (now - created > STATE_TTL_MS) pendingStates.delete(value);
  }
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, now);
  return state;
}

function consumeState(state: string | undefined): boolean {
  if (!state) return false;
  const created = pendingStates.get(state);
  if (created === undefined) return false;
  pendingStates.delete(state);
  return Date.now() - created <= STATE_TTL_MS;
}

/** Whether YouTube is configured, connected, and to which channel. */
youtubeRouter.get('/status', (_req, res) => {
  res.json(connectionStatus());
});

/** Starts the consent flow. Visited in a browser, so it redirects rather than returning JSON. */
youtubeRouter.get('/auth', (req, res) => {
  try {
    const url = buildAuthUrl(newState());
    if (req.query.json === '1') return res.json({ url });
    res.redirect(url);
  } catch (err: any) {
    if (err instanceof YouTubeNotConfiguredError) {
      return res.status(503).json({ error: err.message, missingConfig: missingConfig() });
    }
    res.status(500).json({ error: err?.message || 'Could not start YouTube authorisation' });
  }
});

/** Where Google sends the operator back. Renders a page, not JSON — a human is reading it. */
youtubeRouter.get('/callback', async (req, res) => {
  const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8">
<title>${title}</title>
<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;line-height:1.6">
${body}</body>`;

  if (req.query.error) {
    return res.status(400).send(page('YouTube authorisation failed',
      `<h1>Authorisation cancelled</h1><p>Google reported: <code>${String(req.query.error).slice(0, 200)}</code></p>`));
  }
  if (!consumeState(req.query.state as string | undefined)) {
    return res.status(400).send(page('YouTube authorisation failed',
      '<h1>Expired or unrecognised request</h1><p>Start again from <a href="/api/youtube/auth">/api/youtube/auth</a>.</p>'));
  }

  try {
    const tokens = await exchangeCode(String(req.query.code || ''));
    logEvent('youtube_connected', undefined, { channelId: tokens.channelId, channelTitle: tokens.channelTitle });
    res.send(page('YouTube connected',
      `<h1>Channel connected</h1><p>Publishing to <strong>${tokens.channelTitle || tokens.channelId || 'your channel'}</strong>.</p>`
      + '<p>You can close this tab and publish from the project page.</p>'));
  } catch (err: any) {
    console.error('[YouTube] Token exchange failed:', err?.message);
    res.status(500).send(page('YouTube authorisation failed',
      `<h1>Could not complete authorisation</h1><p><code>${String(err?.message || err).slice(0, 500)}</code></p>`));
  }
});

youtubeRouter.post('/disconnect', (_req, res) => {
  const removed = disconnect();
  logEvent('youtube_disconnected');
  res.json({ ok: true, removed });
});
