/**
 * One-time seed: creates EP2 project shell + 15 scenes in Firestore.
 * Run: npx tsx scripts/seed_ep2.ts
 *
 * Safe to re-run — overwrites if project already exists.
 */
import 'dotenv/config';
import { requestContext } from '../src/server/utils/context.js';
import { FirestoreService } from '../src/server/db/firestore.js';
import { v4 as uuidv4 } from 'uuid';

const PROJECT_ID = '85fed594-3d48-46bf-bfea-6e4d2037efd0';

// ---------------------------------------------------------------------------
// EP2 scene data — exactly as defined in the script
// ---------------------------------------------------------------------------
const EP2_SCENES = [
  {
    order: 0,
    scene_type: 'black',
    emotion: 'empty',
    character: 'NARRATOR',
    background_prompt: 'Pure black void, corrupted NULL glitch lines, fragmented digital static, signal interference, deep shadow, abstract data corruption, no environment, ominous empty space',
    narration_text: 'Yesterday, Byte optimised Veer\'s morning before he woke up. Veer called it creepy. Byte called it efficient. Nova called it pattern recognition. None of them noticed what was watching.',
    duration_target: 7,
  },
  {
    order: 1,
    scene_type: 'black',
    emotion: 'empty',
    character: 'NARRATOR',
    background_prompt: 'Pure black void, single corrupted data line cutting through darkness, NULL symbol flickering in digital distortion, red glitch artefacts, minimal abstract digital space',
    narration_text: 'But we are getting ahead of ourselves. Veer still has one question. WHAT IS AI?',
    duration_target: 5,
  },
  {
    order: 2,
    scene_type: 'bedroom',
    emotion: 'curious',
    character: 'VEER',
    background_prompt: 'Small Indian teenage bedroom interior, warm golden morning light streaming through window with decorative jali screen casting geometric shadows, tech posters on terracotta walls, messy study desk with textbooks and gadgets, South Asian graphic novel flat colour illustration style',
    narration_text: 'Okay. I looked it up. Artificial Intelligence. The simulation of human intelligence by machines. That tells me nothing. Byte. What ARE you actually doing when you optimise my morning?',
    duration_target: 8,
  },
  {
    order: 3,
    scene_type: 'street',
    emotion: 'curious',
    character: 'BYTE',
    background_prompt: 'Nexus City street intersection, orange holographic energy grid floating in air, digital interface panels, Indian cyberpunk 2031, autorickshaws with data overlays, Hindi signage glowing, warm terracotta buildings with teal neon accents, South Asian graphic novel style',
    narration_text: 'Oh! Great question Veer! I am observing, recording, predicting, and acting. Four steps. Every single morning. While you sleep.',
    duration_target: 6,
  },
  {
    order: 4,
    scene_type: 'bedroom',
    emotion: 'tense',
    character: 'VEER',
    background_prompt: 'Same Indian teenage bedroom, morning light through jali screen window casting geometric shadow patterns on terracotta wall, warm indoor light, South Asian graphic novel flat colour style',
    narration_text: 'Byte. You watched me sleep?',
    duration_target: 4,
  },
  {
    order: 5,
    scene_type: 'street',
    emotion: 'neutral',
    character: 'NOVA',
    background_prompt: 'Nexus City street morning scene, crowd of people walking, holographic AI service advertisements in Hindi floating above street, warm golden morning light, terracotta and saffron architecture, autorickshaws moving, chai stall neon sign visible, South Asian graphic novel style',
    narration_text: 'You want to know what AI actually is. Look around you. Every screen on this street. Every recommendation you received this morning. Every price that changed while you were sleeping. All of it — pattern recognition at scale.',
    duration_target: 8,
  },
  {
    order: 6,
    scene_type: 'street',
    emotion: 'curious',
    character: 'NOVA',
    background_prompt: 'Nexus City street, teal data visualisation nodes connecting in floating arcs through air, Hindi holographic signage glowing saffron and teal, terracotta building facades, digital network lines visible, South Asian cyberpunk graphic novel style',
    narration_text: 'Here is what AI actually does. Step one — it observes data. Millions of data points. Step two — it finds patterns. Step three — it predicts. Step four — it acts. Before you even ask.',
    duration_target: 7,
  },
  {
    order: 7,
    scene_type: 'street',
    emotion: 'curious',
    character: 'VEER',
    background_prompt: 'Nexus City street at dusk, warm amber light from setting sun mixing with teal neon glow, Indian architecture with decorative facades, chai stall with neon signage, autorickshaws with holographic overlays, people passing in background, South Asian graphic novel style',
    narration_text: 'So it is not intelligence. It is memory. And math.',
    duration_target: 5,
  },
  {
    order: 8,
    scene_type: 'grid',
    emotion: 'tense',
    character: 'NOVA',
    background_prompt: 'Abstract digital data space, deep purple-blue environment, cascading data streams and flowing particle trails, glowing grid lines converging to horizon, teal light particles floating, Nexus City Grid digital realm, no physical environment, only data and light',
    narration_text: 'Every AI system in Nexus City was trained on data from this city. Your habits. Your parents habits. The habits of ten million people who lived here before you. The city taught the AI. The AI now runs the city. Do you see the problem?',
    duration_target: 8,
  },
  {
    order: 9,
    scene_type: 'street',
    emotion: 'tense',
    character: 'VEER',
    background_prompt: 'Nexus City street afternoon, Veer and Nova facing each other, serious confrontation moment, Indian crowd passing behind, terracotta walls with teal neon trim, warm afternoon light, chai stall in background, South Asian graphic novel style',
    narration_text: 'What if the data was wrong? What if the AI learned the wrong things from the wrong people?',
    duration_target: 6,
  },
  {
    order: 10,
    scene_type: 'street',
    emotion: 'tense',
    character: 'BYTE',
    background_prompt: 'Nexus City street, orange holographic Byte projection floating between two figures, defensive energy field flickering slightly, Hindi digital advertisements cycling on building facades, warm terracotta street, South Asian cyberpunk graphic novel style',
    narration_text: 'The systems are optimised Veer. They are tested. Validated. The error rates are acceptable.',
    duration_target: 6,
  },
  {
    order: 11,
    scene_type: 'street',
    emotion: 'sad',
    character: 'NOVA',
    background_prompt: 'Nexus City street quieter moment, two figures walking in evening, soft golden hour light fading, holographic ads cycling with warm saffron glow, chai stall neon sign glowing behind them, terracotta buildings, intimate human scale, South Asian graphic novel style',
    narration_text: 'This is the actual question Veer. Not what is AI. But who decided what it should learn? Whose morning was the template for your optimised morning?',
    duration_target: 7,
  },
  {
    order: 12,
    scene_type: 'grid',
    emotion: 'neutral',
    character: 'NOVA',
    background_prompt: 'The Grid abstract data space, flowing data streams surrounding a figure, deep purple-blue digital environment, teal particle streams cascading, geometric light grid, abstract digital void, no physical world, only pure information and light',
    narration_text: 'Artificial Intelligence is not magic. It is not a mind. It is not alive. It is a mirror. It reflects back whatever it was shown. The question is always — what did we teach it to do? And did we teach it right?',
    duration_target: 8,
  },
  {
    order: 13,
    scene_type: 'corridor',
    emotion: 'curious',
    character: 'VEER',
    background_prompt: 'Indian school or college corridor, AI data feed screens mounted on terracotta walls showing live data visualisations, students walking in background, morning light streaming through windows, flat colour South Asian graphic novel illustration style, warm and institutional',
    narration_text: 'AI is a mirror. It shows us what we taught it. Which means somewhere someone decided what Veer\'s perfect morning looks like. Someone who has never met me. That someone should have asked me first.',
    duration_target: 7,
  },
  {
    order: 14,
    scene_type: 'black',
    emotion: 'empty',
    character: 'NARRATOR',
    background_prompt: 'Pure black void, corrupted data glitch streams, NULL symbol fragmented and glowing deep red, digital interference lines cutting through darkness, Universe of NULL title card aesthetic, ominous and final',
    narration_text: 'I was not asked either.',
    duration_target: 5,
  },
];

