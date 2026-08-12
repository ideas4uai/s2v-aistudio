import { describe, it, expect } from 'vitest';
import { resetSceneForRetry } from '../src/pipeline/orchestrator.js';

// POST /:id/retry-failed-assets had two problems stacked on each other.
//
// It read and wrote through FirestoreService, which returns null under
// DISABLE_FIRESTORE=true, so it 404'd on every local project and reset nothing.
//
// And the reset itself was a no-op even when it did run: it set status back to
// 'pending' but left every artifact path in place. The pipeline skips a stage whose
// path field is already set, so a scene that failed *after* writing a bad artifact came
// back "pending" and was then skipped on the very next render. The endpoint reported
// success and changed nothing — which is the worse half of the bug, because the render
// looked like it had retried.

const failedScene = () => ({
  scene_id: 's1',
  status: 'failed',
  error_log: 'Gemini image generation failed: quota exceeded',
  errorLog: 'Gemini image generation failed: quota exceeded',
  rendered_path: 'C:/tmp/bad_render.mp4',
  segment_path: 'C:/tmp/bad_segment.mp4',
  captioned_path: 'C:/tmp/bad_captioned.mp4',
  render_hash: 'deadbeef',
  narration_path: 'C:/tmp/good_narration.wav',
  audio_hash: 'abc123',
  duration_actual: 6.88,
  visuals: [
    { visual_id: 'v1', status: 'failed', asset_path: 'C:/tmp/bad.jpg', rendered_path: 'C:/tmp/bad.mp4', prompt: 'a cat' },
  ],
});

describe('resetSceneForRetry', () => {
  it('marks the scene and its visuals pending again', () => {
    const scene = failedScene();
    resetSceneForRetry(scene);
    expect(scene.status).toBe('pending');
    expect(scene.visuals[0].status).toBe('pending');
  });

  it('clears the failure so it is not re-reported after a good render', () => {
    const scene = failedScene();
    resetSceneForRetry(scene);
    expect(scene.error_log).toBeNull();
    expect(scene.errorLog).toBeNull();
  });

  it('drops every artifact path, or the next render skips the scene entirely', () => {
    // This is the assertion that would have caught the silent no-op.
    const scene = failedScene();
    resetSceneForRetry(scene);
    expect(scene.rendered_path).toBeUndefined();
    expect(scene.segment_path).toBeUndefined();
    expect(scene.captioned_path).toBeUndefined();
    expect(scene.render_hash).toBeUndefined();
    expect(scene.visuals[0].asset_path).toBeUndefined();
    expect(scene.visuals[0].rendered_path).toBeUndefined();
  });

  it('keeps the narration, which is the expensive half and was not what failed', () => {
    const scene = failedScene();
    resetSceneForRetry(scene);
    expect(scene.narration_path).toBe('C:/tmp/good_narration.wav');
    expect(scene.audio_hash).toBe('abc123');
    expect(scene.duration_actual).toBe(6.88);
  });

  it('keeps the prompt, so the retry regenerates the same shot', () => {
    const scene = failedScene();
    resetSceneForRetry(scene);
    expect(scene.visuals[0].prompt).toBe('a cat');
  });

  it('survives a scene with no visuals array at all', () => {
    const scene: any = { scene_id: 's2', status: 'failed' };
    expect(() => resetSceneForRetry(scene)).not.toThrow();
    expect(scene.status).toBe('pending');
  });
});
