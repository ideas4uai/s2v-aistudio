import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { FirestoreService } from '../server/db/firestore.js';
import type { AssetResult, AssetPackResult } from '../types/character.js';

export type { AssetResult, AssetPackResult };

// ─── Style base shared across all prompts ──────────────────────────────────
const STYLE_BASE = `South Asian graphic novel flat colour illustration style. Clean bold outlines. NOT photorealistic. NOT realistic. Pure white background #FFFFFF only. Isolated character, no environment, no background elements, no shadows on floor.`;

// ─── 25 asset prompt templates ─────────────────────────────────────────────
export const ASSET_PROMPTS: Record<string, string> = {
  // ── Body poses (4) ──────────────────────────────────────────────────────
  body_neutral: `[CHARACTER_DESCRIPTION] Full body character illustration. Head to toe fully visible. Standing relaxed, arms naturally at sides, weight balanced, facing forward, neutral calm expression. ${STYLE_BASE}`,
  body_talking: `[CHARACTER_DESCRIPTION] Full body character illustration. Head to toe fully visible. Slight forward lean, one hand raised palm-up at chest height, other arm relaxed, mouth slightly open mid-speech, engaged expression. ${STYLE_BASE}`,
  body_thinking: `[CHARACTER_DESCRIPTION] Full body character illustration. Head to toe fully visible. One hand resting lightly on chin, other arm crossed at waist, gaze looking up-left, thoughtful curious expression. ${STYLE_BASE}`,
  body_surprised: `[CHARACTER_DESCRIPTION] Full body character illustration. Head to toe fully visible. Slight lean backward, both hands raised at chest height palms facing outward, eyebrows raised high, eyes wide open, mouth open in surprise. ${STYLE_BASE}`,

  // ── Mouth / lip-sync portraits (6) ──────────────────────────────────────
  mouth_closed: `[CHARACTER_DESCRIPTION] Close-up head and shoulders portrait only. Mouth completely closed, lips relaxed, neutral calm resting expression. ${STYLE_BASE}`,
  mouth_open_a: `[CHARACTER_DESCRIPTION] Close-up head and shoulders portrait only. Mouth wide open in AH vowel shape, jaw dropped low, tongue visible at rest, speaking expression. ${STYLE_BASE}`,
  mouth_open_e: `[CHARACTER_DESCRIPTION] Close-up head and shoulders portrait only. Mouth open in EH vowel shape, medium vertical opening, corners slightly drawn back, mid-speech. ${STYLE_BASE}`,
  mouth_open_o: `[CHARACTER_DESCRIPTION] Close-up head and shoulders portrait only. Mouth open in rounded OH vowel shape, lips forming a circle, speaking. ${STYLE_BASE}`,
  mouth_smile: `[CHARACTER_DESCRIPTION] Close-up head and shoulders portrait only. Closed gentle smile, lips softly curved upward, warm friendly expression, mouth closed. ${STYLE_BASE}`,
  mouth_smile_open: `[CHARACTER_DESCRIPTION] Close-up head and shoulders portrait only. Open happy smile, upper teeth visible, joyful expression, actively talking and laughing. ${STYLE_BASE}`,

  // ── Eye states (4) ──────────────────────────────────────────────────────
  eyes_open: `[CHARACTER_DESCRIPTION] Close-up head and shoulders portrait only. Eyes fully open, alert relaxed expression, looking directly forward. ${STYLE_BASE}`,
  eyes_half: `[CHARACTER_DESCRIPTION] Close-up head and shoulders portrait only. Eyes half-closed, eyelids drooping halfway, heavy-lidded tired or skeptical expression. ${STYLE_BASE}`,
  eyes_closed: `[CHARACTER_DESCRIPTION] Close-up head and shoulders portrait only. Eyes fully closed in mid-blink, both eyelids completely shut, natural blink frame. ${STYLE_BASE}`,
  eyes_wide: `[CHARACTER_DESCRIPTION] Close-up head and shoulders portrait only. Eyes very wide open, pupils large, shocked or highly surprised expression, eyebrows raised. ${STYLE_BASE}`,

  // ── Brow states (3) ─────────────────────────────────────────────────────
  brow_neutral: `[CHARACTER_DESCRIPTION] Close-up head and shoulders portrait only. Eyebrows in completely relaxed neutral position, calm unbothered resting expression. ${STYLE_BASE}`,
  brow_raised: `[CHARACTER_DESCRIPTION] Close-up head and shoulders portrait only. Both eyebrows raised high, curious or pleasantly surprised expression, forehead slightly wrinkled. ${STYLE_BASE}`,
  brow_furrowed: `[CHARACTER_DESCRIPTION] Close-up head and shoulders portrait only. Both eyebrows pulled together and furrowed downward toward nose, worried or angry expression, slight frown. ${STYLE_BASE}`,

  // ── Walk cycle frames (8) ────────────────────────────────────────────────
  walk_01: `[CHARACTER_DESCRIPTION] Full body walking animation frame 1 of 8. Left foot striking the ground (left foot forward contact), right foot behind pushing off, arms swinging — right arm forward left arm back, 3/4 front view walking. ${STYLE_BASE}`,
  walk_02: `[CHARACTER_DESCRIPTION] Full body walking animation frame 2 of 8. Weight shifting forward onto left foot, right leg beginning to swing forward past the body, transitional mid-stride. ${STYLE_BASE}`,
  walk_03: `[CHARACTER_DESCRIPTION] Full body walking animation frame 3 of 8. Passing position — both feet close together, right leg swinging through and rising, body at full upright height. ${STYLE_BASE}`,
  walk_04: `[CHARACTER_DESCRIPTION] Full body walking animation frame 4 of 8. Right foot striking the ground (right foot forward contact), left foot behind, arms swinging — left arm forward right arm back. Mirror image of frame 1. ${STYLE_BASE}`,
  walk_05: `[CHARACTER_DESCRIPTION] Full body walking animation frame 5 of 8. Weight shifting forward onto right foot, left leg beginning to swing forward past the body, transitional mid-stride. ${STYLE_BASE}`,
  walk_06: `[CHARACTER_DESCRIPTION] Full body walking animation frame 6 of 8. Passing position — both feet close together, left leg swinging through and rising, body at full upright height. Mirror of frame 3. ${STYLE_BASE}`,
  walk_07: `[CHARACTER_DESCRIPTION] Full body walking animation frame 7 of 8. Left foot almost making ground contact, right foot pushing off, heel-strike imminent. ${STYLE_BASE}`,
  walk_08: `[CHARACTER_DESCRIPTION] Full body walking animation frame 8 of 8. Final frame of stride cycle — completes the loop seamlessly back to frame 1. ${STYLE_BASE}`,
};

