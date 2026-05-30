import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from '@google/genai';
import { getKeyForTask, getGeminiKey, type KeyTask } from '../utils/geminiAuth.js';

// Lazy initialization to ensure we catch the latest process.env state
const aiInstances: Record<string, GoogleGenAI> = {};

const getAI = (apiKey: string) => {
  const cacheKey = apiKey || 'default';
  if (!aiInstances[cacheKey]) {
    if (!apiKey) console.warn('[AIService] No Gemini API key available');
    aiInstances[cacheKey] = new GoogleGenAI({ apiKey });
  }
  return aiInstances[cacheKey];
};

const TASK_MODELS: Record<string, string> = {
  'script': 'gemini-2.5-flash',
  'planning': 'gemini-2.5-flash',
  'scenes': 'gemini-2.5-flash',
  'segmentation': 'gemini-2.5-flash',
  'visual_expansion': 'gemini-2.5-flash',
  'world': 'gemini-2.5-flash',
  'image': 'gemini-2.5-flash-image',
  'default': 'gemini-2.5-flash'
};

const TASK_KEY_MAP: Record<string, KeyTask> = {
  'planning':         'script',
  'script':           'script',
  'seo':              'script',
  'world':            'scenes',
  'segmentation':     'scenes',
  'visual_expansion': 'visual',
  'image':            'image',
};

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

