/**
 * Phase 1: Generate 7 headless body pose assets for Veer (and Nova).
 *
 * These are used in the upcoming body_composite rendering mode where a
 * separately-extracted head layer is composited onto a headless body each frame,
 * enabling full-body grounded rendering with per-frame mouth/eye/brow swaps.
 *
 * Assets saved to: assets/characters/{name}/_headless/{pose}.png
 * Canvas target:   1024×1536  (matches Veer's existing body_thinking.png)
 *
 * Run: npx tsx scripts/gen_headless_bodies.ts [--character veer|nova|all]
 * Auth: ADC Vertex AI (GOOGLE_CLOUD_PROJECT must be set)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';

// ─── Config ──────────────────────────────────────────────────────────────────
const isAdcMode = !!process.env.GOOGLE_CLOUD_PROJECT;
const gcpProject = process.env.GOOGLE_CLOUD_PROJECT || '';
const gcpLocation = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const MODEL = 'gemini-2.5-flash-image';
const MAX_ATTEMPTS = 3;
const REQUEST_GAP_MS = 4500;
const BACKOFF_BASE_MS = 5000;
const BACKOFF_429_MS = 25000;

// ─── Character configs ────────────────────────────────────────────────────────
const CHARACTERS: Record<string, {
  name: string;
  description: string;
  assetsDir: string;    // where to save
  refDir: string;       // where _references/ lives
}> = {
  veer: {
    name: 'VEER',
    description: 'Young South Asian man, mid-20s, dark short hair, warm brown skin, casual modern outfit — navy blue jacket over white shirt, dark jeans.',
    assetsDir: path.join(process.cwd(), 'assets', 'characters', 'veer'),
    refDir: path.join(process.cwd(), 'assets', 'characters', 'c8d441f2-3395-4982-8aa8-951386040579'),
  },
  nova: {
    name: 'NOVA',
    description: 'Young South Asian woman, mid-20s, long dark hair, warm brown skin, modern outfit.',
    assetsDir: path.join(process.cwd(), 'assets', 'characters', '3da9733b-1f11-4365-9e90-a0043f76c187'),
    refDir: path.join(process.cwd(), 'assets', 'characters', '3da9733b-1f11-4365-9e90-a0043f76c187'),
  },
};

// ─── Style base ───────────────────────────────────────────────────────────────
const STYLE_BASE = `South Asian graphic novel flat colour illustration style. Clean bold outlines. NOT photorealistic. NOT realistic. Pure white background #FFFFFF only. Isolated character, no environment, no background elements, no shadows on floor.`;

// ─── Headless crop framing instruction ────────────────────────────────────────
// Two-layer constraint: composition/crop framing + explicit visual exclusion.
const HEADLESS_STRONG = `CRITICAL VISUAL REQUIREMENT: This image MUST NOT contain any head, face, neck, or facial features. The shirt collar/neckline IS the top edge of the illustration — the character's head is completely outside the frame, replaced by white background above the collar. Body pose from collar/shoulders down only — full torso, arms, and feet. NO head. NO neck. NO face.`;

const STYLE_BASE_HEADLESS = `${STYLE_BASE} The character appears HEADLESS in this frame — white background where the head would be, collar at very top of image.`;

// ─── Canonical outfit lock ────────────────────────────────────────────────────
// Determined from approved portrait assets (mouth_closed.png, eyes_open.png):
// plain navy blue crew-neck t-shirt, dark charcoal grey jogger pants, white sneakers.
// NO jacket. All 7 body poses must match this exactly.
const VEER_OUTFIT = `OUTFIT (must match exactly): plain navy blue crew-neck t-shirt (no jacket, no hoodie, no zip-up, no layering — t-shirt only), dark charcoal grey jogger pants with visible drawstring waistband, white sneakers.`;

// ─── 7 Headless body pose prompts ────────────────────────────────────────────
const HEADLESS_PROMPTS: Record<string, string> = {
  body_neutral: `[CHARACTER_DESCRIPTION] Clothing and body pose illustration: body from collar downward only. Standing relaxed, arms naturally at sides, weight balanced, feet flat on ground, facing forward. ${VEER_OUTFIT} ${HEADLESS_STRONG} ${STYLE_BASE_HEADLESS}`,

  // body angled 3/4 view to avoid direct camera-face — which makes model add head
  body_talking: `[CHARACTER_DESCRIPTION] Clothing and body pose illustration — BODY FROM COLLAR DOWN, NO HEAD. Body angled slightly to the right (3/4 view). Right arm raised with palm open to the side as if gesturing while speaking. Left arm relaxed at side. Weight shifted to left foot. Body is turned, not facing directly forward. ${VEER_OUTFIT} ${HEADLESS_STRONG} ${STYLE_BASE_HEADLESS}`,

  body_thinking: `[CHARACTER_DESCRIPTION] Clothing and body pose illustration: body from collar downward only. One hand raised up near collar height in a thoughtful gesture, other arm crossed loosely at waist, slight weight shift to one side. ${VEER_OUTFIT} ${HEADLESS_STRONG} ${STYLE_BASE_HEADLESS}`,

  body_surprised: `[CHARACTER_DESCRIPTION] Clothing and body pose illustration — BODY AND HANDS ONLY, NO HEAD. Both hands raised to upper-chest height, palms flat and facing outward with fingers spread wide. Elbows bent at 90 degrees. Body torso leaning slightly backward. Feet planted. This is a STOP or WHOA hand gesture, using only arms and body posture. ${VEER_OUTFIT} ${HEADLESS_STRONG} ${STYLE_BASE_HEADLESS}`,

  body_idle: `[CHARACTER_DESCRIPTION] Clothing and body pose illustration: body from collar downward only. Standing completely still, arms hanging relaxed and close to body, feet shoulder-width apart, weight evenly balanced. Minimal resting pose. ${VEER_OUTFIT} ${HEADLESS_STRONG} ${STYLE_BASE_HEADLESS}`,

  body_explaining: `[CHARACTER_DESCRIPTION] Clothing and body pose illustration: body from collar downward only. One arm extended forward with open palm facing up in a presenting/explaining gesture, other arm slightly bent at side, body leaning very slightly forward. ${VEER_OUTFIT} ${HEADLESS_STRONG} ${STYLE_BASE_HEADLESS}`,

  // pointing to the side (not directly at camera) to avoid triggering head generation
  body_pointing: `[CHARACTER_DESCRIPTION] Clothing and body pose illustration — BODY FROM COLLAR DOWN, NO HEAD. Body turned 3/4 to the left. Left arm fully extended pointing diagonally to the upper left, index finger extended. Right arm relaxed at side. Weight on right foot, slight forward lean. Body is angled, not facing camera directly. ${VEER_OUTFIT} ${HEADLESS_STRONG} ${STYLE_BASE_HEADLESS}`,
};

// ─── PNG dimension reader (no deps) ──────────────────────────────────────────
function readPngDimensions(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// ─── Load reference images from _references/ folder ──────────────────────────
function loadRefs(refDir: string): Array<{ inlineData: { data: string; mimeType: string } }> {
  const refFolder = path.join(refDir, '_references');
  if (!fs.existsSync(refFolder)) {
    throw new Error(`No _references/ folder found at: ${refFolder}`);
  }
  const files = fs.readdirSync(refFolder)
    .filter(f => /\.(png|jpe?g|webp)$/i.test(f))
    .sort()
    .slice(0, 4);
  if (files.length === 0) throw new Error(`No images in: ${refFolder}`);

  console.log(`  Loaded ${files.length} reference image(s) from ${refFolder}`);
  return files.map(f => {
    const buf = fs.readFileSync(path.join(refFolder, f));
    const mimeType = (buf[0] === 0x89 && buf[1] === 0x50) ? 'image/png' : 'image/jpeg';
    return { inlineData: { data: buf.toString('base64'), mimeType } };
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const charArg = process.argv.find(a => a.startsWith('--character='))?.split('=')[1]
    ?? process.argv[process.argv.indexOf('--character') + 1]
    ?? 'veer';

  const targets = charArg === 'all' ? Object.keys(CHARACTERS) : [charArg];

  if (!isAdcMode) {
    throw new Error('GOOGLE_CLOUD_PROJECT not set — ADC auth required');
  }

  const ai = new GoogleGenAI({ vertexai: true, project: gcpProject, location: gcpLocation } as any);
  console.log(`[HeadlessBodies] Auth: ADC Vertex AI (${gcpProject})`);

  for (const charKey of targets) {
    const char = CHARACTERS[charKey];
    if (!char) {
      console.error(`Unknown character: ${charKey}. Available: ${Object.keys(CHARACTERS).join(', ')}`);
      process.exit(1);
    }

    console.log(`\n[HeadlessBodies] ── ${char.name} ────────────────────────────────────`);

    const outDir = path.join(char.assetsDir, '_headless');
    fs.mkdirSync(outDir, { recursive: true });
    console.log(`  Output dir: ${outDir}`);

    const refParts = loadRefs(char.refDir);
    let nextSlotAt = Date.now();
    let passed = 0, failed = 0;

    for (const [assetName, promptTemplate] of Object.entries(HEADLESS_PROMPTS)) {
      const outPath = path.join(outDir, `${assetName}.png`);

      // Skip if already generated (re-run safe)
      if (fs.existsSync(outPath)) {
        const existing = fs.readFileSync(outPath);
        const dims = readPngDimensions(existing);
        console.log(`  ✓ ${assetName.padEnd(20)} SKIP (exists, ${dims ? `${dims.w}×${dims.h}` : 'unknown dims'})`);
        passed++;
        continue;
      }

      // Rate gate
      const waitMs = Math.max(0, nextSlotAt - Date.now());
      nextSlotAt = Math.max(Date.now(), nextSlotAt) + REQUEST_GAP_MS;
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));

      const prompt = promptTemplate
        .replace('[CHARACTER_DESCRIPTION]', `${char.name}: ${char.description}.`);

      const textInstruction = `Match the character's skin tone and hair from the reference images. Ignore any jacket or layered clothing visible in references — the canonical outfit is a PLAIN NAVY BLUE T-SHIRT ONLY (no jacket).

${prompt}

CRITICAL RULES:
1. NO HEAD. NO FACE. NO NECK. White background replaces the head. The t-shirt collar is the very top of the illustration.
2. OUTFIT: plain navy blue crew-neck t-shirt ONLY — absolutely no jacket, no hoodie, no zip-up. Dark charcoal grey jogger pants. White sneakers.
3. Show full body from collar to feet.`;

      const parts: any[] = [...refParts, { text: textInstruction }];
      let success = false;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: MODEL,
            contents: [{ role: 'user', parts }],
            config: { responseModalities: ['IMAGE', 'TEXT'] } as any,
          });

          const responseParts = response.candidates?.[0]?.content?.parts || [];
          const imgPart = responseParts.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));
          if (!imgPart?.inlineData?.data) throw new Error('No image in response');

          const buf = Buffer.from(imgPart.inlineData.data as string, 'base64');
          if (buf.length < 4096) throw new Error(`Image too small (${(buf.length / 1024).toFixed(1)}KB)`);

          const dims = readPngDimensions(buf);
          fs.writeFileSync(outPath, buf);

          console.log(`  ✓ ${assetName.padEnd(20)} ${dims ? `${dims.w}×${dims.h}` : 'saved'} (${(buf.length / 1024).toFixed(0)}KB)`);
          success = true;
          passed++;
          break;
        } catch (e: any) {
          const msg = e.message?.slice(0, 120) || 'Unknown error';
          const is429 = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Resource exhausted');
          if (attempt < MAX_ATTEMPTS - 1) {
            const delay = is429 ? BACKOFF_429_MS : BACKOFF_BASE_MS * (attempt + 1);
            console.warn(`  ↺ ${assetName} retry ${attempt + 1}/${MAX_ATTEMPTS - 1} in ${(delay / 1000).toFixed(0)}s: ${msg}`);
            await new Promise(r => setTimeout(r, delay));
          } else {
            console.error(`  ✗ ${assetName.padEnd(20)} FAILED after ${MAX_ATTEMPTS} attempts: ${msg}`);
          }
        }
      }

      if (!success) failed++;
    }

    console.log(`\n  [${char.name}] Done: ${passed}/${Object.keys(HEADLESS_PROMPTS).length} generated, ${failed} failed`);
    console.log(`  Inspect visually: ${outDir}`);
    console.log(`  STOP CHECK: verify no faces/heads visible before proceeding to Phase 2`);
  }
}

main().catch(e => { console.error('[HeadlessBodies] Fatal:', e); process.exit(1); });
