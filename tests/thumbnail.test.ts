import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  ensureThumbnail, thumbnailTextOf, thumbnailPath, thumbnailDir,
  sceneImagesOf, thumbnailSources, GRAB_AT_SECONDS,
} from '../src/server/services/thumbnailService.js';
import { addChannel, updateChannel } from '../src/server/services/channelStore.js';

/**
 * The thumbnail is a composed layout built from the episode's own art.
 *
 * Run against real generated files rather than mocks: the properties worth asserting —
 * that scene art is preferred over the video, that a project with no art still gets a
 * thumbnail, that changing the headline rebuilds it — are properties of what lands on
 * disk, and a mocked fs would prove none of them.
 */

const ffmpegPath = (await import('ffmpeg-static')).default as unknown as string;

let dir: string;
let video: string;
const ORIGINAL = {
  out: process.env.OUTPUTS_DIR, thumbs: process.env.THUMBNAIL_DIR, token: process.env.YOUTUBE_TOKEN_PATH,
};

/** A real, decodable mp4 long enough to seek into. */
const makeVideo = (file: string) => {
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=12:duration=3',
    '-pix_fmt', 'yuv420p', '-y', file,
  ], { timeout: 60_000 });
};

/** A real coloured still, standing in for a generated scene image. */
const makeStill = (file: string, colour = 'red') => {
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${colour}:size=640x360`,
    '-frames:v', '1', '-y', file,
  ], { timeout: 60_000 });
  return file;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-'));
  process.env.OUTPUTS_DIR = dir;
  process.env.THUMBNAIL_DIR = path.join(dir, 'thumbnails');
  process.env.YOUTUBE_TOKEN_PATH = path.join(dir, 'youtube-tokens.json');
  video = path.join(dir, 'render.mp4');
  makeVideo(video);
});

afterEach(() => {
  for (const [k, v] of [
    ['OUTPUTS_DIR', ORIGINAL.out], ['THUMBNAIL_DIR', ORIGINAL.thumbs], ['YOUTUBE_TOKEN_PATH', ORIGINAL.token],
  ] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const withScenes = (files: string[], over: any = {}) => ({
  project_id: 'p1',
  seo_metadata: { thumbnailText: 'RAG: Truth for Your AI' },
  scenes: files.map((f, i) => ({ scene_id: `s${i}`, visuals: [{ asset_path: f, approved: i === 0 }] })),
  ...over,
});

describe('thumbnailTextOf', () => {
  it('reads the SEO agent’s headline under either field name', () => {
    expect(thumbnailTextOf({ seo_metadata: { thumbnailText: 'RAG: Truth' } })).toBe('RAG: Truth');
    expect(thumbnailTextOf({ seoMetadata: { thumbnailText: '  Padded  ' } })).toBe('Padded');
  });

  it('is empty rather than undefined when there is no headline', () => {
    expect(thumbnailTextOf({})).toBe('');
    expect(thumbnailTextOf(null)).toBe('');
  });
});

describe('which pictures the thumbnail is built from', () => {
  it('collects the scene art that is really on disk, approved first', () => {
    const a = makeStill(path.join(dir, 'a.jpg'), 'blue');
    const b = makeStill(path.join(dir, 'b.jpg'), 'green');
    const project = {
      scenes: [
        { visuals: [{ asset_path: b }] },
        { visuals: [{ asset_path: a, approved: true }] },
        { visuals: [{ asset_path: path.join(dir, 'gone.jpg') }] },  // never generated
      ],
    };
    // Approved leads because a human has already accepted that image.
    expect(sceneImagesOf(project)).toEqual([a, b]);
  });

  it('prefers scene art over the video — the whole point of the redesign', () => {
    const a = makeStill(path.join(dir, 'a.jpg'));
    const picked = thumbnailSources(withScenes([a]), video);
    expect(picked.source).toBe('scene');
    expect(picked.images).toEqual([a]);
  });

  it('falls back to the video when the project has no art on disk', () => {
    const picked = thumbnailSources({ scenes: [] }, video);
    expect(picked.source).toBe('frame');
    expect(picked.images).toEqual([video]);
  });

  it('has nothing to offer when there is neither', () => {
    expect(thumbnailSources({ scenes: [] }, path.join(dir, 'nope.mp4')).images).toEqual([]);
  });
});

describe('composing', () => {
  it('builds a thumbnail from scene art', async () => {
    const a = makeStill(path.join(dir, 'a.jpg'), 'blue');
    const res = await ensureThumbnail('p1', withScenes([a]), video);
    expect(res.source).toBe('scene');
    expect(res.hasText).toBe(true);
    expect(res.regenerated).toBe(true);
    expect(res.path).toBe(thumbnailPath('p1'));
    const size = fs.statSync(res.path).size;
    expect(size).toBeGreaterThan(2000);
    expect(size).toBeLessThanOrEqual(2 * 1024 * 1024);   // YouTube's hard ceiling
  }, 180_000);

  it('scores the candidates rather than taking the first', async () => {
    // The same two images offered in opposite orders. If the compositor took whichever
    // came first the two thumbnails would differ; scoring makes the order irrelevant,
    // which is the whole claim. Two project ids so neither run can read the other's
    // cached file.
    const a = makeStill(path.join(dir, 'a.jpg'), 'navy');
    const b = makeStill(path.join(dir, 'b.jpg'), 'orange');
    const forward = await ensureThumbnail('p2a', withScenes([a, b]), video);
    const reversed = await ensureThumbnail('p2b', withScenes([b, a]), video);
    expect(fs.readFileSync(forward.path).equals(fs.readFileSync(reversed.path))).toBe(true);
  }, 240_000);

  it('still composes when the project has no headline', async () => {
    const a = makeStill(path.join(dir, 'a.jpg'));
    const res = await ensureThumbnail('p3', withScenes([a], { seo_metadata: {} }), video);
    expect(fs.existsSync(res.path)).toBe(true);
    expect(res.hasText).toBe(false);
    expect(res.note).toMatch(/no thumbnailText/i);
  }, 180_000);

  it('uses a video frame when there is no art, through the same compositor', async () => {
    const res = await ensureThumbnail('p4', { scenes: [], seo_metadata: { thumbnailText: 'Fallback' } }, video);
    expect(res.source).toBe('frame');
    expect(fs.statSync(res.path).size).toBeGreaterThan(2000);
  }, 180_000);

  it('refuses only when there is no picture at all', async () => {
    await expect(ensureThumbnail('p5', { scenes: [] }, path.join(dir, 'nope.mp4')))
      .rejects.toThrow(/neither scene images nor a rendered video/i);
  });

  it('writes into the thumbnails directory, not next to the art', async () => {
    const a = makeStill(path.join(dir, 'a.jpg'));
    await ensureThumbnail('p6', withScenes([a]), video);
    expect(fs.existsSync(path.join(thumbnailDir(), 'p6.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'p6.jpg'))).toBe(false);
  }, 180_000);
});

describe('the channel’s branding reaches the thumbnail', () => {
  it('passes the channel logo, which scene art has never seen', async () => {
    // The old thumbnail inherited the watermark from the render it was cut out of.
    // Scene art has not been near the renderer, so an unbranded thumbnail is the
    // failure this guards: the logo has to travel with the recipe.
    const logo = makeStill(path.join(dir, 'logo.png'), 'white');
    addChannel({ channelId: 'UC1', title: 'Learn AI with B', refreshToken: 'rt' });
    updateChannel('UC1', (c) => { c.logoPath = logo; });

    const a = makeStill(path.join(dir, 'a.jpg'), 'navy');
    const branded = await ensureThumbnail('p7', withScenes([a], { channel_id: 'UC1' }), video);
    const plain = await ensureThumbnail('p8', withScenes([a]), video);
    expect(fs.readFileSync(branded.path).equals(fs.readFileSync(plain.path))).toBe(false);
  }, 240_000);
});

describe('when the work is reused', () => {
  it('rebuilds for anything that changes the picture, and only then', async () => {
    // One sequence rather than four cases: each ensureThumbnail spawns Python, and this
    // file already adds more of that to the suite than any other.
    const a = makeStill(path.join(dir, 'a.jpg'));
    await ensureThumbnail('r1', withScenes([a]), video);

    // Nothing changed.
    expect((await ensureThumbnail('r1', withScenes([a]), video)).regenerated).toBe(false);

    // The headline changed.
    const reworded = withScenes([a], { seo_metadata: { thumbnailText: 'Different Words' } });
    expect((await ensureThumbnail('r1', reworded, video)).regenerated).toBe(true);

    // The art itself was regenerated — the mtime check, as the render pipeline uses.
    const later = Date.now() + 10_000;
    fs.utimesSync(a, later / 1000, later / 1000);
    expect((await ensureThumbnail('r1', reworded, video)).regenerated).toBe(true);

    // One more image exists than before. The candidate set is part of the recipe: a
    // re-render that adds an image can change which one wins, and without this the old
    // file would stand.
    const b = makeStill(path.join(dir, 'b.jpg'), 'yellow');
    expect((await ensureThumbnail('r1', withScenes([a, b], { seo_metadata: { thumbnailText: 'Different Words' } }), video)).regenerated).toBe(true);
  }, 300_000);
});

describe('the frame grab point', () => {
  it('is past the opening frame, so a fade-up is not the thumbnail', () => {
    expect(GRAB_AT_SECONDS).toBeGreaterThan(0.5);
    expect(GRAB_AT_SECONDS).toBeLessThan(3);
  });
});
