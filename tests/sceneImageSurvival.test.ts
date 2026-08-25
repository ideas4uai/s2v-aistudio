import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * A generated image has to survive the next render.
 *
 * The pre-render sweep in orchestrator.ts clears `rendered_path` on every visual whose
 * value is a local file, because that field is meant to hold the compositor's mp4 for a
 * shot — a disposable intermediate. It clears it by path, not by extension.
 *
 * Both image-saving endpoints used to write the jpg there. The result, reproduced from a
 * real project: six generated images on disk, `scene.image_path` still pointing at all
 * six, and every `visuals[0]` emptied and reset to pending — so the renderer saw six
 * scenes with no shot and the UI showed nothing. "The images disappeared."
 *
 * These assertions are on the source rather than on a live render because the failure is
 * a field-name mismatch between two files that never call each other, and that is
 * exactly what a live render cannot show you until it is too late.
 */

const controller = fs.readFileSync(
  path.join(process.cwd(), 'src', 'controllers', 'projectController.ts'), 'utf-8',
);
const orchestrator = fs.readFileSync(
  path.join(process.cwd(), 'src', 'pipeline', 'orchestrator.ts'), 'utf-8',
);

/** The body of a function in the controller, so each endpoint is asserted on its own. */
const bodyOf = (name: string): string => {
  const start = controller.indexOf(`export async function ${name}`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = controller.indexOf('\nexport ', start + 1);
  return controller.slice(start, next === -1 ? undefined : next);
};

describe('the image endpoints write the field the sweep preserves', () => {
  for (const fn of ['generateSceneImage', 'saveSceneImage']) {
    it(`${fn} records the image on visuals[0].asset_path`, () => {
      const body = bodyOf(fn);
      expect(body).toMatch(/scene\.visuals\[0\]\.asset_path\s*=\s*url/);
      // And never on the disposable one.
      expect(body).not.toMatch(/scene\.visuals\[0\]\.rendered_path\s*=\s*url/);
    });

    it(`${fn} uses asset_path when it creates the visual too`, () => {
      const body = bodyOf(fn);
      const push = body.slice(body.indexOf('scene.visuals.push('));
      expect(push).toContain('asset_path: url');
      expect(push).not.toContain('rendered_path: url');
    });
  }
});

describe('the sweep this is protecting against', () => {
  it('still clears a local rendered_path — that is its job', () => {
    // If this ever stops being true the endpoints could go back to rendered_path, so the
    // assertion above would be pinned to a reason that no longer exists.
    expect(orchestrator).toMatch(/rendered_path\s*&&\s*!\(scene as any\)\.rendered_path\.startsWith\('http'\)/);
    expect(orchestrator).toContain("Clear local .mp4 intermediate");
  });

  it('states that generated images are kept on asset_path', () => {
    // The sweep's own comment is the contract the endpoints now honour.
    expect(orchestrator).toMatch(/generated images \(asset_path\) are kept/);
  });

  it('keeps a local asset_path across the sweep', () => {
    // The clearing of asset_path is guarded on it being an http URL; a local path is
    // left alone, which is the whole reason the image belongs there.
    expect(orchestrator).toMatch(/asset_path\?\.startsWith\('http'\)\)\s*\(v as any\)\.asset_path = undefined/);
  });
});

describe('the render halts rather than rewriting approved work', () => {
  it('refuses to continue when a scene has no narration', () => {
    // The behaviour that made the real failure safe: it stopped, named the scene, and
    // did not regenerate the script over six approved images.
    expect(orchestrator).toContain('cannot be rendered as they stand');
    expect(orchestrator).toMatch(/Halt rather than regenerate/);
    expect(orchestrator).toMatch(/is missing \$\{!String\(scene\.narration_text/);
  });
});
