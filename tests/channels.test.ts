import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readStore, writeStore, addChannel, getChannel, listChannels, removeChannel,
  setLastUsed, updateChannel, resolveChannel,
} from '../src/server/services/channelStore.js';
import { buildVideoFilter, WATERMARK, channelWatermarkPath } from '../src/services/renderService.js';

/**
 * Channels, their credentials, and the watermark that identifies them.
 *
 * The store is pointed at a temp file through YOUTUBE_TOKEN_PATH rather than mocked,
 * because the two things worth asserting — that a v1 file still works, and that
 * re-consenting to one channel does not disturb the other two — are properties of what
 * lands on disk.
 */

let dir: string;
let prevPath: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chan-'));
  prevPath = process.env.YOUTUBE_TOKEN_PATH;
  process.env.YOUTUBE_TOKEN_PATH = path.join(dir, 'youtube-tokens.json');
});

afterEach(() => {
  if (prevPath === undefined) delete process.env.YOUTUBE_TOKEN_PATH;
  else process.env.YOUTUBE_TOKEN_PATH = prevPath;
  fs.rmSync(dir, { recursive: true, force: true });
});

const connect = (id: string, title: string) =>
  addChannel({ channelId: id, title, refreshToken: `rt-${id}` });

describe('backward compatibility with the single-channel file', () => {
  it('reads a v1 token file as a one-channel store', () => {
    // Exactly the shape that shipped before channels existed.
    fs.writeFileSync(process.env.YOUTUBE_TOKEN_PATH!, JSON.stringify({
      refreshToken: 'rt-old', accessToken: 'at-old', expiresAtMs: 123,
      connectedAt: '2026-08-01T00:00:00Z', scopes: ['upload'],
      channelId: 'UCold', channelTitle: 'AIQAEngineer',
    }));
    const store = readStore();
    expect(store.version).toBe(2);
    expect(Object.keys(store.channels)).toEqual(['UCold']);
    expect(store.channels.UCold.refreshToken).toBe('rt-old');
    expect(store.channels.UCold.title).toBe('AIQAEngineer');
    // The existing install must keep publishing without reconnecting.
    expect(resolveChannel({})?.channelId).toBe('UCold');
    expect(store.lastUsedChannelId).toBe('UCold');
  });

  it('does not rewrite the v1 file until something actually changes', () => {
    const file = process.env.YOUTUBE_TOKEN_PATH!;
    fs.writeFileSync(file, JSON.stringify({ refreshToken: 'rt', channelId: 'UCold', channelTitle: 'X' }));
    const before = fs.readFileSync(file, 'utf-8');
    readStore(); readStore();
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('is an empty store when there is no file at all', () => {
    expect(readStore().channels).toEqual({});
    expect(resolveChannel({})).toBeUndefined();
    expect(listChannels()).toEqual([]);
  });
});

describe('connecting channels one consent at a time', () => {
  it('accumulates rather than replacing', () => {
    connect('UC1', 'AI QA Engineer');
    connect('UC2', 'Learn AI with B');
    connect('UC3', 'B with Tech');
    expect(listChannels().map(c => c.title)).toEqual(['AI QA Engineer', 'B with Tech', 'Learn AI with B']);
    expect(getChannel('UC1')?.refreshToken).toBe('rt-UC1');
  });

  it('re-consenting to one channel keeps the others and their tokens', () => {
    connect('UC1', 'AI QA Engineer');
    connect('UC2', 'Learn AI with B');
    addChannel({ channelId: 'UC1', title: 'AI QA Engineer', refreshToken: 'rt-fresh' });
    expect(getChannel('UC1')?.refreshToken).toBe('rt-fresh');
    expect(getChannel('UC2')?.refreshToken).toBe('rt-UC2');
    expect(listChannels()).toHaveLength(2);
  });

  it('re-consenting does not wipe the logo Google knows nothing about', () => {
    connect('UC1', 'AI QA Engineer');
    updateChannel('UC1', (c) => { c.logoPath = '/logos/UC1.png'; });
    addChannel({ channelId: 'UC1', title: 'AI QA Engineer', refreshToken: 'rt-fresh' });
    expect(getChannel('UC1')?.logoPath).toBe('/logos/UC1.png');
  });

  it('disconnecting one channel leaves the rest publishable', () => {
    connect('UC1', 'A'); connect('UC2', 'B');
    expect(removeChannel('UC1')).toBe(true);
    expect(listChannels().map(c => c.channelId)).toEqual(['UC2']);
    expect(removeChannel('UC1')).toBe(false);
  });

  it('never leaves last-used pointing at a channel that is gone', () => {
    connect('UC1', 'A'); connect('UC2', 'B');
    setLastUsed('UC1');
    removeChannel('UC1');
    expect(readStore().lastUsedChannelId).toBe('UC2');
  });

  it('writes the store atomically, leaving no .tmp behind', () => {
    connect('UC1', 'A');
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('which channel an upload targets', () => {
  beforeEach(() => { connect('UC1', 'AI QA Engineer'); connect('UC2', 'Learn AI with B'); setLastUsed('UC2'); });

  it('honours an explicit request above everything', () => {
    expect(resolveChannel({ requested: 'UC1', projectChannelId: 'UC2' })?.channelId).toBe('UC1');
  });

  it("falls back to the project's own tag before last-used", () => {
    // The point of tagging at creation: content made FOR a channel goes to that channel
    // even when the last thing published went somewhere else.
    expect(resolveChannel({ projectChannelId: 'UC1' })?.channelId).toBe('UC1');
  });

  it('uses last-used only when the project carries no tag', () => {
    expect(resolveChannel({})?.channelId).toBe('UC2');
    expect(resolveChannel({ projectChannelId: null })?.channelId).toBe('UC2');
  });

  it('ignores a tag pointing at a channel that is no longer connected', () => {
    expect(resolveChannel({ projectChannelId: 'UC-gone' })?.channelId).toBe('UC2');
    expect(resolveChannel({ requested: 'UC-gone', projectChannelId: 'UC1' })?.channelId).toBe('UC1');
  });

  it('is undefined when nothing is connected, rather than guessing', () => {
    removeChannel('UC1'); removeChannel('UC2');
    expect(resolveChannel({ projectChannelId: 'UC1' })).toBeUndefined();
  });
});

describe('watermark compositing', () => {
  it('leaves an unbranded render byte-for-byte as it was', () => {
    const f = buildVideoFilter(null, ',scale=1080:1920', ",ass='x.ass'", 1080);
    expect(f.inputArg).toBe('');
    expect(f.mapArgs).toBe('');
    expect(f.filterArg).toBe(`-vf "setpts=PTS-STARTPTS,scale=1080:1920,ass='x.ass'"`);
  });

  it('rides in the existing encode — one extra input, no extra pass', () => {
    const f = buildVideoFilter('/logos/UC1.png', ',scale=1080:1920', '', 1080);
    expect(f.inputArg).toBe('-i "/logos/UC1.png"');
    expect(f.mapArgs).toBe('-map "[v]" -map 1:a');
    expect(f.filterArg).toContain('overlay=');
  });

  it('sizes and fades it to the restraint the attribution credit already uses', () => {
    const f = buildVideoFilter('/l.png', '', '', 1080);
    // 9% of 1080 = 97px, alpha 0.30 against the credit's 0.28.
    expect(f.filterArg).toContain('scale=97:-1');
    expect(f.filterArg).toContain('colorchannelmixer=aa=0.3');
    expect(WATERMARK.widthFrac).toBeLessThan(0.12);
    expect(WATERMARK.alpha).toBeLessThan(0.35);
  });

  it('sits bottom-left, clear of the bottom-right credit', () => {
    const f = buildVideoFilter('/l.png', '', '', 1080);
    expect(f.filterArg).toContain('overlay=0.04*W:0.982*H-h');
    // The credit anchors at 0.96W. Left margin + width must not reach it.
    expect(WATERMARK.marginXFrac + WATERMARK.widthFrac).toBeLessThan(0.9);
  });

  it('anchors the bottom edge so logos of any aspect ratio share one baseline', () => {
    expect(buildVideoFilter('/l.png', '', '', 1080).filterArg).toContain('*H-h');
  });

  it('draws captions after the overlay, so a watermark can never cover one', () => {
    const f = buildVideoFilter('/l.png', '', ",ass='c.ass'", 1080);
    expect(f.filterArg.indexOf('overlay=')).toBeLessThan(f.filterArg.indexOf('ass='));
  });

  it('scales with the frame rather than being a fixed pixel size', () => {
    expect(buildVideoFilter('/l.png', '', '', 720).filterArg).toContain('scale=65:-1');
    expect(buildVideoFilter('/l.png', '', '', 1920).filterArg).toContain('scale=173:-1');
  });
});

describe('channelWatermarkPath', () => {
  it('is null for a project with no channel', () => {
    expect(channelWatermarkPath({})).toBeNull();
    expect(channelWatermarkPath({ channel_id: null })).toBeNull();
  });

  it('is null when the channel has no logo — never a placeholder', () => {
    connect('UC1', 'A');
    expect(channelWatermarkPath({ channel_id: 'UC1' })).toBeNull();
  });

  it('is null when the logo file has been deleted from under us', () => {
    connect('UC1', 'A');
    updateChannel('UC1', (c) => { c.logoPath = path.join(dir, 'missing.png'); });
    expect(channelWatermarkPath({ channel_id: 'UC1' })).toBeNull();
  });

  it('returns the logo when it is really there', () => {
    const logo = path.join(dir, 'UC1.png');
    fs.writeFileSync(logo, 'png');
    connect('UC1', 'A');
    updateChannel('UC1', (c) => { c.logoPath = logo; });
    expect(channelWatermarkPath({ channel_id: 'UC1' })).toBe(logo);
  });
});
