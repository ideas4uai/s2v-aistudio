/**
 * Seeds outputs/1418a9d2-...json so the existing render is accessible after
 * server restart with DISABLE_FIRESTORE=true.
 *
 * Run once: npx tsx scripts/test_output_path.ts
 *
 * After running:
 *   1. Start the server (it re-hydrates projectMemoryStore from outputs/*.json)
 *   2. GET /api/projects/1418a9d2-98f3-441e-b77d-6309f8943cd6
 *      → should return output_path: "/outputs/1418a9d2-98f3-441e-b77d-6309f8943cd6.mp4"
 *
 * Future renders: saveProjectState() now writes outputs/{id}.json automatically
 * when status === 'completed' and DISABLE_FIRESTORE=true, so no manual seeding
 * needed for new projects.
 */

import * as fs from 'fs';
import * as path from 'path';

const PROJECT_ID = '1418a9d2-98f3-441e-b77d-6309f8943cd6';
const outputsDir = path.join(process.cwd(), 'outputs');
const videoPath = path.join(outputsDir, `${PROJECT_ID}.mp4`);
const jsonPath = path.join(outputsDir, `${PROJECT_ID}.json`);

if (!fs.existsSync(videoPath)) {
  console.error('ERROR: Video file not found:', videoPath);
  process.exit(1);
}

const sizeMB = (fs.statSync(videoPath).size / 1024 / 1024).toFixed(1);
console.log(`Video file found: ${videoPath} (${sizeMB} MB)`);

const projectRecord = {
  project_id: PROJECT_ID,
  status: 'completed',
  output_path: videoPath,
  topic: 'Seeded by test_output_path.ts',
  mode: 'long',
  style_profile: 'cinematic',
  pacing_intensity: 'moderate',
  hook_strategy: 'default',
  scenes: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

fs.writeFileSync(jsonPath, JSON.stringify(projectRecord, null, 2));
console.log(`Project JSON written: ${jsonPath}`);
console.log('');
console.log('Verify the fix:');
console.log('  1. Start server: npx tsx server.ts');
console.log(`  2. GET http://localhost:3000/api/projects/${PROJECT_ID}`);
console.log(`     Expected: { output_path: "/outputs/${PROJECT_ID}.mp4", ... }`);
