import * as fs from 'fs';
import * as path from 'path';
import { Visual } from '../models/scene.js';
import { getFromCache, saveToCache } from './cacheService.js';
import { AIService } from './aiService.js';
import { hashCode } from '../utils/hash.js';

async function generateImageFromGemini(prompt: string, outputPath: string): Promise<string> {
  const base64Data = await AIService.generateImageBase64(prompt, { task: 'image' });

  const buffer = Buffer.from(base64Data, 'base64');
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
  await fs.promises.writeFile(outputPath, buffer);
  
  return outputPath;
}

async function simulateAssetCreation(filePath: string, assetType: string, visual: Visual) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }

  if (assetType === 'ai_image' || assetType === 'stock') {
    const cleanPrompt = visual.prompt.replace(/\[.*?\]/g, '').trim();
    const seed = Math.abs(hashCode(cleanPrompt)) % 1000;
    const url = `https://picsum.photos/seed/${seed}/1080/1920`;
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        await fs.promises.writeFile(filePath, Buffer.from(await res.arrayBuffer()));
        console.log(`[Asset Engine] Picsum fallback succeeded for: ${visual.visual_id}`);
        return;
      }
    } catch (e) {
      console.warn(`[Asset Engine] Picsum fallback failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  console.error('[Asset Engine] All image fallbacks exhausted for:', visual.visual_id);
  await fs.promises.writeFile(filePath, 'simulated'.padEnd(101, '.'));
}

export async function generateAsset(visual: Visual, assetHash: string, mode: string): Promise<string> {
  const cachedPath = await getFromCache(assetHash);
  
  if (cachedPath) {
    const ext = path.extname(cachedPath).toLowerCase();
    if (['.jpg', '.png', '.mp4'].includes(ext)) {
      try {
        const stats = await fs.promises.stat(cachedPath);
        if (stats.size > 100) {
          console.log(`[Asset Engine] Cache hit for asset: ${assetHash} (${visual.asset_type})`);
          return cachedPath;
        }
      } catch (err) {}
    }
    console.warn(`[Asset Engine] Cached file invalid, regenerating... Hash: ${assetHash}`);
  }

  if (visual.prompt.includes('FORCE_FAILURE')) {
    throw new Error(`[Asset Engine] Forced failure for testing: ${visual.visual_id}`);
  }

  if (visual.asset_type === 'text_card') {
    const words = visual.prompt.split(/\s+/);
    const maxWords = mode === 'shorts' ? 4 : 8;
    visual.prompt = words.slice(0, maxWords).join(' ').toUpperCase();
  }

  console.log(`[Asset Engine] Generating ${visual.asset_type}... Hash: ${assetHash}`);
  const ext = visual.asset_type === 'ai_image' || visual.asset_type === 'stock' ? '.jpg' : '.png';
  const tempFile = path.join(process.cwd(), 'temp', `${assetHash}${ext}`);
  
  if (visual.asset_type === 'ai_image') {
    try {
      console.log(`[Asset Engine] Attempting Gemini image generation for: ${visual.visual_id}`);
      await generateImageFromGemini(visual.prompt, tempFile);
      console.log(`[Asset Engine] Gemini image generation successful for: ${visual.visual_id}`);
    } catch (error) {
      console.warn(`[Asset Engine] Gemini image generation failed for ${visual.visual_id}, falling back to simulation: ${error instanceof Error ? error.message : String(error)}`);
      try {
        await simulateAssetCreation(tempFile, visual.asset_type, visual);
        console.log(`[Asset Engine] Asset simulation successful for: ${visual.visual_id}`);
      } catch (simError) {
        console.error(`[Asset Engine] Asset simulation FAILED for ${visual.visual_id}:`, simError);
        throw simError;
      }
    }
  } else {
    console.log(`[Asset Engine] Using simulation for non-AI asset type: ${visual.asset_type}`);
    await simulateAssetCreation(tempFile, visual.asset_type, visual);
  }
  
  const stats = await fs.promises.stat(tempFile);
  if (stats.size < 1000) {
    throw new Error(`[Asset Engine] Generated asset is suspiciously small (${stats.size} bytes) for visual ${visual.visual_id} — likely a placeholder or corrupt file`);
  }

  await saveToCache(assetHash, tempFile);
  
  const finalCachedPath = await getFromCache(assetHash);
  if (!finalCachedPath) {
    throw new Error(`[Asset Engine] Failed to retrieve asset from cache after saving.`);
  }
  
  return finalCachedPath;
}
