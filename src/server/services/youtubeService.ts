import * as fs from 'fs';
import * as path from 'path';
import {
  addChannel, getChannel, listChannels, readStore, removeChannel, resolveChannel,
  setLastUsed, storePath, updateChannel, LEGACY_CHANNEL_KEY,
} from './channelStore.js';

/**
 * YouTube Data API v3: connect a channel, upload a rendered video.
 *
 * Written against the REST API with fetch rather than the googleapis client. The client
 * is a very large dependency for three endpoints (token exchange, resumable upload,
 * channel read), and the resumable protocol is a POST that returns a URL followed by a
 * PUT of the bytes — that is not enough complexity to justify pulling it in.
 *
 * Uploads need OAuth as a *user*. The service account in GOOGLE_APPLICATION_CREDENTIALS
 * cannot do this: a service account has no YouTube channel, and Google rejects the
 * upload rather than uploading somewhere unexpected. That is why this needs its own
 * client ID and secret and a one-time consent click.
 */

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

export type YouTubePrivacy = 'private' | 'unlisted' | 'public';

type StoredTokens = {
  refreshToken: string;
  accessToken?: string;
  /** Epoch ms. Refreshed a minute early so a slow upload cannot start on a dying token. */
  expiresAtMs?: number;
  channelId?: string;
  channelTitle?: string;
  connectedAt: string;
  scopes: string[];
};

/** Kept for callers and tests that predate the multi-channel store. */
export function tokenStorePath(): string { return storePath(); }

export function clientId(): string | undefined { return process.env.YOUTUBE_CLIENT_ID; }
export function clientSecret(): string | undefined { return process.env.YOUTUBE_CLIENT_SECRET; }
export function redirectUri(): string {
  return process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:3001/api/youtube/callback';
}

/** What is missing, in the words someone would need to go and fix it. */
export function missingConfig(): string[] {
  const missing: string[] = [];
  if (!clientId()) missing.push('YOUTUBE_CLIENT_ID');
  if (!clientSecret()) missing.push('YOUTUBE_CLIENT_SECRET');
  return missing;
}

export class YouTubeNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(
      `YouTube is not configured: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set. `
      + 'Create an OAuth 2.0 Client ID of type "Web application" in the Google Cloud Console '
      + '(APIs & Services > Credentials) for a project with the YouTube Data API v3 enabled, add '
      + `${redirectUri()} as an authorised redirect URI, and put the client ID and secret in .env. `
      + 'A service account cannot be used — it has no YouTube channel to upload to.',
    );
    this.name = 'YouTubeNotConfiguredError';
  }
}

export class YouTubeNotConnectedError extends Error {
  constructor() {
    super('No YouTube channel is connected. Open /api/youtube/auth and grant access to the channel you want to publish to.');
    this.name = 'YouTubeNotConnectedError';
  }
}

/**
 * An upload that failed for a reason the operator can act on.
 *
 * `retryable` separates "come back tomorrow" from "fix something". Quota is by far the
 * most likely failure in normal use: a single upload costs 1600 of the default 10,000
 * units per day, so the sixth upload in a day fails and no amount of retrying helps
 * until the quota resets at midnight Pacific.
 */
export class YouTubeUploadError extends Error {
  constructor(message: string, public readonly status: number, public readonly retryable: boolean,
              public readonly reason?: string) {
    super(message);
    this.name = 'YouTubeUploadError';
  }
}

/**
 * The channel a bare call means when no channel is named.
 *
 * Everything below takes an optional channelId so the single-channel callers that
 * predate this — the health check, the status endpoint, an old publish request with no
 * channel in its body — keep working unchanged against whatever is connected.
 */
export function readTokens(channelId?: string): StoredTokens | null {
  const rec = channelId ? getChannel(channelId) : resolveChannel({});
  if (!rec) return null;
  return {
    refreshToken: rec.refreshToken,
    accessToken: rec.accessToken,
    expiresAtMs: rec.expiresAtMs,
    connectedAt: rec.connectedAt,
    scopes: rec.scopes || [],
    channelId: rec.channelId,
    channelTitle: rec.title,
  };
}

