/**
 * Fix EP2 scenes:
 *  1. Replace "anime" background_prompts with clean Indian-aesthetic versions
 *  2. Add scene_type and emotion if missing
 *  3. Reset all scene/visual statuses to 'pending' for full re-render
 *  4. Clean triple-trigger-word visual prompts
 *  5. Reset project status to 'draft'
 *
 * Run: npx tsx scripts/fix_ep2_scenes.ts
 */
import 'dotenv/config';
import { requestContext } from '../src/server/utils/context.js';
import { FirestoreService } from '../src/server/db/firestore.js';

const PROJECT_ID = '85fed594-3d48-46bf-bfea-6e4d2037efd0';

// Correct background prompts — NO "anime" keyword, purely Indian-aesthetic
const SCENE_FIXES: Record<number, { background_prompt: string; scene_type: string; emotion: string; character: string }> = {
  0: {
    character: 'NARRATOR',
    scene_type: 'black',
    emotion: 'empty',
    background_prompt: 'Pure black void, corrupted NULL glitch lines, fragmented digital static, signal interference, deep shadow, abstract data corruption, no environment, ominous empty space, Signal Squad graphic novel style',
  },
  1: {
    character: 'NARRATOR',
    scene_type: 'black',
    emotion: 'empty',
    background_prompt: 'Pure black void, single corrupted data line cutting through darkness, NULL symbol flickering in digital distortion, red glitch artefacts, minimal abstract digital space',
  },
  2: {
    character: 'VEER',
    scene_type: 'bedroom',
    emotion: 'curious',
    background_prompt: 'Small Indian teenage bedroom interior, warm golden morning light streaming through window with decorative jali screen casting geometric shadows, tech posters on terracotta walls, messy study desk with textbooks and gadgets, South Asian graphic novel flat colour illustration style, warm and lived-in',
  },
  3: {
    character: 'BYTE',
    scene_type: 'street',
    emotion: 'curious',
    background_prompt: 'Nexus City street intersection, orange holographic energy grid floating in air, digital interface panels, Indian cyberpunk 2031, autorickshaws with data overlays, Hindi signage glowing, warm terracotta buildings with teal neon accents, South Asian graphic novel illustration style',
  },
  4: {
    character: 'VEER',
    scene_type: 'bedroom',
    emotion: 'tense',
    background_prompt: 'Same Indian teenage bedroom interior, morning light through decorative jali screen window casting geometric shadow patterns on terracotta wall, warm indoor light, South Asian graphic novel flat colour style',
  },
  5: {
    character: 'NOVA',
    scene_type: 'street',
    emotion: 'neutral',
    background_prompt: 'Nexus City street morning scene, crowd of people walking, holographic AI service advertisements in Hindi floating above street, warm golden morning light, terracotta and saffron architecture, autorickshaws moving, chai stall neon sign visible, South Asian graphic novel illustration style',
  },
  6: {
    character: 'NOVA',
    scene_type: 'street',
    emotion: 'curious',
    background_prompt: 'Nexus City street, teal data visualisation nodes connecting in floating arcs through air, Hindi holographic signage glowing saffron and teal, terracotta building facades, digital network lines visible in mid-air, South Asian cyberpunk graphic novel illustration style',
  },
  7: {
    character: 'VEER',
    scene_type: 'street',
    emotion: 'curious',
    background_prompt: 'Nexus City street at dusk, warm amber light from setting sun mixing with teal neon glow, Indian architecture with decorative facades, chai stall with neon signage, autorickshaws with holographic overlays, people passing in background, South Asian graphic novel illustration style',
  },
  8: {
    character: 'NOVA',
    scene_type: 'grid',
    emotion: 'tense',
    background_prompt: 'Abstract digital data space, deep purple-blue environment, cascading data streams and flowing particle trails, glowing grid lines converging to horizon, teal light particles floating, Nexus City Grid digital realm, no physical environment, only data and light, South Asian sci-fi illustration style',
  },
  9: {
    character: 'VEER',
    scene_type: 'street',
    emotion: 'tense',
    background_prompt: 'Nexus City street afternoon, two figures in confrontation, Indian crowd passing behind, terracotta walls with teal neon trim, warm afternoon golden light, chai stall in background, South Asian graphic novel illustration style',
  },
  10: {
    character: 'BYTE',
    scene_type: 'street',
    emotion: 'tense',
    background_prompt: 'Nexus City street, orange holographic projection floating between two figures, defensive energy field, Hindi digital advertisements cycling on building facades, warm terracotta street, South Asian cyberpunk graphic novel illustration style',
  },
  11: {
    character: 'NOVA',
    scene_type: 'street',
    emotion: 'sad',
    background_prompt: 'Nexus City street quieter evening moment, soft golden hour light fading, holographic ads cycling with warm saffron glow, chai stall neon sign glowing, terracotta buildings, intimate human scale street scene, South Asian graphic novel illustration style',
  },
  12: {
    character: 'NOVA',
    scene_type: 'grid',
    emotion: 'neutral',
    background_prompt: 'The Grid abstract data space, flowing data streams surrounding a figure, deep purple-blue digital environment, teal particle streams cascading, geometric light grid, abstract digital void, no physical world, only pure information and light, South Asian sci-fi illustration style',
  },
  13: {
    character: 'VEER',
    scene_type: 'corridor',
    emotion: 'curious',
    background_prompt: 'Indian school corridor, AI data feed screens mounted on terracotta walls showing live data visualisations, students walking in background, morning light streaming through tall windows, warm institutional space, South Asian graphic novel flat colour illustration style',
  },
  14: {
    character: 'NARRATOR',
    scene_type: 'black',
    emotion: 'empty',
    background_prompt: 'Pure black void, corrupted data glitch streams, NULL symbol fragmented and glowing deep red, digital interference lines cutting through darkness, Universe of NULL title card aesthetic, ominous and final, Signal Squad graphic novel style',
  },
};

