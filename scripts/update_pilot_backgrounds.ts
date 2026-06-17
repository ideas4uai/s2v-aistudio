/**
 * Upload pilot background PNGs to Supabase, then write their public URLs
 * into the Firestore pilot project scenes.
 *
 * Run: npx tsx scripts/update_pilot_backgrounds.ts
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { requestContext } from '../src/server/utils/context.js';
import { FirestoreService } from '../src/server/db/firestore.js';

const PROJECT_ID = 'fd49ccfb-212b-4856-be9c-f82bf13bbd81';

// Local background files
const ASSETS_DIR = path.join(process.cwd(), 'assets', 'backgrounds');
const BG_FILES = {
  bg01: path.join(ASSETS_DIR, 'bg01_black_void.png'),
  bg02: path.join(ASSETS_DIR, 'bg02_bedroom.png'),
  bg04: path.join(ASSETS_DIR, 'bg04_street_day.png'),
} as const;

// Scene order -> which background key to assign
const SCENE_BG_MAP: Record<number, keyof typeof BG_FILES> = {
  0: 'bg01',  // Scene 01 — NARRATOR black
  1: 'bg04',  // Scene 02 — NARRATOR street
  2: 'bg02',  // Scene 03 — VEER bedroom
  3: 'bg02',  // Scene 04 — VEER bedroom
  4: 'bg01',  // Scene 05 — NARRATOR black
  5: 'bg01',  // Scene 06 — NARRATOR black
};

async function main() {
  await requestContext.run({ token: '__dev__' }, async () => {

    // ── Step 1: verify files exist ──────────────────────────────────────────
    console.log('[BgUpload] Checking local files...');
    for (const [key, filePath] of Object.entries(BG_FILES)) {
      if (!fs.existsSync(filePath)) {
        console.error(`[BgUpload] MISSING: ${filePath}`);
        process.exit(1);
      }
      const kb = Math.round(fs.statSync(filePath).size / 1024);
      console.log(`  ${key}: ${path.basename(filePath)} (${kb}KB) ✓`);
    }

    // ── Step 2: upload each PNG to Supabase ─────────────────────────────────
    console.log('\n[BgUpload] Uploading to Supabase...');
    const urls: Record<keyof typeof BG_FILES, string> = {} as any;

    for (const [key, filePath] of Object.entries(BG_FILES) as [keyof typeof BG_FILES, string][]) {
      const buffer = fs.readFileSync(filePath);
      const uploadName = `backgrounds/pilot/${path.basename(filePath)}`;
      const url = await FirestoreService.uploadAsset(PROJECT_ID, uploadName, buffer, 'image/png');
      urls[key] = url;
      console.log(`  ${key} -> ${url}`);
    }

    // ── Step 3: read project from Firestore ──────────────────────────────────
    console.log('\n[BgUpload] Reading project from Firestore...');
    const project: any = await FirestoreService.getProject(PROJECT_ID);
    if (!project) {
      console.error('[BgUpload] Project not found:', PROJECT_ID);
      process.exit(1);
    }

    const scenes: any[] = project.scenes || [];
    if (scenes.length === 0) {
      console.error('[BgUpload] Project has no scenes — run seed_pilot.ts first');
      process.exit(1);
    }
    console.log(`[BgUpload] Found ${scenes.length} scenes`);

    // ── Step 4: update each scene with background_url ────────────────────────
    scenes.sort((a: any, b: any) => a.order - b.order).forEach((scene: any) => {
      const bgKey = SCENE_BG_MAP[scene.order];
      if (!bgKey) {
        console.warn(`[BgUpload] No bg mapping for scene order ${scene.order} — skipping`);
        return;
      }
      scene.background_url = urls[bgKey];
      scene.background_generated = true;   // tells pipeline to skip Imagen 4
    });

    // ── Step 5: save back to Firestore ────────────────────────────────────────
    console.log('\n[BgUpload] Saving updated scenes to Firestore...');
    await FirestoreService.saveProject(project);
    console.log('[BgUpload] ✓ Saved.');

    // ── Step 6: verify — read back and print ─────────────────────────────────
    console.log('\n[BgUpload] Verifying — reading back from Firestore...');
    const verify: any = await FirestoreService.getProject(PROJECT_ID);
    const verifyScenes: any[] = (verify?.scenes || []).sort((a: any, b: any) => a.order - b.order);

    let allOk = true;
    console.log('');
    verifyScenes.forEach((s: any) => {
      const hasUrl = typeof s.background_url === 'string' && s.background_url.startsWith('https://');
      if (!hasUrl) allOk = false;
      console.log(
        `  Scene ${String(s.order + 1).padStart(2, '0')} (${s.scene_id?.slice(0, 8)}) | ` +
        `${(s.character || 'NARRATOR').padEnd(8)} | ` +
        `${hasUrl ? '✓' : '✗ MISSING'} ${s.background_url || '(none)'}`
      );
    });

    console.log('');
    if (allOk) {
      console.log('[BgUpload] All 6 scenes have valid Supabase URLs. Ready to render.');
    } else {
      console.error('[BgUpload] Some scenes are missing background_url — check above.');
      process.exit(1);
    }
  });
}

main().catch(e => { console.error('[BgUpload] FATAL:', e); process.exit(1); });