/** Forgets one channel, or every channel when called with nothing. */
export function disconnect(channelId?: string): boolean {
  if (channelId) return removeChannel(channelId);
  try {
    fs.unlinkSync(tokenStorePath());
    return true;
  } catch {
    return false;
  }
}

/** The URL to send the operator to. `state` is echoed back and checked on return. */
export function buildAuthUrl(state: string): string {
  const missing = missingConfig();
  if (missing.length) throw new YouTubeNotConfiguredError(missing);
  const params = new URLSearchParams({
    client_id: clientId()!,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: YOUTUBE_SCOPES.join(' '),
    // offline + consent is what actually returns a refresh token. Without them Google
    // returns only a one-hour access token, and the connection silently dies at lunch.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(body: Record<string, string>): Promise<any> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Google token endpoint ${res.status}: ${json.error_description || json.error || 'unknown error'}`);
  }
  return json;
}

/** Exchanges the one-time code for a refresh token and records which channel it is for. */
export async function exchangeCode(code: string): Promise<StoredTokens> {
  const missing = missingConfig();
  if (missing.length) throw new YouTubeNotConfiguredError(missing);

  const json = await tokenRequest({
    code,
    client_id: clientId()!,
    client_secret: clientSecret()!,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });

  if (!json.refresh_token) {
    throw new Error(
      'Google returned no refresh token. This happens when the app was already authorised: '
      + 'remove its access at https://myaccount.google.com/permissions and connect again.',
    );
  }

  const tokens: StoredTokens = {
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    expiresAtMs: Date.now() + (Number(json.expires_in || 3600) - 60) * 1000,
    connectedAt: new Date().toISOString(),
    scopes: String(json.scope || '').split(' ').filter(Boolean),
  };

  // Record the channel so the UI can say which one it will publish to. A wrong channel
  // is the kind of mistake that is only obvious after the video is public.
  try {
    const channel = await fetchChannel(tokens.accessToken!);
    tokens.channelId = channel?.id;
    tokens.channelTitle = channel?.snippet?.title;
  } catch (err: any) {
    console.warn('[YouTube] Connected, but could not read the channel name:', err?.message);
  }

  if (!tokens.channelId) {
    // Without a channel id there is nothing to key the record on and no way to show the
    // operator what they just connected — which is the whole point of the exercise.
    throw new Error(
      'Connected, but YouTube did not say which channel this is for. '
      + 'Try again and pick a channel on the Google consent screen.',
    );
  }

  addChannel({
    channelId: tokens.channelId,
    title: tokens.channelTitle || tokens.channelId,
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    expiresAtMs: tokens.expiresAtMs,
    scopes: tokens.scopes,
    connectedAt: tokens.connectedAt,
  });
  return tokens;
}

/**
 * The channel this consent was granted for.
 *
 * `mine=true` and not `managedByMe=true`: the latter is what would return every channel
 * the Google account owns, and it requires onBehalfOfContentOwner — a YouTube CMS
 * credential issued to multi-channel networks, not to ordinary creators. So one consent
 * yields one channel, and connecting three channels means running this flow three times
 * and picking a different channel each time. See the header of channelStore.ts.
 */
async function fetchChannel(accessToken: string): Promise<any> {
  const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `channels.list ${res.status}`);
  return json.items?.[0];
}

/** A valid access token, refreshing if the stored one is expired or nearly so. */
export async function getAccessToken(channelId?: string): Promise<string> {
  const missing = missingConfig();
  if (missing.length) throw new YouTubeNotConfiguredError(missing);
  const rec = channelId ? getChannel(channelId) : resolveChannel({});
  if (!rec?.refreshToken) throw new YouTubeNotConnectedError();
  const tokens = readTokens(rec.channelId)!;

  if (tokens.accessToken && tokens.expiresAtMs && Date.now() < tokens.expiresAtMs) {
    return tokens.accessToken;
  }

  let json: any;
  try {
    json = await tokenRequest({
      refresh_token: tokens.refreshToken,
      client_id: clientId()!,
      client_secret: clientSecret()!,
      grant_type: 'refresh_token',
    });
  } catch (err: any) {
    // A revoked or expired refresh token can only be fixed by reconnecting, so say that
    // rather than letting it surface as an opaque 400 on every future publish.
    throw new Error(
      `${err.message}. The saved authorisation for "${rec.title}" is no longer valid — reconnect that channel at /api/youtube/auth.`,
    );
  }

  const accessToken = json.access_token as string;
  const expiresAtMs = Date.now() + (Number(json.expires_in || 3600) - 60) * 1000;
  // Only this channel's entry is touched; the other channels' tokens are untouched by
  // a refresh, which is the whole reason the store merges rather than replaces.
  updateChannel(rec.channelId, (c) => { c.accessToken = accessToken; c.expiresAtMs = expiresAtMs; });
  return accessToken;
}