export const AIService = {
  generateText: async (prompt: string, options?: any) => {
    const task = options?.task;
    let model = options?.model;
    const maxRetries = 2;
    let retryCount = 0;

    if (!model) {
      model = task && TASK_MODELS[task] ? TASK_MODELS[task] : TASK_MODELS['default'];
    }

    const execute = async (currentModel: string): Promise<string> => {
      const taskKey = (TASK_KEY_MAP[task] ?? 'script') as KeyTask;
      const apiKey = getKeyForTask(taskKey);
      const ai = getAI(apiKey);
      console.log(`[AIService] Task: ${task || 'general'}, model: ${currentModel}, key: ...${apiKey.slice(-4)}`);

      try {
        const isJsonTask = task === 'script' || task === 'planning' || task === 'scenes' || task === 'segmentation' || task === 'world';
        const response = await ai.models.generateContent({
          model: currentModel,
          contents: prompt,
          config: {
            ...(isJsonTask ? { responseMimeType: "application/json" } : {}),
            safetySettings: [
              { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
              { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
              { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
              { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            ]
          }
        });
        const text = response.text || '';
        console.log(`[AIService] Text generation successful. Length: ${text.length}`);
        return text;
      } catch (error: any) {
        const is429 = error?.status === 'RESOURCE_EXHAUSTED' || error?.message?.includes('429');
        const is503 = error?.status === 503 || error?.message?.includes('503') ||
                      error?.message?.includes('UNAVAILABLE') || error?.message?.includes('high demand');

        if ((is429 || is503) && retryCount < maxRetries) {
          retryCount++;
          const backoffDelay = is503 ? 3000 : Math.pow(2, retryCount) * 1000;
          console.warn(`[AIService] ${is503 ? '503 overload' : 'quota hit'} on ${currentModel}. Falling back to gemini-2.5-flash-lite in ${backoffDelay}ms...`);
          await delay(backoffDelay);
          if (currentModel !== 'gemini-2.5-flash-lite') return execute('gemini-2.5-flash-lite');
          throw new Error('429 RESOURCE_EXHAUSTED: AI Quota Exceeded. Please try again in 1 minute.');
        }

        if (is429 || is503) {
          throw new Error('429 RESOURCE_EXHAUSTED: AI Quota Exceeded. Please try again in 1 minute.');
        }

        if (error?.status === 'PERMISSION_DENIED' || error?.message?.includes('403') || error?.message?.includes('400')) {
          console.error('[AIService] RAW ERROR:', JSON.stringify(error, null, 2));
          throw error;
        }

        throw error;
      }
    };

    return execute(model);
  },
  analyzeImage: async (imageBase64: string, prompt: string, options?: any) => {
    const model = options?.model || TASK_MODELS['world'] || 'gemini-2.5-flash';
    console.log(`[AIService] Analyzing image with model: ${model}`);

    try {
      const apiKey = getKeyForTask('scenes');
      const ai = getAI(apiKey);
      const response = await ai.models.generateContent({
        model,
        contents: [
          { role: 'user', parts: [{ text: prompt }, { inlineData: { data: imageBase64, mimeType: 'image/jpeg' }}]}
        ],
        config: options?.json ? { responseMimeType: "application/json" } : undefined
      });
      
      return response.text || '';
    } catch (error: any) {
      console.error('[AIService] analyzeImage error:', error);
      throw error;
    }
  },
  generateImageBase64: async (prompt: string, options?: any): Promise<string> => {
    const isStoryEpisode = options?.isStoryEpisode;
    const isLandscape = !isStoryEpisode && options?.aspectRatio === '16:9';
    const aspectRatio = isLandscape ? '16:9' : '9:16';
    const qualityPrompt = prompt.includes('photorealistic')
      ? prompt
      : `${prompt}, photorealistic, cinematic lighting, sharp focus`;
    const orientationHint = isLandscape ? 'Horizontal 16:9 landscape orientation.' : 'Vertical 9:16 portrait orientation.';
    const finalPrompt = `${qualityPrompt}. ${orientationHint}`;

    // Provider 0: Replicate LoRA (when character has trained LoRA and useLoRA is enabled)
    if (options?.loraModelUrl && process.env.REPLICATE_API_TOKEN) {
      try {
        const triggerWord = (options.loraTriggerWord as string | undefined) || 'CHARACTER';
        const { default: Replicate } = await import('replicate');
        const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
        const output = await replicate.run(
          'black-forest-labs/flux-dev-lora' as `${string}/${string}:${string}`,
          {
            input: {
              prompt: `${triggerWord} ${prompt}`,
              hf_lora: options.loraModelUrl as string,
              lora_scale: 0.85,
              num_inference_steps: 28,
              aspect_ratio: aspectRatio,
            },
          }
        );
        const imageUrl = Array.isArray(output) ? String(output[0]) : String(output);
        if (imageUrl) {
          const loraRes = await fetch(imageUrl);
          if (loraRes.ok) {
            const base64 = Buffer.from(await loraRes.arrayBuffer()).toString('base64');
            console.log('[ImageGen] Replicate LoRA success!');
            return base64;
          }
        }
      } catch (e: any) {
        console.warn('[ImageGen] Replicate LoRA failed:', e.message, '— falling through to Imagen');
      }
    }

    const referenceImageUrl = options?.referenceImageUrl as string | undefined;
    let referenceImageBytes: string | undefined;
    if (referenceImageUrl) {
      try {
        const res = await fetch(referenceImageUrl);
        if (res.ok) referenceImageBytes = Buffer.from(await res.arrayBuffer()).toString('base64');
        console.log('[ImageGen] Reference image loaded for character consistency');
      } catch (e) {
        console.warn('[ImageGen] Could not load reference image:', e);
      }
    }

    // Provider 1: Imagen 4 Fast via AI Studio key (primary - confirmed working)
    let imagenApiKey = '';
    try { imagenApiKey = getKeyForTask('image'); } catch { /* falls through to next provider */ }
    if (imagenApiKey) {
      try {
        const imagenModel = options?.quality === '4k' ? 'imagen-4.0-generate-001' : 'imagen-4.0-fast-generate-001';
        console.log(`[ImageGen] Trying Imagen 4 (${imagenModel})...`);
        const { GoogleGenAI } = await import('@google/genai');
        const imagenAI = new GoogleGenAI({ apiKey: imagenApiKey });
        const imagenResponse = await imagenAI.models.generateImages({
          model: imagenModel,
          prompt: finalPrompt,
          config: {
            numberOfImages: 1,
            aspectRatio,
            ...(referenceImageBytes ? {
              referenceImages: [{
                referenceType: 'REFERENCE_TYPE_STYLE',
                referenceImage: { bytesBase64Encoded: referenceImageBytes }
              }]
            } : {})
          }
        });
        const bytes = imagenResponse.generatedImages?.[0]?.image?.imageBytes;
        if (!bytes) throw new Error('No image bytes');
        const base64 = bytes as string;
        console.log('[ImageGen] Imagen 4 Fast success! Size:', Math.round(base64.length * 0.75 / 1024), 'KB');
        return base64;
      } catch (e: any) {
        console.warn('[ImageGen] Imagen 4 Fast failed:', e.message, 'status:', e.status);
      }
    }

    // Provider 2: Fal.ai FLUX.1 schnell
    if (process.env.FAL_API_KEY) {
      try {
        console.log('[ImageGen] FAL_API_KEY present:', !!process.env.FAL_API_KEY, 'prefix:', process.env.FAL_API_KEY?.substring(0, 8));
        console.log('[ImageGen] Trying Fal.ai FLUX.1...');
        const falModule = await import('@fal-ai/client');
        const falClient = (falModule as any).fal || (falModule as any).default || falModule;
        falClient.config({ credentials: process.env.FAL_API_KEY });
        const result = await falClient.subscribe('fal-ai/flux/schnell', {
          input: {
            prompt: finalPrompt,
            image_size: isLandscape ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 },
            num_images: 1,
            num_inference_steps: 4,
            enable_safety_checker: false
          }
        }) as any;
        const imageUrl = result.data?.images?.[0]?.url
          || result.images?.[0]?.url;
        if (!imageUrl) throw new Error('No image URL');
        const res = await fetch(imageUrl);
        if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
        const base64 = Buffer.from(await res.arrayBuffer()).toString('base64');
        console.log('[ImageGen] Fal.ai success! Size:', Math.round(base64.length * 0.75 / 1024), 'KB');
        return base64;
      } catch (e: any) {
        console.warn('[ImageGen] Fal.ai failed:', e.message, 'status:', e.status, 'body:', JSON.stringify(e.body || e.response || {}));
      }
    }

    // Provider 3: Together AI FLUX.1 schnell-Free
    if (process.env.TOGETHER_API_KEY) {
      try {
        console.log('[ImageGen] Trying Together AI...');
        const togetherRes = await fetch(
          'https://api.together.xyz/v1/images/generations',
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.TOGETHER_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'black-forest-labs/FLUX.1-schnell-Free',
              prompt: finalPrompt,
              width: isLandscape ? 1920 : 1080,
              height: isLandscape ? 1080 : 1920,
              steps: 4,
              n: 1,
              response_format: 'b64_json'
            })
          }
        );
        const togetherData = await togetherRes.json();
        if (!togetherRes.ok) throw new Error(togetherData.error?.message || `HTTP ${togetherRes.status}`);
        const base64 = togetherData.data?.[0]?.b64_json;
        if (!base64) throw new Error('No b64_json in response');
        console.log('[ImageGen] Together AI success! Size:', Math.round(base64.length * 0.75 / 1024), 'KB');
        return base64;
      } catch (e: any) {
        console.warn('[ImageGen] Together AI failed:', e.message);
      }
    }

    // Provider 4: Gemini 2.5 flash image (when quota available)
    let geminiImageKey = '';
    try { geminiImageKey = getKeyForTask('image'); } catch { /* no key configured */ }
    if (geminiImageKey) {
      try {
        console.log('[ImageGen] Trying Gemini 2.5 flash image...');
        const ai = getAI(geminiImageKey);
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash-image',
          contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
          config: { responseModalities: ['TEXT', 'IMAGE'] }
        });
        const parts = response.candidates?.[0]?.content?.parts;
        const imagePart = parts?.find((p: any) => p.inlineData);
        if (!imagePart?.inlineData?.data) throw new Error('No image in response');
        console.log('[ImageGen] Gemini success!');
        return imagePart.inlineData.data as string;
      } catch (e: any) {
        console.warn('[ImageGen] Gemini failed:', e.message);
      }
    }

    // Provider 5: Picsum (always works)
    throw new Error('All AI providers failed - use Picsum fallback');
  },
  clearQuotaFlags: () => {}
};
