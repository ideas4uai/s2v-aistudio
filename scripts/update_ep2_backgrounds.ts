/**
 * One-time script: update Episode 2 (project 85fed594) background prompts
 * with the Indian aesthetic suffix and clear background_url so backgrounds
 * regenerate on next render.
 *
 * Run: npx tsx scripts/update_ep2_backgrounds.ts
 */
import 'dotenv/config';
import { requestContext } from '../src/server/utils/context.js';
import { FirestoreService } from '../src/server/db/firestore.js';

const PROJECT_ID = '85fed594';

const INDIAN_AESTHETIC_SUFFIX = 'anime flat colour style, Trigger Studio quality, Indian urban architecture, warm terracotta and saffron accents, Hyderabad cyberpunk 2031, South Asian street aesthetics, holographic signs with Hindi text, NOT Japanese anime, warm monsoon city atmosphere, teal and saffron colour palette, chai shop neon, autorickshaws with data overlays';

async function main() {
  await requestContext.run({ token: '__dev__' }, async () => {
    const project: any = await FirestoreService.getProject(PROJECT_ID);
    if (!project) {
      console.error('Project not found:', PROJECT_ID);
      process.exit(1);
    }

    let updated = 0;
    for (const scene of project.scenes || []) {
      if (!scene.background_prompt) continue;

      // Skip if suffix already appended
      if (scene.background_prompt.includes('Indian urban architecture')) {
        console.log(`[Scene ${scene.scene_id?.slice(0, 8)}] Already has suffix — skipping`);
        continue;
      }

      scene.background_prompt = scene.background_prompt + ', ' + INDIAN_AESTHETIC_SUFFIX;
      scene.background_url = undefined;   // force regeneration
      scene.background_path = undefined;
      updated++;
      console.log(`[Scene ${scene.scene_id?.slice(0, 8)}] Updated prompt + cleared URL`);
    }

    if (updated === 0) {
      console.log('No scenes needed updating.');
      return;
    }

    await FirestoreService.saveProject(project);
    console.log(`Done. ${updated} scene(s) updated in project ${PROJECT_ID}.`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