export type ChannelSummary = {
  channelId: string;
  title: string;
  connectedAt: string;
  hasLogo: boolean;
};

export type ConnectionStatus = {
  configured: boolean;
  connected: boolean;
  missingConfig: string[];
  /** Every connected channel. Empty when nothing is connected. */
  channels: ChannelSummary[];
  lastUsedChannelId?: string;
  /**
   * The first channel, repeated. Kept because the existing publish panel and the health
   * check read these two fields directly, and a status shape that dropped them would
   * break them on the release that adds channels rather than on one anybody expects.
   */
  channelId?: string;
  channelTitle?: string;
  connectedAt?: string;
  redirectUri: string;
};

export function connectionStatus(): ConnectionStatus {
  const missing = missingConfig();
  const store = readStore();
  const channels = listChannels();
  const first = channels[0];
  return {
    configured: missing.length === 0,
    connected: channels.length > 0,
    missingConfig: missing,
    channels: channels.map((c) => ({
      channelId: c.channelId,
      title: c.title,
      connectedAt: c.connectedAt,
      hasLogo: !!(c.logoPath && fs.existsSync(c.logoPath)),
    })),
    lastUsedChannelId: store.lastUsedChannelId,
    channelId: first?.channelId,
    channelTitle: first?.title,
    connectedAt: first?.connectedAt,
    redirectUri: redirectUri(),
  };
}

/** YouTube's own limits, enforced here so a long description is trimmed rather than 400'd. */
export const TITLE_MAX = 100;
export const DESCRIPTION_MAX = 5000;
const TAGS_TOTAL_MAX = 460; // conservative: the documented cap is ~500 chars across all tags

export type UploadMetadata = { title: string; description: string; tags: string[] };

/**
 * Builds the video metadata from a project's seo_metadata.
 *
 * The fallback chain ends at `topic`, and that matters: `title` is only set by the
 * classic create form, while `topic` is the field every agent reads and every code
 * path sets — a Content Studio handoff sets `topic` and no `title` at all. Ending
 * the chain at `title` published a perfectly well-named project as "Untitled",
 * which is exactly what happened to video ljNF9y-GHeU.
 *
 * A caller reaching the last fallback has a real problem — no metadata was ever
 * generated for this project — so say so rather than quietly shipping a bare title.
 * `<` and `>` are stripped because YouTube rejects them outright in titles.
 */
export function buildMetadata(project: any): UploadMetadata {
  const seo = project?.seo_metadata || {};
  if (!seo.title) {
    console.warn(
      `[YouTube] Project ${project?.project_id ?? '?'} has no seo_metadata — publishing with the topic as `
      + 'the title and no description or tags. Re-render to generate publishing metadata.',
    );
  }
  const rawTitle = String(seo.title || project?.title || project?.topic || 'Untitled').replace(/[<>]/g, '').trim();
  const title = rawTitle.slice(0, TITLE_MAX) || 'Untitled';

  const description = String(seo.description || project?.description || '')
    .replace(/[<>]/g, '')
    .slice(0, DESCRIPTION_MAX);

  const tags: string[] = [];
  let budget = TAGS_TOTAL_MAX;
  for (const raw of Array.isArray(seo.tags) ? seo.tags : []) {
    const tag = String(raw).replace(/[<>]/g, '').trim();
    if (!tag) continue;
    if (tag.length + 1 > budget) break;
    tags.push(tag);
    budget -= tag.length + 1;
  }

  return { title, description, tags };
}

