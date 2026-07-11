/**
 * Traces the live image-generation provider chain: which provider is called,
 * with what model/region/payload, which errors are raised, and where it falls back.
 *
 * Run: npx cross-env DEBUG_IMAGEGEN=1 tsx scripts/debug_image_routing.ts
 */
import 'dotenv/config';
import * as fs from 'fs';
import { AIService } from '../src/services/aiService.js';

const PROMPT = 'A single glowing neural network node floating in dark blue space, cinematic';

async function main() {
  console.log('=== ENV (names + shape only) ===');
  console.log(JSON.stringify({
    GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT ? 'set' : 'unset',
    GOOGLE_CLOUD_LOCATION: process.env.GOOGLE_CLOUD_LOCATION ?? 'unset',
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS ? 'set' : 'unset',
    VERTEX_IMAGEN_MODEL: process.env.VERTEX_IMAGEN_MODEL ?? 'unset',
    VERTEX_AI_LOCATION: process.env.VERTEX_AI_LOCATION ?? 'unset',
    GEMINI_KEY_IMAGE: process.env.GEMINI_KEY_IMAGE ? 'set' : 'unset',
    FAL_API_KEY: process.env.FAL_API_KEY ? 'set' : 'unset',
    TOGETHER_API_KEY: process.env.TOGETHER_API_KEY ? 'set' : 'unset',
    REPLICATE_API_TOKEN: process.env.REPLICATE_API_TOKEN ? 'set' : 'unset',
  }, null, 2));

  console.log('\n=== CALL: generateImageBase64 (no reference, generic track) ===');
  const t0 = Date.now();
  try {
    const b64 = await AIService.generateImageBase64(PROMPT, { task: 'image', aspectRatio: '9:16' });
    fs.mkdirSync('outputs', { recursive: true });
    const out = 'outputs/debug_image_routing.jpg';
    fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    console.log(`\nRESULT: success in ${Date.now() - t0}ms → ${out} (${Math.round(b64.length * 0.75 / 1024)}KB)`);
  } catch (e: any) {
    console.log(`\nRESULT: ALL PROVIDERS FAILED in ${Date.now() - t0}ms — ${e.message}`);
    console.log('(assetService would now write a Picsum stock photo in place of the AI image)');
  }

  // Character-consistency path: Imagen takes no reference input, so this must skip
  // Vertex Imagen and land on the Gemini multimodal image model instead.
  const refPath = process.argv[2];
  if (!refPath) {
    console.log('\n(pass a reference image path as argv[2] to also trace the character-anchor path)');
    return;
  }
  console.log(`\n=== CALL: generateImageBase64 (WITH reference → must skip Imagen) ===`);
  const t1 = Date.now();
  try {
    const b64 = await AIService.generateImageBase64(PROMPT, {
      task: 'image', aspectRatio: '9:16', referenceImageUrl: refPath,
    });
    const out = 'outputs/debug_image_routing_ref.jpg';
    fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    console.log(`\nRESULT: success in ${Date.now() - t1}ms → ${out} (${Math.round(b64.length * 0.75 / 1024)}KB)`);
  } catch (e: any) {
    console.log(`\nRESULT: ALL PROVIDERS FAILED in ${Date.now() - t1}ms — ${e.message}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
