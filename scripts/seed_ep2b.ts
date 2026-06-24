/**
 * One-time seed: creates "Universe of NULL — EP2: NULL" with 8 scenes.
 * Run: DISABLE_FIRESTORE=true npx tsx scripts/seed_ep2b.ts
 *
 * bg01/bg02/bg04 are already uploaded to Supabase from the pilot project.
 * bg05 is uploaded here on first run (upsert=true, safe to re-run).
 * Project saves to the in-memory store (DISABLE_FIRESTORE=true).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { requestContext } from '../src/server/utils/context.js';
import { FirestoreService } from '../src/server/db/firestore.js';
import { v4 as uuidv4 } from 'uuid';

const UNIVERSE_ID  = 'd858e28f-4b72-45d7-a32c-18cdc8bf9a19';
const PROJECT_ID   = 'a3f7c2d1-8b4e-4e90-9c1a-2d5f3e7b6c8d';  // stable across re-runs
const PILOT_PRJ_ID = 'fd49ccfb-212b-4856-be9c-f82bf13bbd81';   // pilot uploads live here
const SUPABASE_BASE = process.env.SUPABASE_URL || '';
const BUCKET       = 'aivideogen';

function pilotBgUrl(file: string): string {
  return `${SUPABASE_BASE}/storage/v1/object/public/${BUCKET}/projects/${PILOT_PRJ_ID}/backgrounds/pilot/${file}`;
}

// Pre-uploaded from pilot run — safe to hardcode
const BG_URLS = {
  bg01: pilotBgUrl('bg01_black_void.png'),
  bg02: pilotBgUrl('bg02_bedroom.png'),
  bg04: pilotBgUrl('bg04_street_day.png'),
} as const;

const ASSETS_DIR = path.join(process.cwd(), 'assets', 'backgrounds');
const BG05_FILE  = path.join(ASSETS_DIR, 'bg05_holographic_ui.png');

// ---------------------------------------------------------------------------
// EP2b scene data
// ---------------------------------------------------------------------------
const EP2B_SCENES = [
  {
    order: 0,
    scene_type: 'black',
    emotion: 'empty',
    character: 'NARRATOR',
    render_mode: 'generative',
    duration_target: 8,
    bg_key: 'bg01' as const,
    narration_text: 'Every year, NexusAI processes\nforty million applications. Forty million futures.\nDecided in seconds.',
  },
  {
    order: 1,
    scene_type: 'street',
    emotion: 'neutral',
    character: 'NARRATOR',
    render_mode: 'generative',
    duration_target: 10,
    bg_key: 'bg04' as const,
    narration_text: 'Nexus City, 2031. The algorithm\nnever sleeps. It never doubts. It never explains.',
  },
  {
    order: 2,
    scene_type: 'bedroom',
    emotion: 'worried',
    character: 'VEER',
    render_mode: 'cutout',
    duration_target: 15,
    bg_key: 'bg02' as const,
    narration_text: 'I spent eight months on that\napplication. Eight months of grades, projects,\nrecommendations. Everything they asked for.\nToday was the day.',
  },
  {
    order: 3,
    scene_type: 'interface',
    emotion: 'tense',
    character: 'VEER',
    render_mode: 'cutout',
    duration_target: 12,
    bg_key: 'bg05' as const,
    narration_text: 'The interface said: processing.\nProgress bar at ninety percent. Then eighty.\nThen sixty. Something was wrong.',
  },
  {
    order: 4,
    scene_type: 'interface',
    emotion: 'empty',
    character: 'NARRATOR',
    render_mode: 'generative',
    duration_target: 10,
    bg_key: 'bg05' as const,
    narration_text: 'Four hundred milliseconds.\nThat\'s how long NexusAI took to decide\nVeer\'s future.',
  },
  {
    order: 5,
    scene_type: 'bedroom',
    emotion: 'sad',
    character: 'VEER',
    render_mode: 'cutout',
    duration_target: 15,
    bg_key: 'bg02' as const,
    narration_text: 'One word on the screen. NULL.\nNot rejected. Not insufficient.\nJust NULL. Like I never existed.',
  },
  {
    order: 6,
    scene_type: 'bedroom',
    emotion: 'tense',
    character: 'VEER',
    render_mode: 'cutout',
    duration_target: 12,
    bg_key: 'bg02' as const,
    narration_text: 'No reason. No appeal.\nNo human being to talk to. Just an algorithm\nthat decided my life wasn\'t worth explaining.',
  },
  {
    order: 7,
    scene_type: 'black',
    emotion: 'empty',
    character: 'NARRATOR',
    render_mode: 'generative',
    duration_target: 8,
    bg_key: 'bg01' as const,
    narration_text: 'But NULL made a mistake.\nIt left a trace. Universe of NULL.\nEpisode 1 dropping soon.',
  },
];

async function uploadBg05(): Promise<string> {
  if (!fs.existsSync(BG05_FILE)) {
    throw new Error(`bg05 not found locally: ${BG05_FILE}`);
  }
  const kb = Math.round(fs.statSync(BG05_FILE).size / 1024);
  console.log(`[Seed] bg05_holographic_ui.png (${kb}KB) — uploading to Supabase...`);
  const buffer = fs.readFileSync(BG05_FILE);
  const url = await FirestoreService.uploadAsset(
    PILOT_PRJ_ID,
    'backgrounds/pilot/bg05_holographic_ui.png',
    buffer,
    'image/png',
  );
  console.log(`[Seed] bg05 -> ${url}`);
  return url;
}

async function main() {
  await requestContext.run({ token: '__dev__' }, async () => {

    // ── Step 1: verify Supabase URL is configured ───────────────────────────
    if (!SUPABASE_BASE) {
      console.error('[Seed] SUPABASE_URL is not set — cannot build background URLs or upload bg05.');
      process.exit(1);
    }
    console.log('[Seed] Supabase:', SUPABASE_BASE);

    // ── Step 2: upload bg05 to Supabase (upsert — idempotent) ───────────────
    let bg05Url: string;
    try {
      bg05Url = await uploadBg05();
    } catch (e: any) {
      console.error('[Seed] FATAL: bg05 upload failed —', e.message);
      process.exit(1);
    }

    const ALL_URLS = { ...BG_URLS, bg05: bg05Url };
    console.log('[Seed] Background URLs:');
    for (const [k, v] of Object.entries(ALL_URLS)) {
      console.log(`  ${k}: ${v}`);
    }

    // ── Step 3: load universe ───────────────────────────────────────────────
    console.log('\n[Seed] Loading universe', UNIVERSE_ID, '...');
    let universe: any;
    try {
      const universes: any[] = (await FirestoreService.listDocuments('universes', 'dev-user')) || [];
      universe = universes.find((u: any) => u.id === UNIVERSE_ID);
      if (universe) {
        console.log('[Seed] Universe found:', universe.name || UNIVERSE_ID);
        console.log('[Seed] Characters:', (universe.characters || []).map((c: any) => c.name).join(', '));
      } else {
        console.warn('[Seed] Universe not found in dev-user list — project saved without universe data');
      }
    } catch (e: any) {
      console.warn('[Seed] Could not list universes:', e.message);
    }

    // ── Step 4: abort if already seeded ────────────────────────────────────
    console.log('[Seed] Checking for existing project', PROJECT_ID, '...');
    const existing: any = await FirestoreService.getProject(PROJECT_ID);
    if (existing && (existing.scenes || []).length > 0) {
      console.log('[Seed] Project already has', existing.scenes.length, 'scenes — aborting (no overwrite).');
      console.log('[Seed] Project ID:', PROJECT_ID);
      return;
    }

    // ── Step 5: featured character IDs from universe ─────────────────────
    const ep2Chars = new Set(['veer', 'nova', 'byte']);
    const featuredCharacterIds: string[] = universe
      ? (universe.characters || [])
          .filter((c: any) => ep2Chars.has((c.name || '').toLowerCase()))
          .map((c: any) => c.id)
          .filter(Boolean)
      : [];
    if (featuredCharacterIds.length) {
      console.log('[Seed] Featured character IDs:', featuredCharacterIds);
    }

    // ── Step 6: build 8 scene objects ───────────────────────────────────────
    const scenes = EP2B_SCENES.map(s => ({
      scene_id: uuidv4(),
      projectId: PROJECT_ID,
      order: s.order,
      scene_type: s.scene_type,
      emotion: s.emotion,
      character: s.character,
      render_mode: s.render_mode,
      narration_text: s.narration_text,
      caption_text: s.narration_text,
      background_prompt: undefined,
      background_path: undefined,
      background_url: ALL_URLS[s.bg_key],
      background_generated: true,   // skip Imagen 4 — backgrounds are pre-supplied
      duration_target: s.duration_target,
      status: 'pending',
      stage: 'audio',               // background done; start pipeline at audio
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

    // ── Step 7: build project document ──────────────────────────────────────
    const project: any = {
      project_id: PROJECT_ID,
      id: PROJECT_ID,
      userId: 'dev-user',
      title: 'Universe of NULL — EP2: NULL',
      topic: 'Universe of NULL — EP2: NULL',
      description: 'Episode 2 of Universe of NULL — The Rejection. Veer\'s college application is denied by NexusAI with no explanation. 8 scenes, ~90 seconds.',
      projectType: 'story_episode',
      episodeNumber: 2,
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

    // ── Step 8: save to store ────────────────────────────────────────────────
    console.log('\n[Seed] Saving project with', scenes.length, 'scenes...');
    await FirestoreService.saveProject(project);
    console.log('[Seed] ✓ Project saved successfully!');
    console.log('');
    scenes.forEach(s => {
      const bg = EP2B_SCENES[s.order].bg_key;
      console.log(
        `  Scene ${(s.order + 1).toString().padStart(2, '0')}: ${s.character.padEnd(8)} | ` +
        `${s.scene_type.padEnd(10)} | ${s.render_mode.padEnd(12)} | ${bg.padEnd(4)} | ` +
        `${s.narration_text.split('\n')[0].slice(0, 45)}`
      );
    });
    const totalDuration = scenes.reduce((sum, s) => sum + s.duration_target, 0);
    console.log('');
    console.log(`  Total duration: ${totalDuration}s (~${Math.round(totalDuration / 60)} min)`);
    console.log('');
    console.log('[Seed] ─────────────────────────────────────────────────────');
    console.log('[Seed] Project ID:', PROJECT_ID);
    console.log('[Seed] ─────────────────────────────────────────────────────');
    console.log('[Seed] Verify with:');
    console.log('  curl http://localhost:3000/api/projects/' + PROJECT_ID);
  });
}

main().catch(e => { console.error('[Seed] FATAL:', e); process.exit(1); });
