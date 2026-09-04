import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  buildAuthUrl, exchangeCode, connectionStatus, disconnect,
  YouTubeNotConfiguredError, missingConfig,
} from '../services/youtubeService.js';
import { getChannel, listChannels, logoDir, setLastUsed, updateChannel } from '../services/channelStore.js';
import { discoverTopics } from '../services/topicDiscovery.js';
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

/**
 * Every connected channel.
 *
 * Its own endpoint rather than only a field on /status because the project creation
 * page needs the list and has no interest in whether OAuth is configured.
 */
youtubeRouter.get('/channels', (_req, res) => {
  res.json(listChannels().map((c) => ({
    channelId: c.channelId,
    title: c.title,
    connectedAt: c.connectedAt,
    hasLogo: !!(c.logoPath && fs.existsSync(c.logoPath)),
  })));
});

/** The channel's watermark, or 404. Served so the UI can show what it will burn in. */
youtubeRouter.get('/channels/:channelId/logo', (req, res) => {
  const rec = getChannel(req.params.channelId);
  if (!rec?.logoPath || !fs.existsSync(rec.logoPath)) {
    return res.status(404).json({ error: 'This channel has no logo' });
  }
  res.sendFile(rec.logoPath);
});

const LOGO_TYPES: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
};
const LOGO_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Upload a watermark for one channel.
 *
 * Takes a data URL in JSON rather than multipart: there is no multipart middleware in
 * this app, a logo is a handful of kilobytes, and adding an upload parser for one
 * endpoint is more moving parts than the feature is worth.
 *
 * PNG is what you want here — the watermark is composited with its own alpha, and a
 * JPEG logo brings a white box with it. JPEG and WebP are accepted anyway because
 * refusing the file someone actually has is worse than a slightly worse watermark.
 */
youtubeRouter.post('/channels/:channelId/logo', (req, res) => {
  const rec = getChannel(req.params.channelId);
  if (!rec) return res.status(404).json({ error: 'Channel not connected' });

  const dataUrl = String(req.body?.dataUrl || '');
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) return res.status(400).json({ error: 'Expected { dataUrl: "data:image/png;base64,..." }' });

  const ext = LOGO_TYPES[m[1].toLowerCase()];
  if (!ext) {
    return res.status(415).json({ error: `Unsupported image type ${m[1]}. Use PNG (preferred), JPEG or WebP.` });
  }

  const bytes = Buffer.from(m[2], 'base64');
  if (!bytes.length) return res.status(400).json({ error: 'The image is empty' });
  if (bytes.length > LOGO_MAX_BYTES) {
    return res.status(413).json({ error: `Logo is ${(bytes.length / 1e6).toFixed(1)}MB; the limit is 4MB.` });
  }

  const dir = logoDir();
  fs.mkdirSync(dir, { recursive: true });
  // Named for the channel, so the file on disk says which channel it brands. A new
  // upload REPLACES the old file at the same path, which is what makes the render's
  // mtime staleness check notice: isFreshOutput compares the output against its
  // sources, and a newer logo makes every render that used the old one stale.
  const file = path.join(dir, `${rec.channelId}${ext}`);
  for (const other of Object.values(LOGO_TYPES)) {
    if (other !== ext) { try { fs.unlinkSync(path.join(dir, `${rec.channelId}${other}`)); } catch { /* absent */ } }
  }
  fs.writeFileSync(file, bytes);
  updateChannel(rec.channelId, (c) => { c.logoPath = file; });
  logEvent('youtube_channel_logo_set', undefined, { channelId: rec.channelId, bytes: bytes.length });
  res.json({ channelId: rec.channelId, bytes: bytes.length, path: file });
});

youtubeRouter.delete('/channels/:channelId/logo', (req, res) => {
  const rec = getChannel(req.params.channelId);
  if (!rec) return res.status(404).json({ error: 'Channel not connected' });
  if (rec.logoPath) { try { fs.unlinkSync(rec.logoPath); } catch { /* already gone */ } }
  updateChannel(rec.channelId, (c) => { c.logoPath = undefined; });
  res.json({ ok: true });
});

/** Remember what the operator picked last, so the publish panel can default to it. */
youtubeRouter.post('/channels/:channelId/last-used', (req, res) => {
  if (!getChannel(req.params.channelId)) return res.status(404).json({ error: 'Channel not connected' });
  setLastUsed(req.params.channelId);
  res.json({ ok: true, lastUsedChannelId: req.params.channelId });
});

/**
 * Trending topics in this channel's own subject, for the New Project screen.
 *
 * Read-only and idempotent, but expensive in quota terms: search.list is 100 units a
 * call against a 10,000/day allowance, so this is a click, never a poll. The UI asks
 * once per channel selection and shows what came back.
 */
youtubeRouter.get('/channels/:channelId/topics', async (req, res) => {
  const { channelId } = req.params;
  if (!getChannel(channelId)) return res.status(404).json({ error: 'Channel not connected' });
  try {
    res.json(await discoverTopics(channelId));
  } catch (e: any) {
    if (e instanceof YouTubeNotConfiguredError) {
      return res.status(503).json({ error: 'YouTube is not configured', missing: missingConfig() });
    }
    console.error(`[Topics] discovery failed for ${channelId}:`, e?.message || e);
    res.status(502).json({ error: e?.message || 'Topic discovery failed' });
  }
});

/**
 * Set (or clear) the subject terms discovery searches on for one channel.
 *
 * An empty array clears back to history-derived seeds rather than storing emptiness, so
 * there is one way to mean "work it out from my uploads".
 */
youtubeRouter.put('/channels/:channelId/topic-keywords', (req, res) => {
  const { channelId } = req.params;
  if (!getChannel(channelId)) return res.status(404).json({ error: 'Channel not connected' });
  const raw = req.body?.keywords;
  if (!Array.isArray(raw)) return res.status(400).json({ error: 'keywords must be an array of strings' });
  const keywords = raw.map((k: unknown) => String(k).trim()).filter(Boolean).slice(0, 12);
  updateChannel(channelId, (c) => { c.topicKeywords = keywords.length ? keywords : undefined; });
  res.json({ ok: true, channelId, topicKeywords: keywords });
});

/**
 * Disconnect one channel, or all of them when no id is given.
 *
 * Per channel by default: with three connected, a disconnect button that silently took
 * all three would be a very expensive click — each one costs a separate consent flow to
 * get back.
 */
youtubeRouter.post('/disconnect', (req, res) => {
  const channelId = req.body?.channelId ? String(req.body.channelId) : undefined;
  const removed = disconnect(channelId);
  logEvent('youtube_disconnected', undefined, { channelId: channelId || 'all' });
  res.json({ ok: true, removed, channelId: channelId || null });
});