/** Turns a YouTube API error body into something with a next action in it. */
function uploadError(status: number, body: any): YouTubeUploadError {
  const err = body?.error || {};
  const reason = err.errors?.[0]?.reason || err.status || String(status);
  const detail = err.message || JSON.stringify(body).slice(0, 300);

  if (reason === 'quotaExceeded' || reason === 'uploadLimitExceeded' || status === 429) {
    return new YouTubeUploadError(
      `YouTube quota exceeded: ${detail}. An upload costs 1600 of the default 10,000 units per day, `
      + 'so this is roughly the sixth upload today. The quota resets at midnight Pacific — or request '
      + 'more in the Google Cloud Console.',
      status, true, reason,
    );
  }
  if (status === 401) {
    return new YouTubeUploadError(
      `YouTube rejected the credentials: ${detail}. Reconnect the channel at /api/youtube/auth.`,
      status, false, reason,
    );
  }
  if (status === 403 && /forbidden|insufficient/i.test(reason)) {
    return new YouTubeUploadError(
      `YouTube refused the upload: ${detail}. The connected account may not have a channel, or the `
      + 'channel is not verified for uploads of this length.',
      status, false, reason,
    );
  }
  return new YouTubeUploadError(`YouTube upload failed (${status}, ${reason}): ${detail}`, status, status >= 500, reason);
}

export type UploadResult = {
  videoId: string; url: string; privacyStatus: YouTubePrivacy; title: string;
  /** Which channel YouTube actually put it on, read back from the response. */
  channelId: string; channelTitle: string;
};

/**
 * Uploads one file, resumably.
 *
 * Resumable rather than a single multipart POST because these are 30-60MB files over a
 * home connection, and the protocol is two requests either way.
 *
 * `madeForKids: false` is set explicitly. It is a required declaration, and letting
 * YouTube apply its default on a channel-level setting nobody remembers configuring is
 * how videos end up with comments disabled.
 */
export async function uploadVideo(
  filePath: string,
  meta: UploadMetadata,
  privacyStatus: YouTubePrivacy = 'private',
  channelId?: string,
): Promise<UploadResult> {
  if (!fs.existsSync(filePath)) throw new Error(`Video file not found: ${filePath}`);
  const size = fs.statSync(filePath).size;
  if (size === 0) throw new Error(`Video file is empty: ${filePath}`);

  const target = channelId ? getChannel(channelId) : resolveChannel({});
  if (!target) throw new YouTubeNotConnectedError();
  const accessToken = await getAccessToken(target.channelId);

  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Length': String(size),
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify({
        snippet: { title: meta.title, description: meta.description, tags: meta.tags, categoryId: '27' },
        status: { privacyStatus, selfDeclaredMadeForKids: false },
      }),
    },
  );

  if (!initRes.ok) throw uploadError(initRes.status, await initRes.json().catch(() => ({})));

  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) throw new Error('YouTube accepted the metadata but returned no upload URL.');

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) },
    body: fs.readFileSync(filePath),
  });

  const body: any = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok) throw uploadError(uploadRes.status, body);
  if (!body.id) throw new Error('YouTube reported success but returned no video id.');

  // Trust the response, not the request. The token decides which channel a video lands
  // on, and a stale or mis-keyed token would put AI QA Engineer content on another
  // channel while still returning 200. Saying so afterwards is the only way to know.
  const landedOn = body.snippet?.channelId;
  // Skipped for a migrated pre-channels connection: its stored id is a placeholder, not
  // a channel, so comparing it would reject every upload from an install that upgraded.
  if (landedOn && target.channelId !== LEGACY_CHANNEL_KEY && landedOn !== target.channelId) {
    throw new YouTubeUploadError(
      `Uploaded to the wrong channel: asked for "${target.title}" (${target.channelId}) `
      + `but YouTube put the video on ${landedOn}. The video exists at `
      + `https://www.youtube.com/watch?v=${body.id} — delete it and reconnect that channel.`,
      200, false, 'channelMismatch',
    );
  }
  setLastUsed(target.channelId);

  return {
    videoId: body.id,
    url: `https://www.youtube.com/watch?v=${body.id}`,
    privacyStatus: body.status?.privacyStatus || privacyStatus,
    title: body.snippet?.title || meta.title,
    channelId: landedOn || target.channelId,
    channelTitle: target.title,
  };
}
