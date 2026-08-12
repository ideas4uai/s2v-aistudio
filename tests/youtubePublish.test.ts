import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildMetadata, missingConfig, connectionStatus, buildAuthUrl,
  YouTubeNotConfiguredError, TITLE_MAX, DESCRIPTION_MAX, YOUTUBE_SCOPES,
} from '../src/server/services/youtubeService.js';

// Publishing is the one irreversible step in the pipeline — a video that reaches the
// channel is public, and "undo" means deleting it after people have seen it. So the
// things pinned here are the ones where being wrong is expensive: metadata that YouTube
// would reject after a 60MB upload, and a config error that must be legible rather than
// surfacing as an opaque 400.

const ORIGINAL = { id: process.env.YOUTUBE_CLIENT_ID, secret: process.env.YOUTUBE_CLIENT_SECRET, token: process.env.YOUTUBE_TOKEN_PATH };

beforeEach(() => {
  delete process.env.YOUTUBE_CLIENT_ID;
  delete process.env.YOUTUBE_CLIENT_SECRET;
  // Point at a path that cannot exist, so these never read a real connected channel.
  process.env.YOUTUBE_TOKEN_PATH = '/nonexistent/youtube-tokens.json';
});

afterEach(() => {
  for (const [k, v] of [['YOUTUBE_CLIENT_ID', ORIGINAL.id], ['YOUTUBE_CLIENT_SECRET', ORIGINAL.secret], ['YOUTUBE_TOKEN_PATH', ORIGINAL.token]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('buildMetadata', () => {
  it('uses seo_metadata when the generator produced it', () => {
    const meta = buildMetadata({
      title: 'internal name',
      seo_metadata: { title: 'Real Title', description: 'Real description', tags: ['ai', 'gpu'], thumbnailText: 'x' },
    });
    expect(meta).toEqual({ title: 'Real Title', description: 'Real description', tags: ['ai', 'gpu'] });
  });

  it('falls back to the project title rather than blocking the publish', () => {
    const meta = buildMetadata({ title: 'Difference between CPU and GPU', description: 'a video' });
    expect(meta.title).toBe('Difference between CPU and GPU');
    expect(meta.description).toBe('a video');
    expect(meta.tags).toEqual([]);
  });

  it('never produces an empty title', () => {
    // YouTube rejects a blank title, and it would do it after the whole file uploaded.
    expect(buildMetadata({}).title).toBe('Untitled');
    expect(buildMetadata({ seo_metadata: { title: '   ' } }).title).toBe('Untitled');
  });

  it('truncates to the API limits instead of being rejected at the end of an upload', () => {
    const meta = buildMetadata({
      seo_metadata: { title: 'T'.repeat(300), description: 'D'.repeat(9000), tags: [] },
    });
    expect(meta.title).toHaveLength(TITLE_MAX);
    expect(meta.description).toHaveLength(DESCRIPTION_MAX);
  });

  it('strips angle brackets, which YouTube refuses outright', () => {
    const meta = buildMetadata({ seo_metadata: { title: 'A <b>bold</b> claim', description: '<script>x</script>', tags: ['<i>t</i>'] } });
    expect(meta.title).not.toMatch(/[<>]/);
    expect(meta.description).not.toMatch(/[<>]/);
    expect(meta.tags.join('')).not.toMatch(/[<>]/);
  });

  it('keeps total tag length under the cap, dropping the overflow', () => {
    const meta = buildMetadata({ seo_metadata: { title: 't', description: '', tags: Array.from({ length: 100 }, (_, i) => `tag-number-${i}`) } });
    const total = meta.tags.reduce((n, t) => n + t.length + 1, 0);
    expect(total).toBeLessThanOrEqual(460);
    expect(meta.tags.length).toBeGreaterThan(0);
    expect(meta.tags.length).toBeLessThan(100);
  });

  it('skips blank tags rather than sending empty strings', () => {
    const meta = buildMetadata({ seo_metadata: { title: 't', description: '', tags: ['ok', '', '   ', 'fine'] } });
    expect(meta.tags).toEqual(['ok', 'fine']);
  });
});

describe('configuration reporting', () => {
  it('names both missing variables', () => {
    expect(missingConfig()).toEqual(['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET']);
  });

  it('reports not-configured and not-connected without throwing', () => {
    const status = connectionStatus();
    expect(status.configured).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.redirectUri).toContain('/api/youtube/callback');
  });

  it('refuses to build an auth URL, and says what to do about it', () => {
    let err: any;
    try { buildAuthUrl('state123'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(YouTubeNotConfiguredError);
    // A service account is the wrong tool here and the obvious thing to reach for,
    // since one is already configured for Vertex. The message has to say so.
    expect(err.message).toMatch(/service account cannot be used/i);
    expect(err.message).toMatch(/YouTube Data API v3/);
  });

  it('asks for offline access, or the connection dies within the hour', () => {
    process.env.YOUTUBE_CLIENT_ID = 'test-id';
    process.env.YOUTUBE_CLIENT_SECRET = 'test-secret';
    const url = new URL(buildAuthUrl('state123'));

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    // Without access_type=offline AND prompt=consent, Google returns no refresh token.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('state123');
    expect(url.searchParams.get('scope')).toBe(YOUTUBE_SCOPES.join(' '));
    expect(url.searchParams.get('scope')).toContain('youtube.upload');
  });
});
