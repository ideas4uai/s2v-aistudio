/**
 * Stitch EP2 segments directly from disk using Firestore scene order.
 * Run: npx tsx scripts/stitch_ep2.ts
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { requestContext } from '../src/server/utils/context.js';
import { FirestoreService } from '../src/server/db/firestore.js';

const PROJECT_ID = '85fed594-3d48-46bf-bfea-6e4d2037efd0';
const TEMP_DIR = path.join(os.tmpdir(), 'ais-renderer');
const CONCAT_LIST = 'E:\\s2v-aistudio\\outputs\\concat_list.txt';
const OUTPUT_FILE = 'E:\\s2v-aistudio\\outputs\\ep2_final.mp4';

async function main() {
  await requestContext.run({ token: '__dev__' }, async () => {
    // --- STEP 1: Get scene order from Firestore ---
    console.log('Loading project from Firestore...');
    const project: any = await FirestoreService.getProject(PROJECT_ID);
    if (!project) {
      console.error('ERROR: Project not found in Firestore');
      process.exit(1);
    }

    const scenes: any[] = (project.scenes || []).slice().sort((a: any, b: any) => a.order - b.order);
    console.log(`Found ${scenes.length} scenes. Resolving segment files...\n`);

    // --- STEP 2: Map each scene to its segment file ---
    const orderedSegments: { order: number; scene_id: string; file: string }[] = [];
    const missing: string[] = [];

    for (const scene of scenes) {
      const id = scene.scene_id;
      // Prefer captioned (captions burned in), fall back to raw segment
      const captionedPath = path.join(TEMP_DIR, `${id}_captioned.mp4`);
      const segmentPath = path.join(TEMP_DIR, `${id}_segment.mp4`);

      let resolved: string | null = null;
      if (fs.existsSync(captionedPath)) {
        resolved = captionedPath;
      } else if (fs.existsSync(segmentPath)) {
        resolved = segmentPath;
      }

      const label = resolved
        ? path.basename(resolved)
        : 'MISSING';

      console.log(`  Order ${String(scene.order).padStart(2, '0')} | ${id} → ${label}`);

      if (resolved) {
        orderedSegments.push({ order: scene.order, scene_id: id, file: resolved });
      } else {
        missing.push(id);
      }
    }

    console.log('');

    if (missing.length > 0) {
      console.error(`ERROR: ${missing.length} scene(s) have no segment file:`);
      missing.forEach(id => console.error(`  ${id}`));
      process.exit(1);
    }

    if (orderedSegments.length === 0) {
      console.error('ERROR: No segments to stitch');
      process.exit(1);
    }

    // --- STEP 3: Write concat list ---
    const concatLines = orderedSegments.map(s => `file '${s.file.replace(/\\/g, '/')}'`).join('\n');
    fs.mkdirSync(path.dirname(CONCAT_LIST), { recursive: true });
    fs.writeFileSync(CONCAT_LIST, concatLines + '\n', 'utf8');
    console.log(`Wrote concat list to: ${CONCAT_LIST}`);
    console.log(`Lines:\n${concatLines}\n`);

    // --- STEP 4: Run FFmpeg ---
    if (fs.existsSync(OUTPUT_FILE)) {
      fs.unlinkSync(OUTPUT_FILE);
      console.log(`Deleted existing output: ${OUTPUT_FILE}`);
    }

    const ffmpegCmd = `ffmpeg -y -f concat -safe 0 -i "${CONCAT_LIST}" -c copy "${OUTPUT_FILE}"`;
    console.log(`Running: ${ffmpegCmd}\n`);

    let exitCode = 0;
    try {
      execSync(ffmpegCmd, { stdio: 'inherit' });
    } catch (e: any) {
      exitCode = e.status ?? 1;
      console.error(`FFmpeg exited with code ${exitCode}`);
    }

    // --- STEP 5: Report ---
    console.log('\n── Result ──');
    console.log(`FFmpeg exit code: ${exitCode}`);
    if (fs.existsSync(OUTPUT_FILE)) {
      const size = fs.statSync(OUTPUT_FILE).size;
      const mb = (size / 1024 / 1024).toFixed(2);
      console.log(`Output file: ${OUTPUT_FILE}`);
      console.log(`File size:   ${mb} MB (${size} bytes)`);
    } else {
      console.error('Output file NOT created.');
    }
  });
}

main().catch(e => { console.error(e); process.exit(1); });
