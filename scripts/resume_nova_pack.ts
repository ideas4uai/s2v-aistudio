/**
 * Resume Nova asset pack — skips already-completed assets, generates only missing ones.
 *
 * Flags:
 *   --use-api-key   Force Gemini API key mode (GEMINI_KEY_IMAGE), ignore any ADC env vars.
 *
 * Run: npx tsx scripts/resume_nova_pack.ts --use-api-key
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import {
  loadLocalReferenceImages,
  validateAssetConsistency,
  ASSET_PROMPTS,
  ASSET_NAMES,
} from '../src/services/characterAssetService.js';
import { FirestoreService } from '../src/server/db/firestore.js';
import { requestContext } from '../src/server/utils/context.js';

// ── Nova's known identifiers ──────────────────────────────────────────────────
const NOVA_ID   = '3da9733b-1f11-4365-9e90-a0043f76c187';
const NOVA_NAME = 'Nova';
const NOVA_DESC = 'Young woman early 20s, silver-white hair in sharp asymmetric bob with electric blue streaks at tips, sharp angular face, pale blue-white skin with faint glowing circuit-line patterns visible under skin, tall athletic build, deep indigo high-collar jacket with teal glowing accent lines along seams, slim black trousers, floating 2cm off ground, holographic notepad floating near right hand, calm precise warm expression';

// ── CLI flags ─────────────────────────────────────────────────────────────────
const USE_API_KEY = process.argv.includes('--use-api-key');

// ── Auth setup ────────────────────────────────────────────────────────────────
// --use-api-key forces API key mode regardless of ADC env vars.
const forceApiKey = USE_API_KEY;
const isAdcMode   = !forceApiKey && !!process.env.GOOGLE_CLOUD_PROJECT;
const gcpProject  = process.env.GOOGLE_CLOUD_PROJECT || '';
const gcpLocation = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const apiKey      = process.env.GEMINI_KEY_IMAGE || process.env.GEMINI_KEY_VISUAL || '';

function makeAI() {
  if (isAdcMode) {
    return new GoogleGenAI({ vertexai: true, project: gcpProject, location: gcpLocation } as any);
  }
  if (!apiKey) throw new Error('GEMINI_KEY_IMAGE or GEMINI_KEY_VISUAL must be set (non-ADC mode)');
  return new GoogleGenAI({ apiKey });
}

const authLabel = isAdcMode
  ? `ADC Vertex AI (${gcpProject})`
  : `API key (${apiKey.slice(0, 8)}...)`;

// ── Constants matching characterAssetService.ts ───────────────────────────────
const CONCURRENCY    = 5;
const REQUEST_GAP_MS = 4500;
const MAX_ATTEMPTS   = 3;
const BACKOFF_BASE   = 3000;
const BACKOFF_429    = 20000;
const CONSISTENCY_THRESHOLD = 15;

const charDir   = path.join(process.cwd(), 'assets', 'characters', NOVA_ID);
const localRefPath = path.join(charDir, 'ref_primary.png');

// ── Image validation (mirrors service) ────────────────────────────────────────
function validateBuf(buf: Buffer, name: string): string | null {
  const kb = buf.length / 1024;
  if (kb < 4) return `Too small (${kb.toFixed(1)}KB)`;
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('══════════════════════════════════════════════════════════');
  console.log(` Nova Asset Pack Resume — ${new Date().toISOString()}`);
  console.log('══════════════════════════════════════════════════════════');
  console.log(`Auth: ${authLabel}`);
  console.log('');

  // ── Load references ────────────────────────────────────────────────────────
  const localBufs = loadLocalReferenceImages(NOVA_ID);
  if (!localBufs || localBufs.length === 0) {
    console.error(`❌ No reference images in assets/characters/${NOVA_ID}/_references/`);
    process.exit(1);
  }
  console.log(`References: ${localBufs.length} image(s) loaded from _references/`);

  const refParts = localBufs.map(buf => ({
    inlineData: {
      data: buf.toString('base64'),
      mimeType: (buf[0] === 0x89 && buf[1] === 0x50) ? 'image/png' : 'image/jpeg',
    },
  }));

  // ── Determine which assets need generation ─────────────────────────────────
  const skipped: string[] = [];
  const todo: string[] = [];

  for (const name of ASSET_NAMES) {
    const p = path.join(charDir, `${name}.png`);
    if (fs.existsSync(p) && fs.statSync(p).size > 4096) {
      skipped.push(name);
    } else {
      todo.push(name);
    }
  }

  console.log(`\n── Resume check ──`);
  console.log(`  Already done (skipping): ${skipped.length} — ${skipped.join(', ')}`);
  console.log(`  To generate            : ${todo.length} — ${todo.join(', ')}`);
  console.log('');

  if (todo.length === 0) {
    console.log('✅ All 25 assets already present — nothing to do.');
    return;
  }

  // ── Quick quota probe on first todo asset ──────────────────────────────────
  console.log(`── Quota probe (${todo[0]}) ──`);
  const ai = makeAI();
  const probeAsset = todo[0];
  const probePrompt = ASSET_PROMPTS[probeAsset]
    .replace('[CHARACTER_DESCRIPTION]', `${NOVA_NAME}: ${NOVA_DESC}.`)
    .replace('South Asian graphic novel flat colour illustration style',
             'graphic novel flat colour illustration style, clean bold outlines, NOT photorealistic');
  const probeParts: any[] = [...refParts, { text: `Match this exact character precisely. ${probePrompt}\n\nCRITICAL: Keep EXACT face, skin tone, hair colour, hair style, and outfit from references. Character name: ${NOVA_NAME}.` }];

  const t0 = Date.now();
  let probeOk = false;
  let probeBuf: Buffer | null = null;
  try {
    const resp = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: [{ role: 'user', parts: probeParts }],
      config: { responseModalities: ['IMAGE', 'TEXT'] } as any,
    });
    const rp = resp.candidates?.[0]?.content?.parts || [];
    const img = rp.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));
    if (!img?.inlineData?.data) throw new Error('No image in response');
    probeBuf = Buffer.from(img.inlineData.data as string, 'base64');
    if (probeBuf.length < 4096) throw new Error(`Too small: ${Math.round(probeBuf.length / 1024)}KB`);
    console.log(`✓ ${probeAsset} — ${Math.round(probeBuf.length / 1024)}KB in ${Date.now() - t0}ms`);
    probeOk = true;
  } catch (e: any) {
    const msg = e.message?.slice(0, 200) || '';
    const is429 = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Resource exhausted');
    console.error(`❌ Probe failed: ${msg}`);
    if (is429) {
      console.error('⛔ 429 quota hit — stop here as instructed.');
      process.exit(2);
    }
    process.exit(1);
  }
  console.log('✅ Quota probe passed\n');

  // ── Generate all todo assets ───────────────────────────────────────────────
  console.log(`── Generating ${todo.length} remaining assets ──`);
  console.log(`   concurrency=${CONCURRENCY}, gap=${REQUEST_GAP_MS}ms, retries=${MAX_ATTEMPTS}`);
  console.log('');

  const startTime = Date.now();
  const queue = [...todo];
  const resultMap = new Map<string, { status: string; error?: string; deltaE?: number; localPath?: string; supabaseUrl?: string }>();
  let nextSlotAt = Date.now();

  // First asset already generated by probe — save it and mark done
  if (probeBuf) {
    const localPath = path.join(charDir, `${probeAsset}.png`);
    fs.writeFileSync(localPath, probeBuf);

    let consistency: { passed: boolean; deltaE: number } | null = null;
    if (fs.existsSync(localRefPath)) {
      consistency = validateAssetConsistency(localPath, localRefPath);
    }

    try {
      await requestContext.run({ token: '__dev__' }, async () => {
        const supabaseUrl = await FirestoreService.uploadAsset(
          NOVA_ID,
          `parts/${probeAsset}.png`,
          probeBuf!,
          'image/png'
        );
        const drifted = consistency && !consistency.passed;
        const deMark  = consistency ? ` dE=${consistency.deltaE.toFixed(1)}` : '';
        if (drifted) {
          console.warn(`[AssetPack] ⚠ ${probeAsset.padEnd(18)} ${Math.round(probeBuf!.length / 1024)}KB${deMark} → needs_review`);
          resultMap.set(probeAsset, { status: 'needs_review', localPath, supabaseUrl, deltaE: consistency!.deltaE });
        } else {
          console.log(`[AssetPack] ✓ ${probeAsset.padEnd(18)} ${Math.round(probeBuf!.length / 1024)}KB${deMark} → ${supabaseUrl.slice(-40)}`);
          resultMap.set(probeAsset, { status: 'success', localPath, supabaseUrl, deltaE: consistency?.deltaE });
        }
      });
    } catch (uploadErr: any) {
      console.warn(`[AssetPack] ✗ ${probeAsset} upload failed: ${uploadErr.message}`);
      resultMap.set(probeAsset, { status: 'failed', error: `Upload: ${uploadErr.message}` });
    }

    // Remove from queue (already handled)
    const idx = queue.indexOf(probeAsset);
    if (idx !== -1) queue.splice(idx, 1);
    // Set next slot accounting for probe time already taken
    nextSlotAt = Date.now() + REQUEST_GAP_MS;
  }

  const styleInstruction = 'graphic novel flat colour illustration style, clean bold outlines, NOT photorealistic';

  async function worker() {
    while (queue.length > 0) {
      const assetName = queue.shift();
      if (!assetName) break;

      const waitMs = Math.max(0, nextSlotAt - Date.now());
      nextSlotAt = Math.max(Date.now(), nextSlotAt) + REQUEST_GAP_MS;
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));

      const rawPrompt = ASSET_PROMPTS[assetName]
        .replace('[CHARACTER_DESCRIPTION]', `${NOVA_NAME}: ${NOVA_DESC}.`)
        .replace('South Asian graphic novel flat colour illustration style', styleInstruction);

      const instruction = `Match this exact character precisely. ${rawPrompt}

CRITICAL: Keep the EXACT SAME face, skin tone, hair colour, hair style, and outfit as shown in the reference images. Only change the pose and expression as specified. Character name: ${NOVA_NAME}.`;

      const parts: any[] = [...refParts, { text: instruction }];
      const localPath = path.join(charDir, `${assetName}.png`);

      let lastError = '';
      let finalBuf: Buffer | null = null;
      let finalConsistency: { passed: boolean; deltaE: number } | null = null;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: [{ role: 'user', parts }],
            config: { responseModalities: ['IMAGE', 'TEXT'] } as any,
          });

          const rp = response.candidates?.[0]?.content?.parts || [];
          const img = rp.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));
          if (!img?.inlineData?.data) throw new Error('No image data in response');

          const buf = Buffer.from(img.inlineData.data as string, 'base64');
          const sizeErr = validateBuf(buf, assetName);
          if (sizeErr) throw new Error(sizeErr);

          fs.writeFileSync(localPath, buf);

          if (fs.existsSync(localRefPath)) {
            const check = validateAssetConsistency(localPath, localRefPath);
            finalConsistency = check;
            if (!check.passed && attempt < MAX_ATTEMPTS - 1) {
              console.warn(`[AssetPack] ⚠ ${assetName} drifted (dE=${check.deltaE.toFixed(1)}) — regenerating`);
              lastError = `Drift dE=${check.deltaE.toFixed(1)}`;
              await new Promise(r => setTimeout(r, BACKOFF_BASE));
              continue;
            }
          }

          finalBuf = buf;
          lastError = '';
          break;
        } catch (e: any) {
          lastError = e.message?.slice(0, 200) || 'Unknown';
          const is429 = lastError.includes('429') || lastError.includes('RESOURCE_EXHAUSTED') || lastError.includes('Resource exhausted');
          if (attempt < MAX_ATTEMPTS - 1) {
            const delay = is429 ? BACKOFF_429 : BACKOFF_BASE * (attempt + 1);
            console.warn(`[AssetPack] retry ${attempt + 1}/${MAX_ATTEMPTS - 1} ${assetName} in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }

      if (!finalBuf) {
        console.warn(`[AssetPack] ✗ ${assetName}: ${lastError}`);
        resultMap.set(assetName, { status: 'failed', error: lastError });
        continue;
      }

      try {
        await requestContext.run({ token: '__dev__' }, async () => {
          const supabaseUrl = await FirestoreService.uploadAsset(
            NOVA_ID,
            `parts/${assetName}.png`,
            finalBuf!,
            'image/png'
          );
          const drifted = finalConsistency && !finalConsistency.passed;
          const deMark  = finalConsistency ? ` dE=${finalConsistency.deltaE.toFixed(1)}` : '';
          if (drifted) {
            console.warn(`[AssetPack] ⚠ ${assetName.padEnd(18)} ${Math.round(finalBuf!.length / 1024)}KB${deMark} → needs_review`);
            resultMap.set(assetName, { status: 'needs_review', localPath, supabaseUrl, deltaE: finalConsistency!.deltaE });
          } else {
            console.log(`[AssetPack] ✓ ${assetName.padEnd(18)} ${Math.round(finalBuf!.length / 1024)}KB${deMark} → ${supabaseUrl.slice(-40)}`);
            resultMap.set(assetName, { status: 'success', localPath, supabaseUrl, deltaE: finalConsistency?.deltaE });
          }
        });
      } catch (uploadErr: any) {
        console.warn(`[AssetPack] ✗ ${assetName} upload: ${uploadErr.message}`);
        resultMap.set(assetName, { status: 'failed', error: `Upload: ${uploadErr.message}` });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const elapsed = Math.round((Date.now() - startTime) / 1000);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════');
  console.log(' RESULT');
  console.log('══════════════════════════════════════════════════════════');

  let succeeded = 0, needsReview = 0, failed = 0;
  const needsReviewList: Array<{ name: string; dE?: number }> = [];
  const failedList: Array<{ name: string; err: string }> = [];

  for (const name of todo) {
    const r = resultMap.get(name);
    if (!r || r.status === 'failed') {
      failed++;
      failedList.push({ name, err: r?.error || 'no result' });
    } else if (r.status === 'needs_review') {
      needsReview++;
      needsReviewList.push({ name, dE: r.deltaE });
    } else {
      succeeded++;
    }
  }

  console.log(`  This run:`);
  console.log(`    ✓ Completed    : ${succeeded}/${todo.length}`);
  console.log(`    ⚠ Needs review : ${needsReview}/${todo.length}`);
  console.log(`    ✗ Failed       : ${failed}/${todo.length}`);
  console.log(`    Time           : ${elapsed}s`);
  console.log('');
  console.log(`  Overall (skipped + this run):`);
  const totalDone = skipped.length + succeeded + needsReview;
  console.log(`    ✓/⚠ Available  : ${totalDone}/25`);
  console.log(`    ✗ Failed       : ${failed}/25`);

  if (needsReviewList.length > 0) {
    console.log('\n── Needs-review ──');
    for (const { name, dE } of needsReviewList) {
      console.log(`  ⚠ ${name.padEnd(20)} dE=${dE?.toFixed(2) ?? 'n/a'}`);
    }
  }

  if (failedList.length > 0) {
    console.log('\n── Failed ──');
    for (const { name, err } of failedList) {
      const is429 = err.includes('429') || err.includes('RESOURCE_EXHAUSTED');
      console.log(`  ✗ ${name.padEnd(20)} ${is429 ? '429 quota' : err.slice(0, 80)}`);
    }
  }

  console.log('');
  if (failed === 0 && needsReview === 0) {
    console.log('✅ ALL 25 ASSETS COMPLETED AND PASSED CONSISTENCY CHECK');
  } else if (totalDone >= 20) {
    console.log(`✅ PACK USABLE: ${totalDone}/25 assets available`);
    if (needsReview > 0) console.log(`   ${needsReview} flagged for review`);
    if (failed > 0) console.log(`   ${failed} failed — regen individually via UI`);
  } else {
    console.log(`❌ LOW YIELD: only ${totalDone}/25 — check errors above`);
    process.exit(1);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
