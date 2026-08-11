/**
 * One-time seed: creates "Universe of NULL — EP2: NULL" with 8 scenes.
 * Run: npx tsx scripts/seed_ep2b.ts
 *
 * All 4 backgrounds are uploaded fresh to EP2's own Supabase project path.
 * Safe to re-run: patches background_url values if they still reference the
 * pilot project, no-ops if the project is already fully correct.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { requestContext } from '../src/server/utils/context.js';
import { FirestoreService } from '../src/server/db/firestore.js';
import { v4 as uuidv4 } from 'uuid';

const UNIVERSE_ID   = 'd858e28f-4b72-45d7-a32c-18cdc8bf9a19';
const PROJECT_ID    = 'a3f7c2d1-8b4e-4e90-9c1a-2d5f3e7b6c8d';  // stable across re-runs
// Kept only for detecting stale pilot-project references in existing scenes:
const PILOT_PRJ_ID  = 'fd49ccfb-212b-4856-be9c-f82bf13bbd81';

const ASSETS_DIR = path.join(process.cwd(), 'assets', 'backgrounds');

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

// ---------------------------------------------------------------------------
// Upload a background file to EP2's own Supabase project path
// ---------------------------------------------------------------------------
async function uploadBg(filename: string): Promise<string> {
  const localPath = path.join(ASSETS_DIR, filename);
  if (!fs.existsSync(localPath)) {
    throw new Error(`Background not found locally: ${localPath}`);
  }
  const kb = Math.round(fs.statSync(localPath).size / 1024);
  console.log(`[Seed] ${filename} (${kb}KB) — uploading under EP2 project...`);
  const buffer = fs.readFileSync(localPath);
  const url = await FirestoreService.uploadAsset(
    PROJECT_ID,
    `backgrounds/${filename}`,
    buffer,
    'image/png',
  );
  console.log(`[Seed]   -> ${url}`);
  return url;
}

// ---------------------------------------------------------------------------
// Upload all backgrounds and return a bg_key → URL map
// ---------------------------------------------------------------------------
async function uploadAllBackgrounds(): Promise<Record<string, string>> {
  console.log('[Seed] Uploading all backgrounds to EP2 project path...');
  const [bg01, bg02, bg04, bg05] = await Promise.all([
    uploadBg('bg01_black_void.png'),
    uploadBg('bg02_bedroom.png'),
    uploadBg('bg04_street_day.png'),
    uploadBg('bg05_holographic_ui.png'),
  ]);
  return { bg01, bg02, bg04, bg05 };
}

async function main() {
  await requestContext.run({ token: '__dev__' }, async () => {

    // ── Step 1: verify Supabase URL is configured ───────────────────────────
    const supabaseBase = process.env.SUPABASE_URL || '';
    if (!supabaseBase) {
      console.error('[Seed] SUPABASE_URL is not set — cannot upload backgrounds.');
      process.exit(1);
    }
    console.log('[Seed] Supabase:', supabaseBase);

    // ── Step 2: check for existing project ──────────────────────────────────
    console.log('[Seed] Checking for existing project', PROJECT_ID, '...');
    const existing: any = await FirestoreService.getProject(PROJECT_ID);

    if (existing && (existing.scenes || []).length > 0) {
      const staleScenes = (existing.scenes as any[]).filter(s =>
        (s.background_url || '').includes(PILOT_PRJ_ID));

      if (staleScenes.length === 0) {
        console.log('[Seed] Project already seeded with correct EP2 URLs — nothing to do.');
        console.log('[Seed] Project ID:', PROJECT_ID);
        return;
      }

      // ── Patch path: update stale background_url values ───────────────────
      console.log(`[Seed] Found ${staleScenes.length} scenes with pilot-project URLs — patching...`);
      const allUrls = await uploadAllBackgrounds();
      console.log('[Seed] Background URLs:');
      for (const [k, v] of Object.entries(allUrls)) {
        console.log(`  ${k}: ${v}`);
      }

      const patchedScenes = (existing.scenes as any[]).map((s: any) => {
        const sceneData = EP2B_SCENES[s.order];
        if (!sceneData) return s;
        return { ...s, background_url: allUrls[sceneData.bg_key] };
      });

      await FirestoreService.saveProject({ ...existing, scenes: patchedScenes });
      console.log('[Seed] Patch complete — all scenes now reference EP2 project path.');
      patchedScenes.forEach((s: any) => {
        const bg = EP2B_SCENES[s.order]?.bg_key ?? '?';
        console.log(
          `  Scene ${(s.order + 1).toString().padStart(2, '0')}: ${bg} -> ${s.background_url?.slice(-40)}`
        );
      });
      console.log('[Seed] Project ID:', PROJECT_ID);
      return;
    }

    // ── Step 3: fresh seed ───────────────────────────────────────────────────
    const allUrls = await uploadAllBackgrounds();
    console.log('[Seed] Background URLs:');
    for (const [k, v] of Object.entries(allUrls)) {
      console.log(`  ${k}: ${v}`);
    }

    // ── Step 4: load universe ────────────────────────────────────────────────
    console.log('\n[Seed] Loading universe', UNIVERSE_ID, '...');
    let universe: any;
    try {
      const universes: any[] = (await FirestoreService.listDocuments('universes', 'dev-user')) || [];
      universe = universes.find((u: any) => u.id === UNIVERSE_ID);
      if (universe) {
        console.log('[Seed] Universe found:', universe.name || UNIVERSE_ID);
        console.log('[Seed] Characters:', (universe.characters || []).map((c: any) => c.name).join(', '));
      } else {
        console.warn('[Seed] Universe not found — project saved without universe data');
      }
    } catch (e: any) {
      console.warn('[Seed] Could not list universes:', e.message);
    }

    // ── Step 5: featured character IDs from universe ─────────────────────────
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

    // ── Step 6: build 8 scene objects ────────────────────────────────────────
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
      background_url: allUrls[s.bg_key],
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

    // ── Step 7: build project document ───────────────────────────────────────
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

    // ── Step 8: save to store ─────────────────────────────────────────────────
    console.log('\n[Seed] Saving project with', scenes.length, 'scenes...');
    await FirestoreService.saveProject(project);
    console.log('[Seed] Project saved successfully!');
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
    console.log('[Seed] Project ID:', PROJECT_ID);
    console.log('[Seed] Verify with:');
    console.log('  curl http://localhost:3000/api/projects/' + PROJECT_ID);
  });
}

main().catch(e => { console.error('[Seed] FATAL:', e); process.exit(1); });