async function main() {
  await requestContext.run({ token: '__dev__' }, async () => {
    const project: any = await FirestoreService.getProject(PROJECT_ID);
    if (!project) {
      console.error('[Fix] Project not found in Firestore');
      process.exit(1);
    }

    const scenes: any[] = project.scenes || [];
    if (scenes.length === 0) {
      console.error('[Fix] Project has no scenes');
      process.exit(1);
    }

    console.log(`[Fix] Found ${scenes.length} scenes in project: ${project.title || project.topic}`);
    console.log(`[Fix] Current project status: ${project.status}`);

    let fixed = 0;
    scenes.sort((a: any, b: any) => a.order - b.order).forEach((scene: any) => {
      const fix = SCENE_FIXES[scene.order];
      if (!fix) {
        console.warn(`[Fix] No fix data for scene order ${scene.order} — skipping`);
        return;
      }

      // Fix background_prompt
      scene.background_prompt = fix.background_prompt;

      // Add scene_type and emotion
      scene.scene_type = fix.scene_type;
      scene.emotion = fix.emotion;
      scene.character = fix.character;

      // Reset scene status to pending
      const wasStatus = scene.status;
      scene.status = 'pending';
      scene.stage = 'audio';
      scene.error_log = null;

      // Clear all rendered/processed paths
      scene.narration_path = undefined;
      scene.image_path = undefined;
      scene.rendered_path = undefined;
      scene.segment_path = undefined;
      scene.captioned_path = undefined;
      scene.background_path = undefined;
      scene.background_url = undefined;

      // Reset visuals — clean prompt (orchestrator will set trigger word)
      if (scene.visuals && scene.visuals.length > 0) {
        scene.visuals.forEach((v: any) => {
          // Clean triple-trigger-word issue
          const triggerPattern = /^(VEER_CHARACTER\s+){2,}/;
          if (triggerPattern.test(v.prompt || '')) {
            v.prompt = (v.prompt || '').replace(/^(VEER_CHARACTER\s+)+/, '').trim();
          }
          // Strip any duplicate trigger words
          const cleaned = (v.prompt || '').replace(/(VEER_CHARACTER\s*){2,}/g, 'VEER_CHARACTER ').trim();
          v.prompt = cleaned;
          v.status = 'pending';
          v.cache_key = '';
          v.asset_path = undefined;
          v.rendered_path = undefined;
        });
      }

      console.log(`  Scene ${String(scene.order + 1).padStart(2, '0')} (${scene.scene_id?.slice(0, 8)}) [${wasStatus} → pending]: ${fix.character} | ${fix.scene_type} | bg: ${fix.background_prompt.slice(0, 70)}...`);
      fixed++;
    });

    // Reset project status
    project.status = 'draft';
    project.is_cancelled = false;
    project.error_log = null;
    project.output_path = undefined;
    project.logs = [];

    console.log(`\n[Fix] Saving ${fixed} fixed scenes to Firestore...`);
    await FirestoreService.saveProject(project);
    console.log('[Fix] ✓ Done. Project reset to draft with all scenes pending.');
    console.log('[Fix] Now run the render pipeline on project:', PROJECT_ID);
  });
}

main().catch(e => { console.error('[Fix] FATAL:', e); process.exit(1); });
