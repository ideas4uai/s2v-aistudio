import { describe, it, expect } from 'vitest';
import { getScenesToRender, getRemovedSceneIds, sceneRenderHash, globalRenderSignature } from '../src/utils/diff.js';

// getScenesToRender returned every scene id unconditionally, so editing one line of
// narration re-rendered the whole project. These lock in the four real edit shapes.
//
// The dangerous direction is under-invalidation: skipping a scene that actually
// changed ships a video whose scenes disagree with each other. Every "should
// re-render" case below matters more than the "should skip" ones.

const scene = (id: string, over: any = {}) => ({
  scene_id: id,
  order: Number(id.replace(/\D/g, '')) || 0,
  narration_text: `narration ${id}`,
  duration_target: 5,
  visuals: [{ visual_id: `v-${id}`, prompt: `prompt ${id}`, motion_instruction: 'zoom_in' }],
  ...over,
});

const project = (scenes: any[], settings: any = {}) => ({
  project_id: 'p',
  settings: { aspectRatio: '16:9', visualStyle: 'cinematic', motionEffect: 'alternate', ...settings },
  scenes,
});

/** Render the project once: stamp every scene with its current hash. */
function markRendered(p: any) {
  for (const s of p.scenes) s.render_hash = sceneRenderHash(s, p);
  return p;
}

describe('single-scene edit', () => {
  it('re-renders only the edited scene', () => {
    const p = markRendered(project([scene('s1'), scene('s2'), scene('s3')]));
    const before = p.scenes.map((s: any) => ({ ...s }));
    p.scenes[1].narration_text = 'edited narration';

    expect(getScenesToRender(before, p.scenes, p)).toEqual(['s2']);
  });

  it('re-renders a scene whose visual prompt changed', () => {
    const p = markRendered(project([scene('s1'), scene('s2')]));
    const before = p.scenes.map((s: any) => ({ ...s }));
    p.scenes[0].visuals[0].prompt = 'a different image';
    expect(getScenesToRender(before, p.scenes, p)).toEqual(['s1']);
  });

  it('re-renders a scene whose motion changed', () => {
    const p = markRendered(project([scene('s1'), scene('s2')]));
    const before = p.scenes.map((s: any) => ({ ...s }));
    p.scenes[1].visuals[0].motion_instruction = 'pan_left';
    expect(getScenesToRender(before, p.scenes, p)).toEqual(['s2']);
  });

  it('skips everything when nothing changed', () => {
    const p = markRendered(project([scene('s1'), scene('s2'), scene('s3')]));
    expect(getScenesToRender(p.scenes, p.scenes, p)).toEqual([]);
  });

  it('ignores render results, so a scene does not differ from itself after rendering', () => {
    const p = markRendered(project([scene('s1')]));
    const before = p.scenes.map((s: any) => ({ ...s }));
    // These are outputs of a render, not inputs to one.
    p.scenes[0].segment_path = 'C:/tmp/s1_segment.mp4';
    p.scenes[0].status = 'completed';
    p.scenes[0].duration_actual = 4.2;
    expect(getScenesToRender(before, p.scenes, p)).toEqual([]);
  });
});

describe('global setting edit', () => {
  // Scoping these down to the edited scene would ship a video whose scenes do not
  // match each other — a 16:9 scene next to a 9:16 one.
  it.each([
    ['aspectRatio', '9:16'],
    ['exportResolution', '4k'],
    ['visualStyle', 'anime'],
    ['motionEffect', 'pan_left'],
    ['targetLength', '90s'],
    ['language', 'hi'],
    ['voiceStyle', 'calm'],
  ])('re-renders every scene when %s changes', (key, value) => {
    const p = markRendered(project([scene('s1'), scene('s2'), scene('s3')]));
    const before = p.scenes.map((s: any) => ({ ...s }));
    p.settings[key] = value;
    expect(getScenesToRender(before, p.scenes, p)).toEqual(['s1', 's2', 's3']);
  });

  it('re-renders every scene when a universe art style changes', () => {
    const p: any = markRendered(project([scene('s1'), scene('s2')]));
    p.universe = { artStyle: 'graphic novel' };
    const before = p.scenes.map((s: any) => ({ ...s }));
    p.universe.artStyle = 'watercolour';
    expect(getScenesToRender(before, p.scenes, p)).toEqual(['s1', 's2']);
  });

  it('produces a different global signature per settings change', () => {
    const a = globalRenderSignature(project([], { aspectRatio: '16:9' }));
    const b = globalRenderSignature(project([], { aspectRatio: '9:16' }));
    expect(a).not.toBe(b);
  });
});

describe('scene addition', () => {
  it('renders only the new scene', () => {
    const p = markRendered(project([scene('s1'), scene('s2')]));
    const before = p.scenes.map((s: any) => ({ ...s }));
    p.scenes.push(scene('s3'));
    expect(getScenesToRender(before, p.scenes, p)).toEqual(['s3']);
  });

  it('treats a scene that never completed as needing a render', () => {
    const p = project([scene('s1'), scene('s2')]);
    // No render_hash anywhere — nothing has ever rendered.
    expect(getScenesToRender(p.scenes, p.scenes, p)).toEqual(['s1', 's2']);
  });
});

describe('scene deletion', () => {
  it('does not ask for the removed scene to be rendered', () => {
    const p = markRendered(project([scene('s1'), scene('s2'), scene('s3')]));
    const before = p.scenes.map((s: any) => ({ ...s }));
    p.scenes = [p.scenes[0], p.scenes[2]];
    const todo = getScenesToRender(before, p.scenes, p);
    expect(todo).not.toContain('s2');
  });

  it('reports which scenes were removed so their artefacts can be dropped', () => {
    const before = [scene('s1'), scene('s2'), scene('s3')];
    expect(getRemovedSceneIds(before, [scene('s1'), scene('s3')])).toEqual(['s2']);
  });

  it('handles an empty project without throwing', () => {
    expect(getScenesToRender([], [], project([]))).toEqual([]);
    expect(getRemovedSceneIds([], [])).toEqual([]);
  });
});

describe('draft vs final', () => {
  it('re-renders everything when switching from draft to final', () => {
    // A draft is 720p with no parallax. Reusing its segments for a final render
    // would ship the cheap version as the finished video.
    const p: any = markRendered(project([scene('s1'), scene('s2')]));
    p.preview_mode = true;
    const draftHashes = p.scenes.map((s: any) => ({ ...s, render_hash: sceneRenderHash(s, p) }));

    p.preview_mode = false;
    expect(getScenesToRender(draftHashes, p.scenes, p)).toEqual(['s1', 's2']);
  });

  it('skips unchanged scenes within the same mode', () => {
    const p: any = project([scene('s1'), scene('s2')]);
    p.preview_mode = true;
    markRendered(p);
    expect(getScenesToRender(p.scenes, p.scenes, p)).toEqual([]);
  });
});
