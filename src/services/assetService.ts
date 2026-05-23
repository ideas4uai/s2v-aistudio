import * as fs from 'fs';
import * as path from 'path';
import { Visual } from '../models/scene.js';
import { getFromCache, saveToCache } from './cacheService.js';
import { AIService } from './aiService.js';
import ffmpegStatic from 'ffmpeg-static';
import { getSafeGeminiKey } from '../utils/geminiAuth.js';

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
    const encodedPrompt = encodeURIComponent(visual.prompt.substring(0, 500));
    const keywords = visual.prompt.split(' ').slice(0, 3).join(',');

    // 1. Pollinations primary
    try {
      console.log(`[Asset Engine] Trying Pollinations (primary) for: ${visual.visual_id}`);
      const res = await fetch(
        `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1080&height=1920`,
        { signal: AbortSignal.timeout(60000) }
      );
      if (res.ok) {
        await fs.promises.writeFile(filePath, Buffer.from(await res.arrayBuffer()));
        console.log(`[Asset Engine] Pollinations primary succeeded for: ${visual.visual_id}`);
        return;
      }
      console.warn(`[Asset Engine] Pollinations primary returned HTTP ${res.status} for: ${visual.visual_id}`);
    } catch (e) {
      console.warn(`[Asset Engine] Pollinations primary failed: ${e instanceof Error ? e.message : e}`);
    }

    // 2. Pollinations retry with random seed after 2s delay
    await new Promise(r => setTimeout(r, 2000));
    try {
      const seed = Math.floor(Math.random() * 1_000_000);
      console.log(`[Asset Engine] Trying Pollinations (seed=${seed}) for: ${visual.visual_id}`);
      const res = await fetch(
        `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1080&height=1920&seed=${seed}`,
        { signal: AbortSignal.timeout(60000) }
      );
      if (res.ok) {
        await fs.promises.writeFile(filePath, Buffer.from(await res.arrayBuffer()));
        console.log(`[Asset Engine] Pollinations retry succeeded for: ${visual.visual_id}`);
        return;
      }
      console.warn(`[Asset Engine] Pollinations retry returned HTTP ${res.status} for: ${visual.visual_id}`);
    } catch (e) {
      console.warn(`[Asset Engine] Pollinations retry failed: ${e instanceof Error ? e.message : e}`);
    }

    // 3. Unsplash keyword fallback
    try {
      console.log(`[Asset Engine] Trying Unsplash fallback (keywords: ${keywords}) for: ${visual.visual_id}`);
      const res = await fetch(
        `https://source.unsplash.com/1080x1920/?${encodeURIComponent(keywords)}`,
        { signal: AbortSignal.timeout(15000) }
      );
      if (res.ok) {
        await fs.promises.writeFile(filePath, Buffer.from(await res.arrayBuffer()));
        console.log(`[Asset Engine] Unsplash fallback succeeded for: ${visual.visual_id}`);
        return;
      }
    } catch (e) {
      console.warn(`[Asset Engine] Unsplash fallback failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Last resort: ffmpeg solid color (avoids blank placeholder screens)
  try {
    const { execSync } = await import('child_process');
    const ffmpegPath = ffmpegStatic || 'ffmpeg';
    const colors = ['darkblue', 'darkgreen', 'maroon', 'indigo', 'darkslategrey', 'navy', 'purple'];
    const colorIndex = Math.abs(filePath.split('').reduce((a: number, b: string) => { a = ((a << 5) - a) + b.charCodeAt(0); return a & a; }, 0)) % colors.length;
    execSync(`"${ffmpegPath}" -f lavfi -i color=c=${colors[colorIndex]}:s=1080x1920:d=1 -vframes 1 "${filePath}" -y`);
    console.log(`[Asset Engine] Solid color placeholder used for: ${visual.visual_id}`);
  } catch (error) {
    console.error('[Asset Engine] All image fallbacks exhausted:', error);
    await fs.promises.writeFile(filePath, 'simulated'.padEnd(101, '.'));
  }
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
