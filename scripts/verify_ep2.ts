/**
 * Read EP2 scenes from Firestore and report their state.
 * Run: npx tsx scripts/verify_ep2.ts
 */
import 'dotenv/config';
import { requestContext } from '../src/server/utils/context.js';
import { FirestoreService } from '../src/server/db/firestore.js';

const PROJECT_ID = '85fed594-3d48-46bf-bfea-6e4d2037efd0';

async function main() {
  await requestContext.run({ token: '__dev__' }, async () => {
    const project: any = await FirestoreService.getProject(PROJECT_ID);
    if (!project) {
      console.error('Project not found in Firestore');
      return;
    }

    const scenes = project.scenes || [];
    console.log(`Project: ${project.title || project.topic}`);
    console.log(`Status: ${project.status}`);
    console.log(`Scene count: ${scenes.length}`);
    console.log(`Universe linked: ${project.universeId || 'NONE'}`);
    console.log('');

    let bgMissing = 0;
    let bgAnime = 0;
    const problems: string[] = [];

    scenes.sort((a: any, b: any) => a.order - b.order).forEach((s: any, i: number) => {
      const bg = s.background_prompt || '';
      const hasAnime = /anime|tokyo|seoul|japan|cherry blossom/i.test(bg);
      const hasIndian = /indian|south asian|nexus|terracotta|hyderabad|hindi|chai|saffron|jali|mughal/i.test(bg);
      const flag = !bg ? '⚠ NO BG PROMPT' : hasAnime ? '⚠ ANIME/JAPAN KEYWORD' : '';

      if (!bg) bgMissing++;
      if (hasAnime) bgAnime++;
      if (flag) problems.push(`Scene ${i + 1} (${s.scene_id?.slice(0, 8)}): ${flag}`);

      console.log(
        `Scene ${String(i + 1).padStart(2, '0')} | ${(s.character || 'NARRATOR').padEnd(8)} | ${(s.scene_type || '?').padEnd(10)} | narration: ${s.narration_text ? 'OK' : 'MISSING'} | bg: ${bg ? (hasAnime ? 'ANIME!!' : (hasIndian ? 'indian-ok' : 'GENERIC')) : 'EMPTY'}`
      );
    });

    console.log('\n── Summary ──');
    console.log(`Scenes with narration_text: ${scenes.filter((s: any) => s.narration_text).length}/${scenes.length}`);
    console.log(`Scenes with background_prompt: ${scenes.filter((s: any) => s.background_prompt).length}/${scenes.length}`);
    console.log(`BG prompts missing: ${bgMissing}`);
    console.log(`BG prompts with anime/Japan keywords: ${bgAnime}`);

    if (problems.length) {
      console.log('\n── Problems ──');
      problems.forEach(p => console.log(' ', p));
    } else {
      console.log('\n✓ No problems found — all scenes ready for render.');
    }

    // Print one full scene as sample
    if (scenes.length > 0) {
      const sample = scenes[2]; // Scene 03
      console.log('\n── Sample scene (Scene 03) ──');
      console.log(JSON.stringify({
        scene_id: sample.scene_id,
        order: sample.order,
        character: sample.character,
        emotion: sample.emotion,
        scene_type: sample.scene_type,
        narration_text: sample.narration_text,
        background_prompt: sample.background_prompt,
        status: sample.status,
        visuals: sample.visuals?.map((v: any) => ({ prompt: v.prompt?.slice(0, 60), status: v.status })),
      }, null, 2));
    }
  });
}

main().catch(e => { console.error(e); process.exit(1); });
