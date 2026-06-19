/**
 * End-to-end test for characterAssetService.generateAssetPack.
 * Generates body_neutral only (single-asset), then optionally the full 25.
 * Run: npx tsx scripts/test_char_assets.ts [--full]
 *
 * Uses Veer's reference image from assets/characters/veer/ as reference.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { GoogleGenAI } from '@google/genai';

// ─── Direct model test (no Supabase) ──────────────────────────────────────
const isAdcMode = !!process.env.GOOGLE_CLOUD_PROJECT;
const gcpProject = process.env.GOOGLE_CLOUD_PROJECT || '';
const gcpLocation = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const apiKey = process.env.GEMINI_KEY_IMAGE || process.env.GEMINI_KEY_VISUAL || '';

const MODEL = 'gemini-2.5-flash-image';
const CHAR_NAME = 'VEER';
const CHAR_DESC = 'Young South Asian man, mid-20s, dark short hair, warm brown skin, casual modern outfit — navy blue jacket over white shirt, dark jeans.';
const STYLE_BASE = `South Asian graphic novel flat colour illustration style. Clean bold outlines. NOT photorealistic. NOT realistic. Pure white background #FFFFFF only. Isolated character, no environment, no background elements, no shadows on floor.`;

const ASSET_PROMPTS: Record<string, string> = {
  body_neutral: `[CHAR] Full body character illustration. Head to toe fully visible. Standing relaxed, arms naturally at sides, weight balanced, facing forward, neutral calm expression. ${STYLE_BASE}`,
  body_talking: `[CHAR] Full body character illustration. Head to toe fully visible. Slight forward lean, one hand raised palm-up at chest height, other arm relaxed, mouth slightly open mid-speech, engaged expression. ${STYLE_BASE}`,
  body_thinking: `[CHAR] Full body character illustration. Head to toe fully visible. One hand resting lightly on chin, other arm crossed at waist, gaze looking up-left, thoughtful curious expression. ${STYLE_BASE}`,
  body_surprised: `[CHAR] Full body character illustration. Head to toe fully visible. Slight lean backward, both hands raised at chest height palms facing outward, eyebrows raised high, eyes wide open, mouth open in surprise. ${STYLE_BASE}`,
  mouth_closed: `[CHAR] Close-up head and shoulders portrait only. Mouth completely closed, lips relaxed, neutral calm resting expression. ${STYLE_BASE}`,
  mouth_open_a: `[CHAR] Close-up head and shoulders portrait only. Mouth wide open in AH vowel shape, jaw dropped low, tongue visible at rest, speaking expression. ${STYLE_BASE}`,
  mouth_open_e: `[CHAR] Close-up head and shoulders portrait only. Mouth open in EH vowel shape, medium vertical opening, corners slightly drawn back, mid-speech. ${STYLE_BASE}`,
  mouth_open_o: `[CHAR] Close-up head and shoulders portrait only. Mouth open in rounded OH vowel shape, lips forming a circle, speaking. ${STYLE_BASE}`,
  mouth_smile: `[CHAR] Close-up head and shoulders portrait only. Closed gentle smile, lips softly curved upward, warm friendly expression, mouth closed. ${STYLE_BASE}`,
  mouth_smile_open: `[CHAR] Close-up head and shoulders portrait only. Open happy smile, upper teeth visible, joyful expression, actively talking and laughing. ${STYLE_BASE}`,
  eyes_open: `[CHAR] Close-up head and shoulders portrait only. Eyes fully open, alert relaxed expression, looking directly forward. ${STYLE_BASE}`,
  eyes_half: `[CHAR] Close-up head and shoulders portrait only. Eyes half-closed, eyelids drooping halfway, heavy-lidded tired or skeptical expression. ${STYLE_BASE}`,
  eyes_closed: `[CHAR] Close-up head and shoulders portrait only. Eyes fully closed in mid-blink, both eyelids completely shut, natural blink frame. ${STYLE_BASE}`,
  eyes_wide: `[CHAR] Close-up head and shoulders portrait only. Eyes very wide open, pupils large, shocked or highly surprised expression, eyebrows raised. ${STYLE_BASE}`,
  brow_neutral: `[CHAR] Close-up head and shoulders portrait only. Eyebrows in completely relaxed neutral position, calm unbothered resting expression. ${STYLE_BASE}`,
  brow_raised: `[CHAR] Close-up head and shoulders portrait only. Both eyebrows raised high, curious or pleasantly surprised expression, forehead slightly wrinkled. ${STYLE_BASE}`,
  brow_furrowed: `[CHAR] Close-up head and shoulders portrait only. Both eyebrows pulled together and furrowed downward toward nose, worried or angry expression, slight frown. ${STYLE_BASE}`,
  walk_01: `[CHAR] Full body walking animation frame 1 of 8. Left foot striking the ground (left foot forward contact), right foot behind pushing off, arms swinging — right arm forward left arm back, 3/4 front view walking. ${STYLE_BASE}`,
  walk_02: `[CHAR] Full body walking animation frame 2 of 8. Weight shifting forward onto left foot, right leg beginning to swing forward past the body, transitional mid-stride. ${STYLE_BASE}`,
  walk_03: `[CHAR] Full body walking animation frame 3 of 8. Passing position — both feet close together, right leg swinging through and rising, body at full upright height. ${STYLE_BASE}`,
  walk_04: `[CHAR] Full body walking animation frame 4 of 8. Right foot striking the ground (right foot forward contact), left foot behind, arms swinging — left arm forward right arm back. Mirror image of frame 1. ${STYLE_BASE}`,
  walk_05: `[CHAR] Full body walking animation frame 5 of 8. Weight shifting forward onto right foot, left leg beginning to swing forward past the body, transitional mid-stride. ${STYLE_BASE}`,
  walk_06: `[CHAR] Full body walking animation frame 6 of 8. Passing position — both feet close together, left leg swinging through and rising, body at full upright height. Mirror of frame 3. ${STYLE_BASE}`,
  walk_07: `[CHAR] Full body walking animation frame 7 of 8. Left foot almost making ground contact, right foot pushing off, heel-strike imminent. ${STYLE_BASE}`,
  walk_08: `[CHAR] Full body walking animation frame 8 of 8. Final frame of stride cycle — completes the loop seamlessly back to frame 1. ${STYLE_BASE}`,
};

async function generateAsset(
  ai: GoogleGenAI,
  assetName: string,
  refParts: any[],
  outDir: string
): Promise<{ ok: boolean; sizeKB?: number; error?: string }> {
  const rawPrompt = (ASSET_PROMPTS[assetName] || '')
    .replace('[CHAR]', `${CHAR_NAME}: ${CHAR_DESC}.`);
  const instruction = `Match this exact character precisely. ${rawPrompt}\n\nCRITICAL: Keep the EXACT SAME face, skin tone, hair colour, hair style, and outfit as shown in the reference images. Only change the pose and expression as specified. Character name: ${CHAR_NAME}.`;
  const parts: any[] = [...refParts, { text: instruction }];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: 'user', parts }],
        config: { responseModalities: ['IMAGE', 'TEXT'] } as any,
      });

      const responseParts = response.candidates?.[0]?.content?.parts || [];
      const imgPart = responseParts.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));
      if (!imgPart?.inlineData?.data) throw new Error('No image data in response');

      const buf = Buffer.from(imgPart.inlineData.data as string, 'base64');
      const sizeKB = Math.round(buf.length / 1024);
      if (sizeKB < 4) throw new Error(`Image too small: ${sizeKB}KB`);

      fs.writeFileSync(path.join(outDir, `${assetName}.png`), buf);
      return { ok: true, sizeKB };
    } catch (e: any) {
      const is429 = e.message?.includes('429') || e.message?.includes('Resource exhausted');
      if (attempt < 2) await new Promise(r => setTimeout(r, is429 ? 20000 : 3000));
      else return { ok: false, error: e.message?.slice(0, 150) };
    }
  }
  return { ok: false, error: 'exhausted' };
}

async function main() {
  const fullRun = process.argv.includes('--full');
  const outDir = path.join(process.cwd(), 'outputs', 'char_test');
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Auth: ${isAdcMode ? `ADC Vertex AI (${gcpProject})` : 'API key'}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Output: ${outDir}`);
  console.log('');

  // ── Load Veer reference image ────────────────────────────────────────────
  const veerRefPath = path.join(process.cwd(), 'assets', 'characters', 'veer', 'body_neutral.png');
  const refParts: any[] = [];
  if (fs.existsSync(veerRefPath)) {
    const buf = fs.readFileSync(veerRefPath);
    refParts.push({ inlineData: { data: buf.toString('base64'), mimeType: 'image/png' } });
    console.log(`Reference image: ${veerRefPath} (${Math.round(buf.length / 1024)}KB)`);
  } else {
    console.warn('WARNING: No reference image found — generating without character reference');
  }
  console.log('');

  const ai = isAdcMode
    ? new GoogleGenAI({ vertexai: true, project: gcpProject, location: gcpLocation } as any)
    : new GoogleGenAI({ apiKey });

  // ── Phase 1: Single asset (body_neutral) ────────────────────────────────
  console.log('─── Phase 1: body_neutral smoke test ───');
  const t0 = Date.now();
  const single = await generateAsset(ai, 'body_neutral', refParts, outDir);
  const singleMs = Date.now() - t0;

  if (!single.ok) {
    console.error(`❌ body_neutral FAILED in ${singleMs}ms: ${single.error}`);
    console.error('Stopping — fix model/auth before full pack run');
    process.exit(1);
  }
  console.log(`✓ body_neutral — ${single.sizeKB}KB in ${singleMs}ms → ${outDir}/body_neutral.png`);
  console.log('');

  if (!fullRun) {
    console.log('Single asset passed. Run with --full to generate all 25 assets.');
    return;
  }

  // ── Phase 2: Full 25-asset pack ─────────────────────────────────────────
  const CONCURRENCY = 5;
  const REQUEST_GAP_MS = 4500; // ~13 RPM — stay under Vertex AI quota
  console.log(`─── Phase 2: Full 25-asset pack (concurrency=${CONCURRENCY}, gap=${REQUEST_GAP_MS}ms) ───`);
  const assetNames = Object.keys(ASSET_PROMPTS);
  const startFull = Date.now();

  const queue2 = [...assetNames];
  const resultMap = new Map<string, { name: string; ok: boolean; sizeKB?: number; error?: string }>();
  let nextSlotAt = Date.now();

  async function worker2() {
    while (queue2.length > 0) {
      const name = queue2.shift();
      if (!name) break;
      const waitMs = Math.max(0, nextSlotAt - Date.now());
      nextSlotAt = Math.max(Date.now(), nextSlotAt) + REQUEST_GAP_MS;
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
      const r = await generateAsset(ai, name, refParts, outDir);
      resultMap.set(name, { name, ...r });
      if (r.ok) console.log(`  ✓ ${name.padEnd(18)} ${r.sizeKB}KB`);
      else console.warn(`  ✗ ${name.padEnd(18)} ${r.error}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker2));

  const results = assetNames.map(name => resultMap.get(name) ?? { name, ok: false, error: 'dropped' });

  const succeeded = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  const elapsed = Math.round((Date.now() - startFull) / 1000);

  console.log('');
  console.log(`─── Result: ${succeeded}/${assetNames.length} in ${elapsed}s ───`);
  if (failed.length > 0) {
    console.warn('Failed assets:');
    for (const f of failed) console.warn(`  ✗ ${f.name}: ${f.error}`);
  }
  console.log(`Output dir: ${outDir}`);

  if (succeeded < 20) {
    console.error(`❌ FAIL: only ${succeeded}/25 succeeded (need ≥20)`);
    process.exit(1);
  }
  console.log(`✅ PASS: ${succeeded}/25 assets generated`);
}

main().catch(e => { console.error(e); process.exit(1); });
