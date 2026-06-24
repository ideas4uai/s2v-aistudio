/**
 * Integration test: full 25-asset pack for Nova via characterAssetService.
 * Exercises generation + consistency validation + auto-retry + Supabase upload.
 *
 * Run: npx tsx scripts/test_nova_integration.ts
 *
 * Reports: completed / needs_review / failed counts, delta-E values for any
 * drifted assets, and instructions for viewing the UI review grid.
 */
import 'dotenv/config';
import { requestContext } from '../src/server/utils/context.js';
import { FirestoreService } from '../src/server/db/firestore.js';
import { generateAssetPack } from '../src/services/characterAssetService.js';
import type { AssetPackResult } from '../src/types/character.js';

// ─────────────────────────────────────────────────────────────────────────────

async function findNova(): Promise<{ character: any; universeId: string } | null> {
  const universes: any[] = (await FirestoreService.listDocuments('universes', 'dev-user')) || [];
  console.log(`[Setup] ${universes.length} universe(s) found`);

  for (const u of universes) {
    const chars: any[] = u.characters || [];
    const nova = chars.find((c: any) => c.name?.toLowerCase() === 'nova');
    if (nova) {
      console.log(`[Setup] Nova found in universe "${u.title || u.id}" (universeId=${u.id})`);
      console.log(`[Setup] Nova character id : ${nova.id}`);
      console.log(`[Setup] Nova appearance   : ${nova.appearance || nova.concept || nova.description || '(none)'}`);
      console.log(`[Setup] Nova referenceUrl : ${nova.referenceImageUrl || '(none)'}`);
      if (nova.referenceImageUrls?.length) {
        console.log(`[Setup] Nova refUrls[${nova.referenceImageUrls.length}]:`, nova.referenceImageUrls.map((u: string) => u.slice(-50)).join(', '));
      }
      return { character: nova, universeId: u.id };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('══════════════════════════════════════════════════════════');
  console.log(' Nova Integration Test — characterAssetService full run');
  console.log('══════════════════════════════════════════════════════════');
  console.log('');

  const found = await requestContext.run({ token: '__dev__' }, findNova);
  if (!found) {
    console.error('❌ Nova not found in any universe — check Firestore or seed a universe first');
    process.exit(1);
  }

  const { character: nova, universeId } = found;

  // Build reference image list: prefer referenceImageUrls array, then single URL
  const refs: string[] = (nova.referenceImageUrls?.length
    ? nova.referenceImageUrls
    : [nova.referenceImageUrl].filter(Boolean)) as string[];

  if (refs.length === 0) {
    console.error('❌ Nova has no reference images in Firestore. Upload one first via the UI.');
    process.exit(1);
  }

  console.log(`\n[Run] Generating 25-asset pack for Nova with ${refs.length} reference image(s)`);
  console.log(`[Run] This will take ~3-5 minutes (rate-gated at 4500ms/request, 5 workers)`);
  console.log(`[Run] Estimated cost: ~$0.10–0.28 (25 assets × ~$0.004, worst-case 3× retries)`);
  console.log('');

  const description = nova.appearance || nova.concept || nova.description || '';
  const t0 = Date.now();

  let result: AssetPackResult;
  try {
    result = await generateAssetPack(
      nova.id,
      nova.name,
      description,
      refs,
      nova.style || 'flat_colour_anime'
    );
  } catch (err: any) {
    console.error('\n❌ generateAssetPack threw:', err.message);
    process.exit(1);
  }

  const totalSec = Math.round((Date.now() - t0) / 1000);

  // ─── Report ────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════');
  console.log(' RESULT');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  Total assets   : ${result.total}`);
  console.log(`  ✓ Completed    : ${result.succeeded}`);
  console.log(`  ⚠ Needs review : ${result.needsReview}`);
  console.log(`  ✗ Failed       : ${result.failed}`);
  console.log(`  Time           : ${totalSec}s`);
  console.log('');

  if (result.needsReview > 0) {
    console.log('── Needs-review assets (consistency drift detected) ──');
    for (const r of result.results.filter(r => r.status === 'needs_review')) {
      console.log(`  ⚠ ${r.assetName.padEnd(20)} deltaE=${r.deltaE?.toFixed(2)}`);
      if (r.supabaseUrl) console.log(`      url: ${r.supabaseUrl.slice(-60)}`);
    }
    console.log('');
  }

  if (result.failed > 0) {
    console.log('── Failed assets ──');
    for (const r of result.results.filter(r => r.status === 'failed')) {
      console.log(`  ✗ ${r.assetName.padEnd(20)} ${r.error?.slice(0, 80)}`);
    }
    console.log('');
  }

  // ─── Delta-E distribution for all assets ──────────────────────────────────
  const withDE = result.results.filter(r => r.deltaE !== undefined);
  if (withDE.length > 0) {
    console.log('── Delta-E distribution (all validated assets) ──');
    const sorted = [...withDE].sort((a, b) => (b.deltaE ?? 0) - (a.deltaE ?? 0));
    for (const r of sorted) {
      const bar = '█'.repeat(Math.min(20, Math.round((r.deltaE ?? 0) / 2)));
      const flag = r.status === 'needs_review' ? ' ⚠' : r.status === 'failed' ? ' ✗' : '';
      console.log(`  ${r.assetName.padEnd(20)} dE=${String(r.deltaE?.toFixed(1)).padStart(5)}  ${bar}${flag}`);
    }
    console.log('');
  }

  // ─── Auto-regen check ─────────────────────────────────────────────────────
  // The service logs warn lines for each auto-regen — they appear in stdout above.
  // If any asset has deltaE > 0 but status=success, it passed validation on retry.
  const passedAfterCheck = result.results.filter(r => r.status === 'success' && (r.deltaE ?? 0) > 0);
  if (passedAfterCheck.length > 0) {
    console.log(`[Auto-regen] ${passedAfterCheck.length} asset(s) passed validation (consistency check ran, dE within threshold)`);
  }

  // ─── Universe update (mark asset pack generated) ──────────────────────────
  try {
    await requestContext.run({ token: '__dev__' }, async () => {
      const universe = await FirestoreService.getDocument('universes', universeId) as any;
      if (!universe) return;
      const updatedChars = (universe.characters || []).map((c: any) =>
        c.id === nova.id
          ? { ...c, assetPackGenerated: true, assetPackGeneratedAt: new Date().toISOString(), assetPackSucceeded: result.succeeded, assetPackNeedsReview: result.needsReview }
          : c
      );
      await FirestoreService.saveDocument('universes', universeId, { ...universe, characters: updatedChars });
      console.log('[Firestore] Universe updated with asset pack status');
    });
  } catch (e: any) {
    console.warn('[Firestore] Could not update universe:', e.message);
  }

  // ─── UI check instructions ────────────────────────────────────────────────
  console.log('══════════════════════════════════════════════════════════');
  console.log(' UI VERIFICATION STEPS');
  console.log('══════════════════════════════════════════════════════════');
  console.log(' 1. Open http://localhost:5173/characters/new');
  console.log('    (or whatever port the dev server is on)');
  console.log(` 2. Navigate to the Nova character in the universe`);
  console.log(`    universe ID: ${universeId}`);
  console.log(`    character ID: ${nova.id}`);
  console.log(' 3. The review grid (Step 4) should show:');
  console.log(`      - ${result.succeeded} green-bordered tiles (success)`);
  if (result.needsReview > 0) {
    console.log(`      - ${result.needsReview} yellow-bordered tile(s) with ⚠ badge (needs_review)`);
    console.log('      - Hover a yellow tile → dE value shown in overlay');
  } else {
    console.log('      - 0 yellow tiles (no drift detected on this run)');
    console.log('      → To test the failure path: inject a mismatched reference');
    console.log('        via test_consistency_failure_path below');
  }
  if (result.failed > 0) {
    console.log(`      - ${result.failed} red-bordered tile(s) (failed)`);
  }
  console.log('');

  if (result.needsReview === 0 && result.failed === 0) {
    console.log('✅ ALL 25 ASSETS GENERATED AND PASSED CONSISTENCY CHECK');
  } else if (result.succeeded + result.needsReview >= 20) {
    console.log(`✅ PACK USABLE: ${result.succeeded + result.needsReview}/${result.total} assets available`);
    if (result.needsReview > 0) {
      console.log(`   (${result.needsReview} need manual review for consistency drift)`);
    }
  } else {
    console.log(`❌ LOW YIELD: only ${result.succeeded}/${result.total} succeeded — check quota/errors above`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
