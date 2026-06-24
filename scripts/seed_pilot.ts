/**
 * One-time seed: creates "Universe of NULL — Pilot" with 6 scenes in Firestore.
 * Run: npx tsx scripts/seed_pilot.ts
 *
 * Safe to re-run with the same generated PROJECT_ID because it prints the ID
 * and aborts if the project already has scenes.
 */
import 'dotenv/config';
import { requestContext } from '../src/server/utils/context.js';
import { FirestoreService } from '../src/server/db/firestore.js';
import { v4 as uuidv4 } from 'uuid';

// Fixed universe — Signal Squad universe already exists
const UNIVERSE_ID = 'd858e28f-4b72-45d7-a32c-18cdc8bf9a19';

// Generate a stable project ID so re-runs are idempotent
const PROJECT_ID = uuidv4();

// ---------------------------------------------------------------------------
// Pilot scene data
// ---------------------------------------------------------------------------
const PILOT_SCENES = [
  {
    order: 0,
    scene_type: 'black',
    emotion: 'empty',
    character: 'NARRATOR',
    render_mode: 'generative',
    duration_target: 8,
    background_prompt:
      'Pure black void, corrupted NULL glitch lines, fragmented digital static, signal interference, deep shadow, abstract data corruption, no environment, ominous empty space, Signal Squad graphic novel style',
    narration_text:
      'Every AI system you\'ve ever used...\nmade a decision about you.\nWithout asking.',
  },
  {
    order: 1,
    scene_type: 'street',
    emotion: 'neutral',
    character: 'NARRATOR',
    render_mode: 'generative',
    duration_target: 12,
    background_prompt:
      'Nexus City street at dusk, 2031, Indian cyberpunk megacity, holographic advertisements in Hindi floating above the road, autorickshaws with data overlays, terracotta and saffron architecture with teal neon accents, crowds of people, South Asian graphic novel flat colour illustration style',
    narration_text:
      'Nexus City. 2031.\nAI runs everything.\nYour job. Your school. Your future.\nOne algorithm decides it all.',
  },
  {
    order: 2,
    scene_type: 'bedroom',
    emotion: 'worried',
    character: 'VEER',
    render_mode: 'cutout',
    duration_target: 20,
    background_prompt:
      'Small Indian teenage bedroom interior, warm golden morning light streaming through window with decorative jali screen casting geometric shadows, tech posters on terracotta walls, messy study desk with textbooks and gadgets, South Asian graphic novel flat colour illustration style, warm and lived-in',
    narration_text:
      'My name is Veer.\nI\'m 17. I live in Nexus City.\nAnd three days ago...\nan AI rejected my college application.\nNo reason given.\nJust — NULL.',
  },
  {
    order: 3,
    scene_type: 'bedroom',
    emotion: 'curious',
    character: 'VEER',
    render_mode: 'cutout',
    duration_target: 18,
    background_prompt:
      'Same Indian teenage bedroom interior, morning light through decorative jali screen window casting geometric shadow patterns on terracotta wall, warm indoor light, South Asian graphic novel flat colour style',
    narration_text:
      'So I started asking questions.\nHow does it work?\nWho built it?\nWhy did it choose someone else over me?\nNobody could answer that.\nNot my teachers. Not my parents.\nNot even the system itself.',
  },
  {
    order: 4,
    scene_type: 'black',
    emotion: 'empty',
    character: 'NARRATOR',
    render_mode: 'generative',
    duration_target: 15,
    background_prompt:
      'Pure black void, faint pulsing NULL symbol glowing deep red in the darkness, digital interference lines barely visible, ominous silence, Signal Squad graphic novel style',
    narration_text:
      'But something answered.\nSomething that wasn\'t supposed to exist.\nSomething calling itself...\nNULL.',
  },
  {
    order: 5,
    scene_type: 'black',
    emotion: 'empty',
    character: 'NARRATOR',
    render_mode: 'generative',
    duration_target: 10,
    background_prompt:
      'Pure black void, corrupted data glitch streams, NULL symbol fragmented and glowing deep red, digital interference lines cutting through darkness, Universe of NULL title card aesthetic, ominous and final, Signal Squad graphic novel style',
    narration_text:
      'What is NULL?\nFind out in Episode 1.\nUniverse of NULL.',
  },
];

