import { describe, it, expect } from 'vitest';
import { slugifyTitle, shortId, projectVideoFileName } from '../src/utils/filename.js';

const UUID = '04fa8d80-7de2-409b-aef9-57c70eb177b5';

describe('slugifyTitle', () => {
  it('turns a normal title into a readable slug', () => {
    expect(slugifyTitle('What is a REST API?')).toBe('what-is-a-rest-api');
  });

  it('collapses punctuation and whitespace runs into single separators', () => {
    expect(slugifyTitle('Top 5 AI  tools --- for   productivity!!')).toBe('top-5-ai-tools-for-productivity');
  });

  it('strips accents rather than dropping the letters', () => {
    expect(slugifyTitle('Café Über Naïve')).toBe('cafe-uber-naive');
  });

  it('never starts or ends with a separator', () => {
    expect(slugifyTitle('  ...Hello World!!!  ')).toBe('hello-world');
  });

  it('truncates a very long title without leaving a trailing dash', () => {
    const slug = slugifyTitle('a'.repeat(200));
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);

    const wordy = slugifyTitle(Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '));
    expect(wordy.length).toBeLessThanOrEqual(60);
    expect(wordy.endsWith('-')).toBe(false);
  });

  it('returns empty for scripts with no ASCII (caller falls back)', () => {
    expect(slugifyTitle('नमस्ते दोस्तों')).toBe('');
    expect(slugifyTitle('నమస్కారం మిత్రులారా')).toBe('');
    expect(slugifyTitle('🎬🎥')).toBe('');
  });

  it('keeps the ASCII part of a mixed-script title', () => {
    expect(slugifyTitle('HINDI VOICE CHECK हिंदी')).toBe('hindi-voice-check');
  });

  it('handles missing titles', () => {
    expect(slugifyTitle(undefined)).toBe('');
    expect(slugifyTitle(null)).toBe('');
    expect(slugifyTitle('')).toBe('');
  });
});

describe('shortId', () => {
  it('takes the first uuid group', () => {
    expect(shortId(UUID)).toBe('04fa8d80');
  });

  it('degrades rather than throwing on junk', () => {
    expect(shortId('')).toBe('unknown');
    expect(shortId(undefined)).toBe('unknown');
  });
});

describe('projectVideoFileName', () => {
  it('produces a readable, uuid-tagged name', () => {
    expect(projectVideoFileName('What is a REST API?', UUID)).toBe('what-is-a-rest-api-04fa8d80.mp4');
  });

  it('falls back to a generic stem for non-ASCII titles but stays identifiable', () => {
    expect(projectVideoFileName('नमस्ते दोस्तों', UUID)).toBe('video-04fa8d80.mp4');
  });

  it('supports variant suffixes', () => {
    expect(projectVideoFileName('My Video', UUID, '_preview')).toBe('my-video-04fa8d80_preview.mp4');
  });

  it('keeps two same-titled projects from colliding', () => {
    const a = projectVideoFileName('Same Title', '11111111-aaaa-bbbb-cccc-dddddddddddd');
    const b = projectVideoFileName('Same Title', '22222222-aaaa-bbbb-cccc-dddddddddddd');
    expect(a).not.toBe(b);
  });

  it('is always filesystem- and URL-safe', () => {
    for (const title of ['a/b\\c:d*e?f"g<h>i|j', 'नमस्ते', '   ', 'Ünïcödé Tïtlé', '🎬']) {
      const name = projectVideoFileName(title, UUID);
      expect(name).toMatch(/^[a-z0-9._-]+\.mp4$/);
      expect(encodeURIComponent(name)).toBe(name);
    }
  });
});
