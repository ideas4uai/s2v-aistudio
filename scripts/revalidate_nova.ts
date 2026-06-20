/**
 * Re-validate the 5 Nova needs_review assets with the fixed validator and re-upload to Supabase.
 * Run: npx tsx scripts/revalidate_nova.ts
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { validateAssetConsistency } from '../src/services/characterAssetService.js';
import { FirestoreService } from '../src/server/db/firestore.js';
import { requestContext } from '../src/server/utils/context.js';

const NOVA_ID  = '3da9733b-1f11-4365-9e90-a0043f76c187';
const charDir  = path.join(process.cwd(), 'assets', 'characters', NOVA_ID);
const refPath  = path.join(charDir, 'ref_primary.png');

const NEEDS_REVIEW = ['mouth_closed', 'mouth_open_a', 'mouth_open_e', 'eyes_open', 'brow_raised'];

async function main() {
  console.log('Re-validating 5 needs_review Nova assets with fixed validator...\n');

  let passed = 0, failed = 0;

  for (const name of NEEDS_REVIEW) {
    const localPath = path.join(charDir, `${name}.png`);
    if (!fs.existsSync(localPath)) {
      console.log(`  ✗ ${name.padEnd(18)} — file missing, skipping`);
      failed++;
      continue;
    }

    const check = validateAssetConsistency(localPath, refPath);
    const deMark = ` dE=${check.deltaE.toFixed(2)}`;

    if (!check.passed) {
      console.log(`  ✗ ${name.padEnd(18)} ${deMark} — still drifted after fix (unexpected)`);
      failed++;
      continue;
    }

    // Re-upload to Supabase with correct (passing) result
    const buf = fs.readFileSync(localPath);
    try {
      const url = await requestContext.run({ token: '__dev__' }, async () =>
        FirestoreService.uploadAsset(NOVA_ID, `parts/${name}.png`, buf, 'image/png')
      );
      console.log(`  ✓ ${name.padEnd(18)} ${deMark} → ${url.slice(-45)}`);
      passed++;
    } catch (e: any) {
      console.log(`  ✗ ${name.padEnd(18)} ${deMark} — upload failed: ${e.message.slice(0, 80)}`);
      failed++;
    }
  }

  console.log(`\nDone: ${passed}/${NEEDS_REVIEW.length} re-validated and re-uploaded.`);
  if (failed > 0) {
    console.log(`${failed} failed — check output above.`);
    process.exit(1);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