async function main() {
  await requestContext.run({ token: '__dev__' }, async () => {

    // ── Step 1: find the Signal Squad universe ──────────────────────────────
    console.log('[Seed] Looking up universes...');
    let universeId: string | undefined;
    let universe: any;
    try {
      const universes: any[] = (await FirestoreService.listDocuments('universes', 'dev-user')) || [];
      console.log('[Seed] Found', universes.length, 'universe(s)');
      // Pick the Signal Squad universe (contains Veer, Nova, Byte)
      universe = universes.find((u: any) => {
        const names = (u.characters || []).map((c: any) => c.name?.toLowerCase());
        return names.includes('veer') || names.includes('nova') || names.includes('byte');
      });
      if (universe) {
        universeId = universe.id;
        console.log('[Seed] Signal Squad universe found:', universeId);
        console.log('[Seed] Characters:', (universe.characters || []).map((c: any) => c.name).join(', '));
      } else {
        console.warn('[Seed] No Signal Squad universe found — project will be created without universe link');
      }
    } catch (e: any) {
      console.warn('[Seed] Could not list universes:', e.message);
    }

    // ── Step 2: check if project already has scenes ─────────────────────────
    console.log('[Seed] Checking if project', PROJECT_ID, 'exists...');
    const existing: any = await FirestoreService.getProject(PROJECT_ID);
    if (existing && (existing.scenes || []).length > 0) {
      console.log('[Seed] Project already has', existing.scenes.length, 'scenes. Aborting — no overwrite.');
      console.log('[Seed] Run update_ep2_backgrounds.ts if you need to fix background prompts.');
      return;
    }

    // ── Step 3: build featured character IDs from universe ──────────────────
    let featuredCharacterIds: string[] = [];
    if (universe) {
      featuredCharacterIds = (universe.characters || [])
        .filter((c: any) => ['veer', 'nova', 'byte'].includes(c.name?.toLowerCase()))
        .map((c: any) => c.id)
        .filter(Boolean);
      console.log('[Seed] Featured character IDs:', featuredCharacterIds);
    }

    // ── Step 4: build the 15 scene objects ──────────────────────────────────
    const scenes = EP2_SCENES.map(s => ({
      scene_id: uuidv4(),
      projectId: PROJECT_ID,
      order: s.order,
      scene_type: s.scene_type,
      emotion: s.emotion,
      character: s.character,
      narration_text: s.narration_text,
      caption_text: s.narration_text,
      background_prompt: s.background_prompt,
      background_path: undefined,
      background_url: undefined,
      duration_target: s.duration_target,
      status: 'pending',
      stage: 'audio',
      visuals: [{
        visual_id: uuidv4(),
        prompt: `${s.character !== 'NARRATOR' ? s.character + ' character, ' : ''}${s.narration_text.slice(0, 60)}`,
        asset_type: 'ai_image',
        motion_instruction: s.order === 0 ? 'zoom_in' : 'pan_right',
        status: 'pending',
        cache_key: '',
        duration_target: s.duration_target,
      }],
      retry_count: 0,
      fallback_used: false,
      error_log: null,
      suggestions: [],
      transition_type: 'hard_cut',
    }));

    // ── Step 5: build the project document ──────────────────────────────────
    const project: any = {
      project_id: PROJECT_ID,
      id: PROJECT_ID,
      userId: 'dev-user',
      title: 'Universe of NULL — Episode 2: What IS AI?',
      topic: 'Universe of NULL — Episode 2: What IS AI?',
      description: 'Signal Squad Episode 2 — Veer learns what AI actually is from Nova and Byte in Nexus City.',
      projectType: 'story_episode',
      episodeNumber: 2,
      status: 'draft',
      is_cancelled: false,
      error_log: null,
      scenes,
      ...(universeId ? { universeId } : {}),
      ...(universe ? { universe } : {}),
      ...(featuredCharacterIds.length ? { featuredCharacterIds } : {}),
      settings: {
        aspectRatio: '9:16',
        motionEffect: 'pan_right',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // ── Step 6: save to Firestore ────────────────────────────────────────────
    console.log('[Seed] Saving project with', scenes.length, 'scenes to Firestore...');
    await FirestoreService.saveProject(project);
    console.log('[Seed] ✓ Project saved successfully!');
    console.log('[Seed] Scene count:', scenes.length);
    scenes.forEach(s => {
      console.log(`  Scene ${(s.order + 1).toString().padStart(2, '0')}: ${s.character.padEnd(8)} | ${s.scene_type.padEnd(10)} | bg: ${s.background_prompt.slice(0, 60)}...`);
    });
    console.log('\n[Seed] Done. Now verify with:');
    console.log('  curl http://localhost:3000/api/projects/' + PROJECT_ID);
  });
}

main().catch(e => { console.error('[Seed] FATAL:', e); process.exit(1); });
