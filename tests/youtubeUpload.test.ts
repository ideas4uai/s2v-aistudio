import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildMetadata, uploadVideo } from '../src/server/services/youtubeService.js';

/**
 * The gap this covers: the previous check confirmed buildMetadata returned a title,
 * and stopped there. It never asserted that the value reached the request body, and
 * it never ran buildMetadata against a project shaped like the ones the pipeline
 * actually produces. Video ljNF9y-GHeU went up titled "Untitled" with no description
 * and no tags, past a suite that was green.
 *
 * So these assert the bytes on the wire: the JSON body of the videos.insert call.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-test-'));
const tokenPath = path.join(dir, 'tokens.json');
const videoPath = path.join(dir, 'video.mp4');
let sent: any[] = [];

beforeEach(() => {
  sent = [];
  process.env.YOUTUBE_CLIENT_ID = 'test-client';
  process.env.YOUTUBE_CLIENT_SECRET = 'test-secret';
  process.env.YOUTUBE_TOKEN_PATH = tokenPath;
  // Unexpired, so getAccessToken never reaches the network.
  fs.writeFileSync(tokenPath, JSON.stringify({
    refreshToken: 'r', accessToken: 'a', expiresAtMs: Date.now() + 3_600_000,
    connectedAt: new Date().toISOString(), scopes: [],
  }));
  fs.writeFileSync(videoPath, Buffer.alloc(2048, 7));

  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    sent.push({ url: String(url), init });
    if (String(url).includes('uploadType=resumable')) {
      return new Response('{}', { status: 200, headers: { location: 'https://upload.example/session' } });
    }
    return new Response(JSON.stringify({
      id: 'vid123',
      snippet: { title: JSON.parse(sent[0].init.body).snippet.title },
      status: { privacyStatus: 'unlisted' },
    }), { status: 200 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.YOUTUBE_TOKEN_PATH;
});

/** The JSON body of the videos.insert call — what YouTube is actually told. */
const insertBody = () => JSON.parse(sent.find((s) => s.url.includes('uploadType=resumable')).init.body);

describe('the request body sent to YouTube', () => {
  it('carries the title, description and tags into snippet', async () => {
    const meta = buildMetadata({
      project_id: 'p1',
      topic: 'ignored when seo exists',
      seo_metadata: {
        title: 'Playwright Writes Your Tests Now',
        description: 'Three agents. One loop.',
        tags: ['playwright', 'testing', 'ai agents'],
      },
    });

    await uploadVideo(videoPath, meta, 'unlisted');

    const { snippet, status } = insertBody();
    expect(snippet.title).toBe('Playwright Writes Your Tests Now');
    expect(snippet.description).toBe('Three agents. One loop.');
    expect(snippet.tags).toEqual(['playwright', 'testing', 'ai agents']);
    expect(status.privacyStatus).toBe('unlisted');
    expect(status.selfDeclaredMadeForKids).toBe(false);
    // part= must name every field being sent or YouTube silently drops the rest.
    expect(sent[0].url).toContain('part=snippet,status');
  });

  it('never sends an empty snippet when the project has metadata', async () => {
    const meta = buildMetadata({
      project_id: 'p2',
      seo_metadata: { title: 'T', description: 'D', tags: ['x'] },
    });
    await uploadVideo(videoPath, meta, 'private');
    const { snippet } = insertBody();
    expect(snippet.title).not.toBe('Untitled');
    expect(snippet.description).not.toBe('');
    expect(snippet.tags.length).toBeGreaterThan(0);
  });

  it('PUTs the file bytes to the session URL the init call returned', async () => {
    await uploadVideo(videoPath, buildMetadata({ topic: 'x' }), 'private');
    const put = sent.find((s) => s.url === 'https://upload.example/session');
    expect(put.init.method).toBe('PUT');
    expect(put.init.headers['Content-Length']).toBe('2048');
  });
});

describe('buildMetadata fallbacks', () => {
  it('uses the topic when no seo_metadata was ever generated', () => {
    // The exact shape of the project that published as "Untitled": rendered by the
    // pipeline, so it has a topic and nothing else. `title` is only ever set by the
    // classic create form, and a Content Studio handoff never sets it at all.
    const meta = buildMetadata({ project_id: 'a4fba0d7', topic: 'Playwright AI agents' });
    expect(meta.title).toBe('Playwright AI agents');
    expect(meta.title).not.toBe('Untitled');
  });

  it('prefers seo_metadata over both title and topic', () => {
    expect(buildMetadata({
      topic: 'topic', title: 'title', seo_metadata: { title: 'seo' },
    }).title).toBe('seo');
  });

  it('still yields a usable title when a project has nothing at all', () => {
    expect(buildMetadata({}).title).toBe('Untitled');
  });

  it('trims tags to YouTube\'s total budget rather than being rejected', () => {
    const meta = buildMetadata({
      topic: 't', seo_metadata: { title: 'T', tags: Array.from({ length: 60 }, (_, i) => `tag-number-${i}`) },
    });
    expect(meta.tags.length).toBeLessThan(60);
    expect(meta.tags.join(',').length).toBeLessThanOrEqual(460);
  });
});
