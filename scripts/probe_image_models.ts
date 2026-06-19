/**
 * Probes which Gemini image generation models work under the current auth config.
 * Tests ADC (Vertex AI) first, then API key fallback.
 * Run: npx tsx scripts/probe_image_models.ts
 */
import 'dotenv/config';
import * as fs from 'fs';
import { GoogleGenAI } from '@google/genai';

const isAdcMode = !!process.env.GOOGLE_CLOUD_PROJECT;
const gcpProject = process.env.GOOGLE_CLOUD_PROJECT || '';
const gcpLocation = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const apiKey = process.env.GEMINI_KEY_IMAGE || process.env.GEMINI_KEY_VISUAL || '';

const PROMPT = 'A young South Asian man, flat colour graphic novel illustration style, clean bold outlines, NOT photorealistic, full body standing neutral pose, pure white background.';

interface ProbeResult {
  model: string;
  auth: string;
  ok: boolean;
  sizeKB?: number;
  error?: string;
  ms?: number;
}

async function probeModel(model: string, useAdc: boolean): Promise<ProbeResult> {
  const auth = useAdc ? `ADC(${gcpProject})` : 'API-key';
  const t0 = Date.now();
  try {
    const ai = useAdc
      ? new GoogleGenAI({ vertexai: true, project: gcpProject, location: gcpLocation } as any)
      : new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
      config: { responseModalities: ['IMAGE', 'TEXT'] } as any,
    });

    const parts = response.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));
    if (!imgPart?.inlineData?.data) throw new Error('No image data in response');

    const buf = Buffer.from(imgPart.inlineData.data as string, 'base64');
    const sizeKB = Math.round(buf.length / 1024);
    if (sizeKB < 4) throw new Error(`Image too small: ${sizeKB}KB`);

    // Save first success
    const outPath = `outputs/probe_${model.replace(/[^a-z0-9]/g, '_')}.png`;
    fs.writeFileSync(outPath, buf);
    console.log(`  ✓ ${model} [${auth}] — ${sizeKB}KB in ${Date.now() - t0}ms → ${outPath}`);
    return { model, auth, ok: true, sizeKB, ms: Date.now() - t0 };
  } catch (e: any) {
    const err = e.message?.slice(0, 120) || 'unknown';
    const status = e.status || e.httpError?.statusCode || '';
    const msg = status ? `${status}: ${err}` : err;
    console.log(`  ✗ ${model} [${auth}] — ${msg}`);
    return { model, auth, ok: false, error: msg, ms: Date.now() - t0 };
  }
}

async function main() {
  fs.mkdirSync('outputs', { recursive: true });
  console.log(`Auth mode: ${isAdcMode ? `ADC (${gcpProject} / ${gcpLocation})` : 'API key'}`);
  console.log(`API key present: ${!!apiKey}`);
  console.log('');
  console.log('Probing models...\n');

  const candidates: Array<{ model: string; useAdc: boolean }> = [];

  // ADC candidates (Vertex AI)
  if (isAdcMode) {
    candidates.push(
      { model: 'gemini-2.5-flash-image', useAdc: true },
      { model: 'gemini-2.0-flash-exp', useAdc: true },
      { model: 'gemini-2.0-flash-preview-image-generation', useAdc: true },
      { model: 'imagen-3.0-generate-001', useAdc: true },
    );
  }

  // API key candidates (AI Studio)
  if (apiKey) {
    candidates.push(
      { model: 'gemini-2.0-flash-preview-image-generation', useAdc: false },
      { model: 'gemini-2.5-flash-image', useAdc: false },
    );
  }

  const results: ProbeResult[] = [];
  for (const { model, useAdc } of candidates) {
    const r = await probeModel(model, useAdc);
    results.push(r);
    if (r.ok) {
      console.log(`\n✅ WINNER: ${model} [${r.auth}] — use this in characterAssetService.ts\n`);
      break; // stop at first success
    }
  }

  console.log('\n─── Summary ───');
  for (const r of results) {
    const tag = r.ok ? '✓' : '✗';
    console.log(`  ${tag} ${r.model} [${r.auth}]${r.ok ? ` ${r.sizeKB}KB` : ` — ${r.error}`}`);
  }

  const winner = results.find(r => r.ok);
  if (!winner) {
    console.error('\n❌ ALL MODELS FAILED — check GCP project allowlist and API keys');
    process.exit(1);
  }
  console.log(`\nCONCLUSION: use model="${winner.model}" auth=${winner.auth}`);
}

main().catch(e => { console.error(e); process.exit(1); });
