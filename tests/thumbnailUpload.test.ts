import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setThumbnail, uploadVideo } from '../src/server/services/youtubeService.js';
import { addChannel, updateChannel, setLastUsed } from '../src/server/services/channelStore.js';

/**
 * Setting a custom thumbnail is a second API call against a video that is already live,
 * so it fails on its own terms and at the worst possible moment — after the upload
 * everyone was watching has succeeded.
 *
 * Two things are pinned here. First, that a thumbnail failure is REPORTED rather than
 * thrown: throwing would turn a published video into a failed publish, and swallowing
 * would leave the operator with YouTube's auto-generated frame and no idea why. Second,
 * that the thumbnail goes to the same channel as the video — asserted through the
 * bearer token, because the token is the thing that actually decides.
 */

let dir: string;
let image: string;
let video: string;
const ORIGINAL = {
  id: process.env.YOUTUBE_CLIENT_ID,
  secret: process.env.YOUTUBE_CLIENT_SECRET,
  token: process.env.YOUTUBE_TOKEN_PATH,
};

/** Requests the stub saw, in order. */
let calls: { url: string; auth?: string; type?: string }[];

const AIQA = 'UC-aiqa';
const LEARN = 'UC-learn';

/** Seeds a channel with a live access token, so no refresh round trip is involved. */
const connect = (channelId: string, title: string, accessToken: string) => {
  addChannel({ channelId, title, refreshToken: `rt-${channelId}` });
  updateChannel(channelId, (c) => {
    c.accessToken = accessToken;
    c.expiresAtMs = Date.now() + 3_600_000;
  });
};

/** thumbStatus 200 = accepted; anything else is the refusal to assert against. */
function stubFetch(thumbStatus = 200, thumbBody: any = {}) {
  return vi.fn(async (url: any, init: any = {}) => {
    const u = String(url);
    calls.push({ url: u, auth: init?.headers?.Authorization, type: init?.headers?.['Content-Type'] });

    if (u.includes('/thumbnails/set')) {
      return {
        ok: thumbStatus === 200, status: thumbStatus,
        json: async () => thumbBody,
      } as any;
    }
    if (u.includes('uploadType=resumable')) {
      return {
        ok: true, status: 200,
        headers: { get: (h: string) => (h === 'location' ? 'https://upload.example/session' : null) },
        json: async () => ({}),
      } as any;
    }
    // The resumable PUT. The channel it reports is the one the token belongs to.
    const forAiqa = calls.some((c) => c.auth === 'Bearer at-aiqa');
    return {
      ok: true, status: 200,
      json: async () => ({
        id: 'vid-1',
        snippet: { channelId: forAiqa ? AIQA : LEARN, title: 'T' },
        status: { privacyStatus: 'unlisted' },
      }),
    } as any;
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-up-'));
  process.env.YOUTUBE_TOKEN_PATH = path.join(dir, 'youtube-tokens.json');
  process.env.YOUTUBE_CLIENT_ID = 'cid';
  process.env.YOUTUBE_CLIENT_SECRET = 'secret';
  image = path.join(dir, 'thumb.jpg');
  fs.writeFileSync(image, Buffer.alloc(2048, 7));
  // uploadVideo stats the file before doing anything; the bytes never reach the stub.
  video = path.join(dir, 'render.mp4');
  fs.writeFileSync(video, Buffer.alloc(4096, 1));
  calls = [];
  connect(AIQA, 'AIQAEngineer', 'at-aiqa');
  connect(LEARN, 'Learn AI with B', 'at-learn');
  setLastUsed(LEARN);
});

afterEach(() => {
  for (const [k, v] of [
    ['YOUTUBE_CLIENT_ID', ORIGINAL.id], ['YOUTUBE_CLIENT_SECRET', ORIGINAL.secret],
    ['YOUTUBE_TOKEN_PATH', ORIGINAL.token],
  ] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('setThumbnail refuses locally before spending a request', () => {
  it('rejects a file that is not there', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const out = await setThumbnail('vid-1', path.join(dir, 'gone.jpg'), AIQA);
    expect(out.set).toBe(false);
    expect(out.reason).toBe('missingFile');
    expect(calls).toHaveLength(0);
  });

  it('rejects an empty file', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const empty = path.join(dir, 'empty.jpg');
    fs.writeFileSync(empty, '');
    expect((await setThumbnail('vid-1', empty, AIQA)).reason).toBe('emptyFile');
    expect(calls).toHaveLength(0);
  });

  it('rejects one over YouTube’s 2MB ceiling, and says the size', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const big = path.join(dir, 'big.jpg');
    fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024 + 1));
    const out = await setThumbnail('vid-1', big, AIQA);
    expect(out.set).toBe(false);
    expect(out.reason).toBe('tooLarge');
    expect(out.error).toMatch(/2\.00MB/);
    // The point of checking first: YouTube would reject it after the whole body went up.
    expect(calls).toHaveLength(0);
  });
});

