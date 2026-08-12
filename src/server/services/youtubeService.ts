import * as fs from 'fs';
import * as path from 'path';

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

export function tokenStorePath(): string {
  return process.env.YOUTUBE_TOKEN_PATH || path.join(process.cwd(), 'config', 'youtube-tokens.json');
}

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

export function readTokens(): StoredTokens | null {
  try {
    return JSON.parse(fs.readFileSync(tokenStorePath(), 'utf-8'));
  } catch {
    return null;
  }
}

function writeTokens(tokens: StoredTokens): void {
  const file = tokenStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(tokens, null, 2));
  // The refresh token is a long-lived credential to publish on someone's channel.
  // chmod is a no-op on Windows but costs nothing and matters everywhere else.
  try { fs.chmodSync(file, 0o600); } catch { /* not POSIX */ }
}

export function disconnect(): boolean {
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

  writeTokens(tokens);
  return tokens;
}

async function fetchChannel(accessToken: string): Promise<any> {
  const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `channels.list ${res.status}`);
  return json.items?.[0];
}

/** A valid access token, refreshing if the stored one is expired or nearly so. */
export async function getAccessToken(): Promise<string> {
  const missing = missingConfig();
  if (missing.length) throw new YouTubeNotConfiguredError(missing);
  const tokens = readTokens();
  if (!tokens?.refreshToken) throw new YouTubeNotConnectedError();

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
      `${err.message}. The saved YouTube authorisation is no longer valid — reconnect the channel at /api/youtube/auth.`,
    );
  }

  tokens.accessToken = json.access_token;
  tokens.expiresAtMs = Date.now() + (Number(json.expires_in || 3600) - 60) * 1000;
  writeTokens(tokens);
  return tokens.accessToken!;
}

export type ConnectionStatus = {
  configured: boolean;
  connected: boolean;
  missingConfig: string[];
  channelId?: string;
  channelTitle?: string;
  connectedAt?: string;
  redirectUri: string;
};

export function connectionStatus(): ConnectionStatus {
  const missing = missingConfig();
  const tokens = readTokens();
  return {
    configured: missing.length === 0,
    connected: !!tokens?.refreshToken,
    missingConfig: missing,
    channelId: tokens?.channelId,
    channelTitle: tokens?.channelTitle,
    connectedAt: tokens?.connectedAt,
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
 * Falls back to the project title so a video without SEO metadata can still be
 * published, rather than being blocked on a field the generator may not have filled.
 * `<` and `>` are stripped because YouTube rejects them outright in titles.
 */
export function buildMetadata(project: any): UploadMetadata {
  const seo = project?.seo_metadata || {};
  const rawTitle = String(seo.title || project?.title || 'Untitled').replace(/[<>]/g, '').trim();
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

export type UploadResult = { videoId: string; url: string; privacyStatus: YouTubePrivacy; title: string };

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
): Promise<UploadResult> {
  if (!fs.existsSync(filePath)) throw new Error(`Video file not found: ${filePath}`);
  const size = fs.statSync(filePath).size;
  if (size === 0) throw new Error(`Video file is empty: ${filePath}`);

  const accessToken = await getAccessToken();

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

  return {
    videoId: body.id,
    url: `https://www.youtube.com/watch?v=${body.id}`,
    privacyStatus: body.status?.privacyStatus || privacyStatus,
    title: body.snippet?.title || meta.title,
  };
}
