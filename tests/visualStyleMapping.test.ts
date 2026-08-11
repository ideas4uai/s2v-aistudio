import { describe, it, expect } from 'vitest';
import { resolveArtStyle, VISUAL_STYLE_PHRASES } from '../src/pipeline/agents/storyboardAgent.js';

// Every value the UI dropdown and the built-in templates can produce.
const UI_OPTIONS = ['cinematic', 'anime', '3d', 'watercolor', 'cyberpunk', 'minimalist'];

// What the DirectorAgent actually emitted on the project that rendered anime-ish
// visuals despite "minimalist" being selected. It is free-form prose, so it never
// matches a phrase key — which is how it silently became the art style.
const LLM_STYLE = 'Sophisticated, minimalist digital aesthetic with glowing, ethereal elements. Clean lines and smooth motion graphics.';

describe('visual style mapping', () => {
  it('maps every UI/template option to a distinct phrase', () => {
    const phrases = UI_OPTIONS.map((o) => VISUAL_STYLE_PHRASES[o]);
    for (const [i, p] of phrases.entries()) {
      expect(p, `${UI_OPTIONS[i]} is unmapped`).toBeTruthy();
    }
    expect(new Set(phrases).size).toBe(UI_OPTIONS.length);
  });

  it("uses the user's pick instead of the director's invented style", () => {
    for (const opt of UI_OPTIONS) {
      const style = resolveArtStyle(
        { settings: { visualStyle: opt } } as any,
        { visual_style: LLM_STYLE } as any,
      );
      expect(style).toBe(VISUAL_STYLE_PHRASES[opt]);
    }
  });

  it('does not leak the anime phrase into a non-anime selection', () => {
    for (const opt of UI_OPTIONS.filter((o) => o !== 'anime')) {
      const style = resolveArtStyle({ settings: { visualStyle: opt } } as any, { visual_style: LLM_STYLE } as any);
      expect(style.toLowerCase()).not.toContain('anime');
    }
  });

  it('still lets a universe art style win — that is a deliberate lock', () => {
    const style = resolveArtStyle(
      { universe: { artStyle: 'South Asian graphic novel' }, settings: { visualStyle: 'anime' } } as any,
      { visual_style: LLM_STYLE } as any,
    );
    expect(style).toBe('South Asian graphic novel');
  });

  it('falls back to the director plan only when nothing was picked', () => {
    expect(resolveArtStyle({ settings: {} } as any, { visual_style: LLM_STYLE } as any)).toBe(LLM_STYLE);
    expect(resolveArtStyle({ settings: {} } as any, {} as any)).toBe('photorealistic');
  });

  it('passes an unknown style through rather than dropping it', () => {
    expect(resolveArtStyle({ settings: { visualStyle: 'claymation' } } as any, {} as any)).toBe('claymation');
  });
});