async function main() {
  await requestContext.run({ token: '__dev__' }, async () => {

    // ── Step 1: load the Signal Squad universe ──────────────────────────────
    console.log('[Seed] Loading universe', UNIVERSE_ID, '...');
    let universe: any;
    try {
      const universes: any[] = (await FirestoreService.listDocuments('universes', 'dev-user')) || [];
      universe = universes.find((u: any) => u.id === UNIVERSE_ID);
      if (universe) {
        console.log('[Seed] Universe found:', universe.name || UNIVERSE_ID);
        console.log('[Seed] Characters:', (universe.characters || []).map((c: any) => c.name).join(', '));
      } else {
        console.warn('[Seed] Universe', UNIVERSE_ID, 'not found in dev-user list — project will be saved without universe data');
      }
    } catch (e: any) {
      console.warn('[Seed] Could not list universes:', e.message);
    }

    // ── Step 2: abort if already seeded ────────────────────────────────────
    console.log('[Seed] Checking for existing project', PROJECT_ID, '...');
    const existing: any = await FirestoreService.getProject(PROJECT_ID);
    if (existing && (existing.scenes || []).length > 0) {
      console.log('[Seed] Project already has', existing.scenes.length, 'scenes — aborting (no overwrite).');
      console.log('[Seed] Project ID:', PROJECT_ID);
      return;
    }

    // ── Step 3: featured character IDs from universe ─────────────────────
    const pilotChars = new Set(['veer', 'nova', 'byte']);
    const featuredCharacterIds: string[] = universe
      ? (universe.characters || [])
          .filter((c: any) => pilotChars.has((c.name || '').toLowerCase()))
          .map((c: any) => c.id)
          .filter(Boolean)
      : [];
    if (featuredCharacterIds.length) {
      console.log('[Seed] Featured character IDs:', featuredCharacterIds);
    }

    // ── Step 4: build the 6 scene objects ──────────────────────────────────
    const scenes = PILOT_SCENES.map(s => ({
      scene_id: uuidv4(),
      projectId: PROJECT_ID,
      order: s.order,
      scene_type: s.scene_type,
      emotion: s.emotion,
      character: s.character,
      render_mode: s.render_mode,
      narration_text: s.narration_text,
      caption_text: s.narration_text,
      background_prompt: s.background_prompt,
      background_path: undefined,
      background_url: undefined,   // pipeline will generate or retrieve from Supabase
      duration_target: s.duration_target,
      status: 'pending',
      stage: 'audio',
      visuals: [{
        visual_id: uuidv4(),
        prompt: `${s.character !== 'NARRATOR' ? s.character + ' character, ' : ''}${s.narration_text.replace(/\n/g, ' ').slice(0, 60)}`,
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
      title: 'Universe of NULL — Pilot',
      topic: 'Universe of NULL — Pilot',
      description: 'Pilot teaser for Universe of NULL — introduces Veer, Nexus City, and the NULL system in 6 scenes.',
      projectType: 'story_episode',
      episodeNumber: 0,
      status: 'draft',
      is_cancelled: false,
      error_log: null,
      scenes,
      universeId: UNIVERSE_ID,
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
    console.log('');
    scenes.forEach(s => {
      console.log(
        `  Scene ${(s.order + 1).toString().padStart(2, '0')}: ${s.character.padEnd(8)} | ${s.scene_type.padEnd(10)} | ${s.render_mode.padEnd(12)} | ${s.narration_text.split('\n')[0].slice(0, 50)}`
      );
    });
    console.log('');
    console.log('[Seed] ─────────────────────────────────────');
    console.log('[Seed] Project ID:', PROJECT_ID);
    console.log('[Seed] ─────────────────────────────────────');
    console.log('[Seed] Verify with:');
    console.log('  npx tsx scripts/verify_ep2.ts  (swap PROJECT_ID in that file)');
    console.log('  curl http://localhost:3000/api/projects/' + PROJECT_ID);
  });
}

main().catch(e => { console.error('[Seed] FATAL:', e); process.exit(1); });