export const ASSET_NAMES = Object.keys(ASSET_PROMPTS);

// ─── PNG dimension reader (no external deps) ───────────────────────────────
function readPngDimensions(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 24) return null;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isPng) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// ─── Lightweight image validation ──────────────────────────────────────────
function validateImageBuffer(buf: Buffer, assetName: string): string | null {
  const sizeKB = buf.length / 1024;
  if (sizeKB < 4) return `Image too small (${sizeKB.toFixed(1)}KB) — likely blank or failed`;

  const dims = readPngDimensions(buf);
  if (dims && (dims.w < 256 || dims.h < 256)) {
    return `Dimensions too small: ${dims.w}×${dims.h} (minimum 256×256)`;
  }
  return null;
}

// ─── Core generation function ───────────────────────────────────────────────
export async function generateAssetPack(
  characterId: string,
  characterName: string,
  characterDescription: string,
  referenceImages: string[],   // 1-4 Supabase or data URLs
  style = 'flat_colour_anime'
): Promise<AssetPackResult> {
  const startTime = Date.now();

  // Ensure local output dir
  const charDir = path.join(process.cwd(), 'assets', 'characters', characterId);
  fs.mkdirSync(charDir, { recursive: true });

  // ── Load reference images as inline parts (up to 4) ──────────────────────
  const refParts: Array<{ inlineData: { data: string; mimeType: string } }> = [];
  for (const url of referenceImages.slice(0, 4)) {
    try {
      let data: string;
      let mimeType: string;

      if (url.startsWith('data:')) {
        // Already base64 data URL
        const [header, b64] = url.split(',');
        data = b64;
        mimeType = header.split(':')[1].split(';')[0];
      } else {
        const res = await fetch(url);
        if (!res.ok) { console.warn('[AssetPack] Could not fetch ref image:', url.slice(-60)); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        data = buf.toString('base64');
        mimeType = url.includes('.png') ? 'image/png' : 'image/jpeg';
      }
      refParts.push({ inlineData: { data, mimeType } });
      console.log('[AssetPack] Loaded reference image:', url.slice(-50));
    } catch (e: any) {
      console.warn('[AssetPack] Ref load failed:', e.message);
    }
  }

  if (refParts.length === 0) {
    console.warn('[AssetPack] No reference images loaded — generation may have poor consistency');
  }

  // ── Setup Gemini client — always AI Studio (API key), never Vertex AI ADC ──
  // Vertex AI requires allowlist access for image gen models; AI Studio does not.
  const apiKey = process.env.GEMINI_KEY_IMAGE || process.env.GEMINI_KEY_VISUAL || '';
  if (!apiKey) throw new Error('[AssetPack] GEMINI_KEY_IMAGE or GEMINI_KEY_VISUAL must be set');
  const ai = new GoogleGenAI({ apiKey });

  const styleInstruction = style === 'flat_colour_anime'
    ? 'South Asian graphic novel flat colour illustration style, clean bold outlines, NOT photorealistic'
    : style;

  // ── Generate all 25 assets in parallel ───────────────────────────────────
  console.log(`[AssetPack] Starting generation of ${ASSET_NAMES.length} assets for "${characterName}" (${refParts.length} ref images)`);

  const settled = await Promise.allSettled(
    ASSET_NAMES.map(async (assetName): Promise<AssetResult> => {
      const rawPrompt = ASSET_PROMPTS[assetName]
        .replace('[CHARACTER_DESCRIPTION]', `${characterName}: ${characterDescription}.`)
        .replace('South Asian graphic novel flat colour illustration style', styleInstruction);

      const textInstruction = `Match this exact character precisely. ${rawPrompt}

CRITICAL: Keep the EXACT SAME face, skin tone, hair colour, hair style, and outfit as shown in the reference images. Only change the pose and expression as specified. Character name: ${characterName}.`;

      const parts: any[] = [...refParts, { text: textInstruction }];

      let lastError = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: 'gemini-2.0-flash-preview-image-generation',
            contents: [{ role: 'user', parts }],
            config: { responseModalities: ['IMAGE', 'TEXT'] } as any,
          });

          const responseParts = response.candidates?.[0]?.content?.parts || [];
          const imgPart = responseParts.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));
          if (!imgPart?.inlineData?.data) throw new Error('No image data in response');

          const buf = Buffer.from(imgPart.inlineData.data as string, 'base64');
          const validationError = validateImageBuffer(buf, assetName);
          if (validationError) throw new Error(validationError);

          // Save locally as PNG (PIL reads by content, extension is for tooling)
          const localPath = path.join(charDir, `${assetName}.png`);
          fs.writeFileSync(localPath, buf);

          // Upload to Supabase: projects/{characterId}/parts/{assetName}.png
          const supabaseUrl = await FirestoreService.uploadAsset(
            characterId,
            `parts/${assetName}.png`,
            buf,
            'image/png'
          );

          console.log(`[AssetPack] ✓ ${assetName.padEnd(18)} ${Math.round(buf.length / 1024)}KB → ${supabaseUrl.slice(-40)}`);
          return { assetName, status: 'success', localPath, supabaseUrl };
        } catch (e: any) {
          lastError = e.message?.slice(0, 200) || 'Unknown error';
          if (attempt < 1) await new Promise(r => setTimeout(r, 3000));
        }
      }

      console.warn(`[AssetPack] ✗ ${assetName}: ${lastError}`);
      return { assetName, status: 'failed', error: lastError };
    })
  );

  const results: AssetResult[] = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { assetName: ASSET_NAMES[i], status: 'failed' as const, error: (s as PromiseRejectedResult).reason?.message }
  );

  const succeeded = results.filter(r => r.status === 'success').length;
  const timeTakenMs = Date.now() - startTime;

  console.log(`[AssetPack] ─── ${succeeded}/${results.length} generated in ${Math.round(timeTakenMs / 1000)}s ───`);
  if (succeeded < results.length) {
    console.warn('[AssetPack] Failed:', results.filter(r => r.status === 'failed').map(r => r.assetName).join(', '));
  }

  return {
    characterId,
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
    timeTakenMs,
  };
}

// ─── Regenerate a single asset ─────────────────────────────────────────────
export async function regenerateAsset(
  characterId: string,
  characterName: string,
  characterDescription: string,
  assetName: string,
  referenceImages: string[],
  style = 'flat_colour_anime'
): Promise<AssetResult> {
  const pack = await generateAssetPack(
    characterId, characterName, characterDescription,
    referenceImages, style
  );
  return pack.results.find(r => r.assetName === assetName)
    ?? { assetName, status: 'failed', error: 'Asset not found in result' };
}
