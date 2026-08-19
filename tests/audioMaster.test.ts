import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { resolveMusicTrack } from '../src/services/renderService.js';

// There was no mixing stage at all — not a weak one, an absent one. The whole
// audio chain was asetpts (a timestamp reset), silenceremove (an edit) and apad
// (padding), none of which touch amplitude, spectrum or dynamics. Measured across
// six renders including both YouTube uploads: -21.7 to -25.2 LUFS, every one
// 8-11 LU under YouTube's -14 target.

const render = fs.readFileSync(path.join(process.cwd(), 'src/services/renderService.ts'), 'utf-8');

describe('the master pass', () => {
  it('normalises to YouTube\'s target with encode headroom', () => {
    expect(render).toMatch(/loudnorm=I=-14:TP=-1\.5:LRA=11/);
  });

  it('compresses the voice — it was completely uncompressed', () => {
    // Measured crest factor 8-11 with 17-19 dB of headroom unused.
    expect(render).toMatch(/acompressor=threshold=-18dB:ratio=3/);
    expect(render).toMatch(/highpass=f=80/);
  });

  it('runs whether or not a music track was chosen', () => {
    // The old code only re-encoded audio inside `if (musicTrack)`, so a render
    // with no bed got no processing whatsoever.
    const master = render.slice(render.indexOf('── Master.'));
    const branch = master.slice(0, master.indexOf('} catch (masterErr'));
    expect(branch).toMatch(/filter = `\[0:a\]\$\{voice\},\$\{master\}\[aout\]`/);
  });

  it('measures the finished mix, not the voice before the bed joins it', () => {
    const master = render.slice(render.indexOf('── Master.'));
    expect(master.indexOf('[mix]${master}[aout]')).toBeGreaterThan(master.indexOf('amix=inputs=2'));
  });

  it('ducks the bed under the voice instead of a static gain', () => {
    expect(render).toMatch(/sidechaincompress=threshold=0\.03:ratio=8/);
    // the voice is the key, the bed is the thing being compressed
    expect(render).toMatch(/\[bg\]\[vk\]sidechaincompress/);
  });

  it('keeps normalize=0 so the bed does not attenuate the narration', () => {
    expect(render).toMatch(/amix=inputs=2:duration=first:normalize=0/);
  });

  it('never loses a finished render to the mastering pass', () => {
    expect(render).toMatch(/Mastering failed, using unmastered video/);
  });
});

describe('music track resolution', () => {
  it('honours an explicit choice', () => {
    expect(resolveMusicTrack({ music_track: '02-cinematic-inspiring.mp3.mp3' }))
      .toBe('02-cinematic-inspiring.mp3.mp3');
    expect(resolveMusicTrack({ settings: { musicTrack: '07-chill-beats.mp3.mp3' } }))
      .toBe('07-chill-beats.mp3.mp3');
  });

  it('treats an explicit empty string as "no music" — that is a choice', () => {
    expect(resolveMusicTrack({ music_track: '' })).toBe('');
    expect(resolveMusicTrack({ settings: { musicTrack: '' } })).toBe('');
  });

  it('falls back for a project that was never given one', () => {
    // music_track is only written by a human in the editor, so every
    // pipeline-created project had none. Five of six audited renders were null.
    const picked = resolveMusicTrack({});
    expect(picked).not.toBe('');
    expect(fs.existsSync(path.join(process.cwd(), 'music', picked))).toBe(true);
  });

  it('matches by prefix, so the doubled .mp3.mp3 extension cannot miss it', () => {
    const picked = resolveMusicTrack({});
    expect(picked.startsWith('04-ambient-background')).toBe(true);
    expect(picked).toMatch(/\.mp3\.mp3$/);
  });

  it('returns empty rather than throwing when there is no music directory', () => {
    const prev = process.env.MUSIC_DIR;
    process.env.MUSIC_DIR = path.join(process.cwd(), 'no-such-music-dir');
    try {
      expect(resolveMusicTrack({})).toBe('');
    } finally {
      if (prev === undefined) delete process.env.MUSIC_DIR;
      else process.env.MUSIC_DIR = prev;
    }
  });
});
