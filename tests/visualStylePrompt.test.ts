import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { resolveArtStyle, VISUAL_STYLE_PHRASES } from '../src/pipeline/agents/storyboardAgent.js';

// Regression cover for renders coming out anime whatever the Visual Style said.
//
// resolveArtStyle was correct and had been fixed twice. The style was destroyed further
// downstream, in generateImageBase64, by:
//
//   const styledPrompt = finalPrompt.includes('anime')
//     ? finalPrompt
//     : `${finalPrompt}, semi-realistic anime style, flat colour shading, bold clean outlines`;
//
// which is "every prompt that is not already anime becomes anime". Picking Cinematic
// Realism sent the model "...photorealistic, cinematic lighting, sharp focus. Horizontal
// 16:9 landscape orientation., semi-realistic anime style, flat colour shading, bold
// clean outlines" — the anime terms last, where they weigh most. It shipped 2026-05-31,
// before either of the two earlier fixes, which is why fixing the resolver twice never
// helped: nothing upstream can survive being overwritten downstream.
//
// The second half of these tests reads aiService's source rather than calling it, because
// calling it costs a real image generation. What is being asserted is a property of the
// prompt-construction code, and that is exactly what is checked.

const AI_SERVICE_RAW = fs.readFileSync(
  path.join(process.cwd(), 'src/services/aiService.ts'), 'utf-8');

/**
 * Source with comments stripped.
 *
 * The fix documents the deleted code by quoting it, so asserting against the raw file
 * matches the explanation rather than the behaviour. Only executable code counts.
 */
const AI_SERVICE = AI_SERVICE_RAW
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

/** The dropdown in CreateProject.tsx. Every one of these must survive to the model. */
const DROPDOWN_STYLES = ['cinematic', 'anime', '3d', 'watercolor', 'cyberpunk', 'minimalist'];

const ANIME_TERMS = ['anime', 'manga', 'cel shading', 'cel-shaded', 'flat colour shading'];

describe('every dropdown style resolves to a real phrase', () => {
  it('has no unmapped value falling through as a bare adjective', () => {
    // How "minimalist" broke: shipped in a template, absent from the map.
    for (const style of DROPDOWN_STYLES) {
      expect(VISUAL_STYLE_PHRASES[style], `"${style}" is not in VISUAL_STYLE_PHRASES`).toBeTruthy();
    }
  });

  it('resolves the user pick over the director plan', () => {
    for (const style of DROPDOWN_STYLES) {
      const project = { settings: { visualStyle: style } };
      const resolved = resolveArtStyle(project, { visual_style: 'anime' });
      expect(resolved).toBe(VISUAL_STYLE_PHRASES[style]);
    }
  });

  it('only produces anime terms when anime was actually chosen', () => {
    for (const style of DROPDOWN_STYLES) {
      const resolved = resolveArtStyle({ settings: { visualStyle: style } }, {}).toLowerCase();
      const mentionsAnime = ANIME_TERMS.some((t) => resolved.includes(t));
      expect(mentionsAnime, `"${style}" resolved to "${resolved}"`).toBe(style === 'anime');
    }
  });

  it('still lets a universe override the dropdown', () => {
    // Illustrated universes carry their own artStyle and must keep winning.
    const project = { settings: { visualStyle: 'cinematic' }, universe: { artStyle: 'semi-realistic anime, bold outlines' } };
    expect(resolveArtStyle(project, {})).toBe('semi-realistic anime, bold outlines');
  });
});

describe('the image call must not restyle the prompt', () => {
  it('never appends an anime style to prompts that did not ask for one', () => {
    // The literal shape of the bug. If this string comes back, every non-anime style is
    // cel-shaded again and no amount of fixing resolveArtStyle will show up in the output.
    expect(AI_SERVICE).not.toContain('semi-realistic anime style, flat colour shading, bold clean outlines');
    expect(AI_SERVICE).not.toMatch(/finalPrompt\.includes\('anime'\)\s*\n?\s*\?/);
  });

  it('does not bolt photorealism onto an explicitly non-photoreal style', () => {
    // Same class, one layer up: the quality default fired for anything not literally
    // "photorealistic" or anime, so Watercolour Illustration asked for both at once.
    expect(AI_SERVICE).toContain('hasExplicitStyle');
    expect(AI_SERVICE).not.toMatch(/prompt\.includes\('photorealistic'\)\s*\|\|\s*isAnime\(prompt\)/);
  });

  it('treats every dropdown phrase as an explicit style', () => {
    // Extract the marker list from source and check each resolved phrase matches one,
    // so adding a style to the dropdown without a marker is caught here.
    const block = AI_SERVICE.match(/const EXPLICIT_STYLE_MARKERS = \[([\s\S]*?)\];/);
    expect(block, 'EXPLICIT_STYLE_MARKERS not found').toBeTruthy();
    const markers = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(markers.length).toBeGreaterThan(5);

    for (const style of DROPDOWN_STYLES) {
      const phrase = VISUAL_STYLE_PHRASES[style].toLowerCase();
      const matched = markers.some((m) => phrase.includes(m));
      expect(matched, `"${style}" -> "${phrase}" matches no marker, so it would be overridden with photorealistic`).toBe(true);
    }
  });
});
