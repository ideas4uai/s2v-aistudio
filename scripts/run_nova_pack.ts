/**
 * Two-phase Nova asset pack runner.
 *
 * Phase 1: Generate body_neutral only — confirms quota is available.
 * Phase 2: Full 25-asset pack via generateAssetPack (only if Phase 1 passes).
 *
 * No Firestore lookups — uses hardcoded Nova UUID + known description.
 * Reference images loaded from local _references/ folder.
 *
 * Run: npx tsx scripts/run_nova_pack.ts
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import {
  loadLocalReferenceImages,
  generateAssetPack,
  ASSET_PROMPTS,
} from '../src/services/characterAssetService.js';

// ── Nova's known identifiers ──────────────────────────────────────────────────
const NOVA_ID   = '3da9733b-1f11-4365-9e90-a0043f76c187';
const NOVA_NAME = 'Nova';
const NOVA_DESC = 'Young woman early 20s, silver-white hair in sharp asymmetric bob with electric blue streaks at tips, sharp angular face, pale blue-white skin with faint glowing circuit-line patterns visible under skin, tall athletic build, deep indigo high-collar jacket with teal glowing accent lines along seams, slim black trousers, floating 2cm off ground, holographic notepad floating near right hand, calm precise warm expression';

// ─────────────────────────────────────────────────────────────────────────────

const isAdcMode = !!process.env.GOOGLE_CLOUD_PROJECT;
const gcpProject = process.env.GOOGLE_CLOUD_PROJECT || '';
const gcpLocation = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const apiKey = process.env.GEMINI_KEY_IMAGE || process.env.GEMINI_KEY_VISUAL || '';

function makeAI() {
  return isAdcMode
    ? new GoogleGenAI({ vertexai: true, project: gcpProject, location: gcpLocation } as any)
    : new GoogleGenAI({ apiKey });
}

// ── Phase 1: single body_neutral quota probe ─────────────────────────────────
async function probeQuota(refParts: any[]): Promise<boolean> {
  console.log('── Phase 1: quota probe (body_neutral) ──');
  const ai = makeAI();

  const prompt = ASSET_PROMPTS.body_neutral
    .replace('[CHARACTER_DESCRIPTION]', `${NOVA_NAME}: ${NOVA_DESC}.`)
    .replace('South Asian graphic novel flat colour illustration style', 'graphic novel flat colour illustration style, clean bold outlines, NOT photorealistic');

  const instruction = `Match this exact character precisely. ${prompt}\n\nCRITICAL: Keep the EXACT SAME face, skin tone, hair colour, hair style, and outfit as shown in the reference images. Character name: ${NOVA_NAME}.`;

  const parts: any[] = [...refParts, { text: instruction }];

  const t0 = Date.now();
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: [{ role: 'user', parts }],
      config: { responseModalities: ['IMAGE', 'TEXT'] } as any,
    });

    const responseParts = response.candidates?.[0]?.content?.parts || [];
    const imgPart = responseParts.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));
    if (!imgPart?.inlineData?.data) throw new Error('No image data in response');

    const buf = Buffer.from(imgPart.inlineData.data as string, 'base64');
    const sizeKB = Math.round(buf.length / 1024);
    if (sizeKB < 4) throw new Error(`Image too small: ${sizeKB}KB`);

    const ms = Date.now() - t0;
    console.log(`✓ body_neutral — ${sizeKB}KB in ${ms}ms`);
    console.log(`  Auth: ${isAdcMode ? `ADC Vertex AI (${gcpProject})` : 'API key'}`);

    // Save probe output locally for inspection
    const outDir = path.join(process.cwd(), 'outputs', 'nova_probe');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'body_neutral_probe.png'), buf);
    console.log(`  Saved: outputs/nova_probe/body_neutral_probe.png`);
    return true;
  } catch (e: any) {
    const msg = e.message?.slice(0, 200) || 'Unknown error';
    const is429 = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Resource exhausted');
    if (is429) {
      console.error(`❌ QUOTA 429 — quota not recovered yet. Do not proceed to full pack.`);
      console.error(`   ${msg.slice(0, 120)}`);
    } else {
      console.error(`❌ Generation failed: ${msg}`);
    }
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('══════════════════════════════════════════════════════════');
  console.log(` Nova Asset Pack — ${new Date().toISOString()}`);
  console.log('══════════════════════════════════════════════════════════');
  console.log(`Auth: ${isAdcMode ? `ADC Vertex AI (${gcpProject})` : 'API key'}`);
  console.log('');

  // ── Verify reference images ─────────────────────────────────────────────────
  const localBufs = loadLocalReferenceImages(NOVA_ID);
  if (!localBufs || localBufs.length === 0) {
    console.error(`❌ No reference images found in assets/characters/${NOVA_ID}/_references/`);
    process.exit(1);
  }
  console.log(`References: ${localBufs.length} image(s) loaded from _references/`);
  localBufs.forEach((b, i) => console.log(`  [${i}] ${Math.round(b.length / 1024)}KB`));
  console.log('');

  // Build refParts for Phase 1 probe (same format as the service uses internally)
  const refParts = localBufs.map(buf => ({
    inlineData: {
      data: buf.toString('base64'),
      mimeType: (buf[0] === 0x89 && buf[1] === 0x50) ? 'image/png' : 'image/jpeg',
    },
  }));

  // ── Phase 1: quota check ────────────────────────────────────────────────────
  const quotaOk = await probeQuota(refParts);
  if (!quotaOk) {
    console.log('\n⛔ STOP: quota check failed — not proceeding to full pack.');
    process.exit(1);
  }
  console.log('✅ Quota check passed — proceeding to full 25-asset pack\n');

  // ── Phase 2: full pack ──────────────────────────────────────────────────────
  console.log('── Phase 2: full 25-asset pack ──');
  console.log('Estimated time: 3–6 minutes (rate-gated, 5 workers, 4500ms gap)');
  console.log('');

  const result = await generateAssetPack(
    NOVA_ID,
    NOVA_NAME,
    NOVA_DESC,
    [],           // referenceImages URLs intentionally empty — local folder is primary
    'flat_colour_anime'
  );

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════');
  console.log(' RESULT');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  Total          : ${result.total}`);
  console.log(`  ✓ Completed    : ${result.succeeded}`);
  console.log(`  ⚠ Needs review : ${result.needsReview}`);
  console.log(`  ✗ Failed       : ${result.failed}`);
  console.log(`  Time           : ${Math.round(result.timeTakenMs / 1000)}s`);
  console.log('');

  if (result.needsReview > 0) {
    console.log('── Needs-review (consistency drift) ──');
    for (const r of result.results.filter(r => r.status === 'needs_review')) {
      console.log(`  ⚠ ${r.assetName.padEnd(20)} deltaE=${r.deltaE?.toFixed(2)}`);
    }
    console.log('');

    if (result.needsReview > 5) {
      console.log('⚠️  STOP: more than 5 assets in needs_review — Nova\'s reference images may be inconsistent.');
      console.log('   Review the deltaE values above and assess before proceeding.');
    }
  }

  if (result.failed > 0) {
    console.log('── Failed ──');
    for (const r of result.results.filter(r => r.status === 'failed')) {
      const err = r.error?.slice(0, 100) || 'unknown';
      const is429 = err.includes('429') || err.includes('RESOURCE_EXHAUSTED');
      console.log(`  ✗ ${r.assetName.padEnd(20)} ${is429 ? '429 quota' : err}`);
    }
    console.log('');
  }

  // Delta-E distribution for all validated assets
  const withDE = result.results.filter(r => r.deltaE !== undefined && r.deltaE > 0);
  if (withDE.length > 0) {
    console.log('── Delta-E distribution ──');
    const sorted = [...withDE].sort((a, b) => (b.deltaE ?? 0) - (a.deltaE ?? 0));
    for (const r of sorted) {
      const dE = r.deltaE ?? 0;
      const bar = '█'.repeat(Math.min(20, Math.round(dE / 2)));
      const flag = r.status === 'needs_review' ? ' ⚠' : '';
      console.log(`  ${r.assetName.padEnd(20)} dE=${String(dE.toFixed(1)).padStart(5)}  ${bar}${flag}`);
    }
    console.log('');
  }

  // Final verdict
  if (result.failed === 0 && result.needsReview === 0) {
    console.log('✅ ALL 25 ASSETS COMPLETED AND PASSED CONSISTENCY CHECK');
  } else if (result.succeeded + result.needsReview >= 20) {
    console.log(`✅ PACK USABLE: ${result.succeeded + result.needsReview}/25 assets available`);
    if (result.needsReview > 0) console.log(`   ${result.needsReview} flagged for review (see deltaE above)`);
    if (result.failed > 0) console.log(`   ${result.failed} failed — regen individually via the UI`);
  } else {
    console.log(`❌ LOW YIELD: ${result.succeeded}/25 completed — check quota errors above`);
    process.exit(1);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