describe('setThumbnail against YouTube', () => {
  it('reports success when YouTube accepts it', async () => {
    vi.stubGlobal('fetch', stubFetch(200));
    expect(await setThumbnail('vid-1', image, AIQA)).toEqual({ set: true });
    expect(calls[0].url).toContain('/thumbnails/set?videoId=vid-1');
    expect(calls[0].type).toBe('image/jpeg');
  });

  it('explains a 403 as the verification gate it almost always is', async () => {
    vi.stubGlobal('fetch', stubFetch(403, {
      error: { message: 'The authenticated user is not permitted to set the thumbnail.', errors: [{ reason: 'forbidden' }] },
    }));
    const out = await setThumbnail('vid-1', image, AIQA);
    expect(out.set).toBe(false);
    expect(out.reason).toBe('forbidden');
    expect(out.error).toMatch(/phone-verified/i);
    expect(out.error).toMatch(/AIQAEngineer/);
    // Must not read as a failed publish.
    expect(out.error).toMatch(/published fine/i);
  });

  it('never throws — a thumbnail problem is a return value', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up'); }));
    const out = await setThumbnail('vid-1', image, AIQA);
    expect(out.set).toBe(false);
    expect(out.error).toMatch(/socket hang up/);
  });
});

describe('the thumbnail follows the video to the same channel', () => {
  it('uses the token of the channel the upload resolved to, not last-used', async () => {
    vi.stubGlobal('fetch', stubFetch(200));
    // Last-used is Learn AI with B; this upload explicitly targets AIQAEngineer.
    const res = await uploadVideo(video, { title: 'T', description: 'd', tags: [] } as any,
      'unlisted', AIQA, image);

    const thumbCall = calls.find((c) => c.url.includes('/thumbnails/set'));
    expect(thumbCall).toBeDefined();
    expect(thumbCall!.auth).toBe('Bearer at-aiqa');
    expect(thumbCall!.auth).not.toBe('Bearer at-learn');
    expect(res.thumbnail).toEqual({ set: true });
    expect(res.channelId).toBe(AIQA);
  });

  it('publishes the video even when the thumbnail is refused', async () => {
    vi.stubGlobal('fetch', stubFetch(403, { error: { errors: [{ reason: 'forbidden' }] } }));
    const res = await uploadVideo(video, { title: 'T', description: 'd', tags: [] } as any,
      'unlisted', AIQA, image);
    // The video is live and the caller is told so, with the thumbnail problem attached.
    expect(res.videoId).toBe('vid-1');
    expect(res.url).toContain('vid-1');
    expect(res.thumbnail?.set).toBe(false);
    expect(res.thumbnail?.error).toBeTruthy();
  });

  it('does not touch the thumbnail API when no image is offered', async () => {
    vi.stubGlobal('fetch', stubFetch(200));
    const res = await uploadVideo(video, { title: 'T', description: 'd', tags: [] } as any,
      'unlisted', AIQA);
    expect(res.thumbnail).toBeUndefined();
    expect(calls.some((c) => c.url.includes('/thumbnails/set'))).toBe(false);
  });
});
