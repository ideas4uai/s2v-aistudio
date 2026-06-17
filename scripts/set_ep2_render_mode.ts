/**
 * Set EP2 scene render_mode in Firestore.
 *
 *   NARRATOR / NULL scenes  -> render_mode: 'generative'
 *   VEER / NOVA / BYTE       -> render_mode: 'cutout'
 *
 * Cutout scenes whose parts folder doesn't exist yet (Nova, Byte) still get
 * 'cutout' here — renderService and doraemon_engine fall back to generative
 * automatically when assets/characters/<name> is missing.
 *
 * Run: npx tsx scripts/set_ep2_render_mode.ts
 */
import 'dotenv/config';
import { requestContext } from '../src/server/utils/context.js';
import { FirestoreService } from '../src/server/db/firestore.js';

const PROJECT_ID = '85fed594-3d48-46bf-bfea-6e4d2037efd0';

// Characters that get a cutout (limited-animation) render. Everything else
// (NARRATOR, NULL) stays generative.
const CUTOUT_CHARACTERS = new Set(['VEER', 'NOVA', 'BYTE']);

function renderModeFor(character: string | undefined): 'generative' | 'cutout' {
  const c = (character || 'NARRATOR').toUpperCase();
  return CUTOUT_CHARACTERS.has(c) ? 'cutout' : 'generative';
}

async function main() {
  await requestContext.run({ token: '__dev__' }, async () => {
    const project: any = await FirestoreService.getProject(PROJECT_ID);
    if (!project) {
      console.error('[RenderMode] Project not found in Firestore');
      process.exit(1);
    }

    const scenes: any[] = project.scenes || [];
    if (scenes.length === 0) {
      console.error('[RenderMode] Project has no scenes');
      process.exit(1);
    }

    console.log(`[RenderMode] Found ${scenes.length} scenes in: ${project.title || project.topic}`);

    let cutout = 0;
    let generative = 0;
    scenes.sort((a: any, b: any) => a.order - b.order).forEach((scene: any) => {
      const mode = renderModeFor(scene.character);
      scene.render_mode = mode;
      if (mode === 'cutout') cutout++; else generative++;
      console.log(
        `  Scene ${String(scene.order + 1).padStart(2, '0')} (${scene.scene_id?.slice(0, 8)}) | ` +
        `${(scene.character || 'NARRATOR').padEnd(8)} -> ${mode}`
      );
    });

    console.log(`\n[RenderMode] Saving — ${cutout} cutout, ${generative} generative...`);
    await FirestoreService.saveProject(project);
    console.log('[RenderMode] Done.');
  });
}

main().catch(e => { console.error('[RenderMode] FATAL:', e); process.exit(1); });
