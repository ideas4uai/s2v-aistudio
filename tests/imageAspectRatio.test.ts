import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { isShortsProject, outputResolution } from '../src/services/renderService.js';

// Regression cover for "the top of the image is cut off in the rendered video".
//
// The crop was never wrong. renderService cover-crops with
//   crop='min(iw,ih*W/H)':'min(ih,iw*H/W)'
// which is exactly centred. What was wrong was the images: in a 16:9 project every
// background came back 768x1344 PORTRAIT, because orchestrator called
// generateImageBase64 without an aspectRatio and that function defaults to 9:16:
//
//   const isLandscape = !isStoryEpisode && options?.aspectRatio === '16:9';
//
// Cover-cropping 768x1344 into 1920x1080 scales by 2.5 to 1920x3360 and keeps the
// middle 1080 rows — 32% of the height, discarding the top 34% and the bottom 34%.
// That is why heads were cut off. Two of the three call sites already passed the
// aspect; this pins that all of them do.

const SRC = path.join(process.cwd(), 'src');

/** Every .ts/.tsx under src/, so a new caller cannot be added out of view of this test. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe('every image generation call states its aspect ratio', () => {
  it('has no caller relying on the silent 9:16 default', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const src = fs.readFileSync(file, 'utf-8');
      if (file.endsWith(path.join('services', 'aiService.ts'))) continue; // the definition

      // Match the call and its options object, across lines.
      for (const m of src.matchAll(/generateImageBase64\(([\s\S]*?)\)\s*[;,)]/g)) {
        const args = m[1];
        if (!/aspectRatio/.test(args)) {
          const line = src.slice(0, m.index).split(/\r?\n/).length;
          offenders.push(`${path.relative(process.cwd(), file)}:${line}`);
        }
      }
    }

    expect(offenders, `these call generateImageBase64 without an aspectRatio, so they ` +
      `silently get 9:16 and a 16:9 render crops away two thirds of the height:\n` +
      offenders.join('\n')).toEqual([]);
  });
});

describe('the aspect a project renders at', () => {
  it('is landscape for a plain 16:9 project', () => {
    const project = { settings: { aspectRatio: '16:9' } };
    expect(isShortsProject(project)).toBe(false);
    const { w, h } = outputResolution('1080p', false, false);
    expect(w).toBeGreaterThan(h);
  });

  it('is portrait for 9:16, universes and story episodes alike', () => {
    expect(isShortsProject({ settings: { aspectRatio: '9:16' } })).toBe(true);
    expect(isShortsProject({ universe: { artStyle: 'x' } })).toBe(true);
    expect(isShortsProject({ projectType: 'story_episode' })).toBe(true);
  });
});

describe('what a mismatched source aspect costs', () => {
  /** Fraction of the source width and height surviving a centred cover-crop to w x h. */
  const kept = (iw: number, ih: number, w: number, h: number) => {
    const scale = Math.max(w / iw, h / ih);
    return {
      width: Math.min(1, w / (iw * scale)),
      height: Math.min(1, h / (ih * scale)),
    };
  };

  it('costs almost nothing when the source is generated for the output aspect', () => {
    // 1344x768 is what Gemini returns for a 16:9 request. It is 7:4, marginally taller
    // than 16:9, so the crop trims ~1.6% off the height and nothing off the width.
    const k = kept(1344, 768, 1920, 1080);
    expect(k.width).toBeCloseTo(1, 5);
    expect(k.height).toBeGreaterThan(0.98);
  });

  it('throws away two thirds of a portrait source in a landscape render', () => {
    // The measured bug: 768x1344 backgrounds in a 1920x1080 project.
    const k = kept(768, 1344, 1920, 1080);
    expect(k.width).toBeCloseTo(1, 5);
    expect(k.height).toBeCloseTo(0.321, 3);
    // Centred, so the loss splits evenly — a subject in the upper third is gone.
    expect((1 - k.height) / 2).toBeGreaterThan(0.33);
  });

  it('costs the same in the other direction, just off the sides', () => {
    // A landscape source in a Shorts render keeps its full height and loses the width.
    const k = kept(1344, 768, 1080, 1920);
    expect(k.height).toBeCloseTo(1, 5);
    expect(k.width).toBeCloseTo(0.321, 3);
  });
});
