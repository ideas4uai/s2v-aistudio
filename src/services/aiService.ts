import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from '@google/genai';
import { getKeyForTask, getGeminiKey, type KeyTask } from '../utils/geminiAuth.js';
import { loadImageAsBase64 } from '../utils/imageRef.js';

const isAdcMode = !!process.env.GOOGLE_CLOUD_PROJECT;
const gcpProject = process.env.GOOGLE_CLOUD_PROJECT || '';
const gcpLocation = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

console.log(
  isAdcMode
    ? `[STARTUP] Auth mode: ADC (Vertex AI) project: ${gcpProject}`
    : '[STARTUP] Auth mode: API Keys'
);

const aiInstances: Record<string, GoogleGenAI> = {};

const getAI = (apiKey: string) => {
  if (isAdcMode) {
    if (!aiInstances['adc']) {
      aiInstances['adc'] = new GoogleGenAI(
        { vertexai: true, project: gcpProject, location: gcpLocation } as any
      );
    }
    return aiInstances['adc'];
  }
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

// Gemini's multimodal image model — verified working on this project. Used for the
// reference-image (character consistency) path, which Imagen cannot serve.
//
// This is also the model that serves EVERY image on this project: its publisher-model
// list contains no Imagen at all, so the Vertex Imagen attempt always 404s. Verified
// to honour imageConfig.aspectRatio (16:9 -> 1344x768). `gemini-3-pro-image` is listed
// for the project but still 404s on request, so it is not used.
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

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

// Image-provider tracing. Set DEBUG_IMAGEGEN=1 to see which provider is tried,
// with what model/region/payload shape, and why each one falls through.
const DEBUG_IMAGEGEN = process.env.DEBUG_IMAGEGEN === '1';

const dbgCall = (provider: string, detail: Record<string, unknown>) => {
  if (!DEBUG_IMAGEGEN) return;
  console.log(`[ImageGen:DEBUG] → CALL ${provider} ${JSON.stringify(detail)}`);
};

const dbgFail = (provider: string, e: any, nextProvider: string) => {
  if (!DEBUG_IMAGEGEN) return;
  console.log(`[ImageGen:DEBUG] ✗ FAIL ${provider} ${JSON.stringify({
    errorClass: e?.constructor?.name ?? typeof e,
    status: e?.status ?? e?.httpError?.statusCode ?? null,
    code: e?.code ?? null,
    message: String(e?.message ?? e).slice(0, 400),
    fallbackTriggered: true,
    nextProvider,
  })}`);
};

const dbgOk = (provider: string, model: string, base64: string) => {
  if (!DEBUG_IMAGEGEN) return;
  console.log(`[ImageGen:DEBUG] ✓ OK ${provider} ${JSON.stringify({
    model, sizeKB: Math.round(base64.length * 0.75 / 1024), fallbackTriggered: false,
  })}`);
};

// Circuit breaker for dead providers: 401/402/403 (bad key, out of credits,
// forbidden) fails every call for the rest of the process, so stop walking that
// rung after the first one. In-memory only by design — a restart retries, since
// credits may have been topped up. 429/5xx never trip it (those recover).
const deadProviders = new Set<string>();

const providerDead = (provider: string): boolean => {
  if (!deadProviders.has(provider)) return false;
  console.log(`[AIService] Provider ${provider} skipped — circuit open`);
  return true;
};

const tripBreakerIfDead = (provider: string, e: any) => {
  const status = e?.status ?? e?.response?.status ?? e?.httpError?.statusCode;
  if (status !== 401 && status !== 402 && status !== 403) return;
  if (deadProviders.has(provider)) return;
  deadProviders.add(provider);
  console.warn(`[AIService] Provider ${provider} circuit-opened (status ${status}) — skipping for this session`);
};

async function generateImageWithLoRA(
  prompt: string,
  loraModelUrl: string,
  triggerWord: string,
  aspectRatio: string
): Promise<string | null> {
  try {
    const replicateToken = process.env.REPLICATE_API_TOKEN;
    if (!replicateToken) return null;

    console.log('[LoRA] Model string:', loraModelUrl);

    // Reject stale delivery URLs and tar paths — these are training artifacts, not model identifiers
    if (loraModelUrl.startsWith('http') || loraModelUrl.includes('.tar') || loraModelUrl.includes('/trained_model')) {
      console.error('[LoRA] Invalid loraModelUrl — got a storage path instead of "owner/name:version_hash". Re-run lora-status to refresh the character model URL.');
      return null;
    }

    const colonIdx = loraModelUrl.indexOf(':');
    const modelPath = colonIdx !== -1 ? loraModelUrl.slice(0, colonIdx) : loraModelUrl;
    const version   = colonIdx !== -1 ? loraModelUrl.slice(colonIdx + 1) : '';

    if (!modelPath.includes('/')) {
      console.error('[LoRA] Model path must be "owner/name", got:', modelPath);
      return null;
    }

    const input = {
      prompt: prompt,
      num_inference_steps: 28,
      guidance_scale: 3.5,
      aspect_ratio: aspectRatio,
      output_format: 'jpg',
      lora_scale: 0.9,
      negative_prompt: 'orange hair, blonde, white hair, pale skin, blue eyes, European, Japanese, Korean features, non-Indian appearance, red hair',
    };

    // Use version-based endpoint when we have a full hash; model-based when we only have owner/name
    let predUrl: string;
    let body: object;
    if (version && version.length >= 32) {
      predUrl = 'https://api.replicate.com/v1/predictions';
      body = { version, input };
      console.log('[LoRA] Version-based endpoint — model:', modelPath, 'version:', version.slice(0, 16) + '...');
    } else {
      predUrl = `https://api.replicate.com/v1/models/${modelPath}/predictions`;
      body = { input };
      console.log('[LoRA] Model-based endpoint:', modelPath);
    }

    const startRes = await fetch(predUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${replicateToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!startRes.ok) {
      console.warn('[LoRA Gen] Start failed:', (await startRes.text()).slice(0, 200));
      return null;
    }
    let result = await startRes.json();
    console.log('[LoRA Gen] Started:', result.id);

    while (result.status !== 'succeeded' && result.status !== 'failed') {
      await new Promise(r => setTimeout(r, 2000));
      const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${result.id}`, {
        headers: { 'Authorization': `Bearer ${replicateToken}` },
      });
      result = await pollRes.json();
      console.log('[LoRA Gen] Status:', result.status);
    }

    if (result.status === 'failed') { console.error('[LoRA Gen] Failed:', result.error); return null; }
    const imageUrl = Array.isArray(result.output) ? result.output[0] : result.output;
    if (!imageUrl) return null;
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return null;
    console.log('[LoRA Gen] Success!');
    return Buffer.from(await imgRes.arrayBuffer()).toString('base64');
  } catch (err: any) {
    console.error('[LoRA Gen] Error:', err.message);
    tripBreakerIfDead('0:ReplicateLoRA', err);
    return null;
  }
}

// Vertex AI Imagen — the only true text-to-image model we call. Everything else
// on the Google side is a Gemini chat model in image mode via generateContent.
// The id is env-driven so it can roll forward without a deploy, but it must be a
// string we have actually verified against this GCP project: an unverified id
// (e.g. the old hardcoded `gemini-3.1-flash-image`, or `imagen-3.0-*` which this
// project is not allowlisted for) returns 404 on every single request and burns
// a round trip before silently falling through to a stock photo.
export const VERIFIED_IMAGEN_MODELS = [
  'imagen-4.0-fast-generate-001',   // ✓ verified 2026-07-11 on this project / us-central1
  'imagen-4.0-generate-001',
  'imagen-4.0-ultra-generate-001',
  'imagen-3.0-generate-002',
  'imagen-3.0-fast-generate-001',
] as const;

export const DEFAULT_IMAGEN_MODEL = 'imagen-4.0-fast-generate-001';

/** Aspect ratios imageConfig accepts. Anything else is rejected by the API. */
export const SUPPORTED_IMAGE_ASPECTS = new Set([
  '1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9',
]);

export const resolveImagenModel = (env: NodeJS.ProcessEnv = process.env): string =>
  env.VERTEX_IMAGEN_MODEL || DEFAULT_IMAGEN_MODEL;

export const isVerifiedImagenModel = (model: string): boolean =>
  (VERIFIED_IMAGEN_MODELS as readonly string[]).includes(model);

async function generateImageWithVertexImagen(
  prompt: string,
  aspectRatio: string
): Promise<string | null> {
  const model = resolveImagenModel();
  if (!isVerifiedImagenModel(model)) {
    console.error(
      `[Imagen] VERTEX_IMAGEN_MODEL="${model}" is not a verified Imagen model. ` +
      `Expected one of: ${VERIFIED_IMAGEN_MODELS.join(', ')}. Skipping Vertex Imagen.`
    );
    return null;
  }

  dbgCall('1:VertexImagen', {
    provider: 'vertex-ai',
    sdkCall: 'models.generateImages',
    model,
    region: gcpLocation,
    isImagenModel: true,
    payload: { prompt: `<${prompt.length} chars> ${prompt.slice(0, 80)}…`, config: { numberOfImages: 1, aspectRatio } },
  });

  try {
    const ai = getAI('');
    const response: any = await ai.models.generateImages({
      model,
      prompt,
      config: { numberOfImages: 1, aspectRatio } as any,
    });
    const bytes = response.generatedImages?.[0]?.image?.imageBytes as string | undefined;
    if (!bytes) throw new Error('No imageBytes in Imagen response');
    console.log('[ImageGen] Vertex Imagen success! Size:', Math.round(bytes.length * 0.75 / 1024), 'KB');
    dbgOk('1:VertexImagen', model, bytes);
    return bytes;
  } catch (e: any) {
    // 160 chars cut off mid-model-id, which is the one detail needed to tell an
    // unavailable model apart from a disabled API or an unallowlisted project.
    console.warn('[ImageGen] Vertex Imagen failed:', e.message?.slice(0, 400), 'status:', e.status, 'model:', model);
    dbgFail('1:VertexImagen', e, '1.5:GeminiImage');
    tripBreakerIfDead('1:VertexImagen', e);
    return null;
  }
}

/**
 * Image generation via a Gemini image model.
 *
 * This is the provider that actually serves every render on this project: no Imagen
 * model is available to it (the publisher-model list returns 126 models and not one
 * Imagen), so the Vertex Imagen attempt above always 404s and lands here.
 *
 * It previously hardcoded `gemini-2.0-flash-preview-image-generation` — a model this
 * project cannot see either — and passed no aspect ratio at all, so every image came
 * back 1024x1024 and was then cropped ~44% to reach 16:9. `imageConfig.aspectRatio`
 * is what actually controls the shape; the "16:9 landscape" text in the prompt does
 * nothing. Requesting 16:9 now returns 1344x768 and 9:16 returns 768x1344.
 */
async function generateImageWithGeminiNative(
  prompt: string,
  referenceImageUrl?: string,
  aspectRatio?: string
): Promise<string | null> {
  try {
    let geminiKey = '';
    try { geminiKey = getKeyForTask('image'); } catch { return null; }
    if (!geminiKey && !isAdcMode) return null;

    const { GoogleGenAI: GGenAI } = await import('@google/genai');
    const ai = isAdcMode
      ? new GGenAI({ vertexai: true, project: gcpProject, location: gcpLocation } as any)
      : new GGenAI({ apiKey: geminiKey });

    const parts: any[] = [];

    if (referenceImageUrl) {
      // Handles both http(s) URLs and local file paths (anchor fallback)
      const ref = await loadImageAsBase64(referenceImageUrl);
      if (!ref) throw new Error(`Reference load failed: ${referenceImageUrl.slice(-60)}`);
      parts.push({ inlineData: { data: ref.data, mimeType: ref.mimeType } });
      parts.push({
        text: `This is the character reference. ${prompt}. Keep the exact same character face, outfit, and art style.`
      });
    } else {
      parts.push({ text: prompt });
    }

    const response = await ai.models.generateContent({
      model: GEMINI_IMAGE_MODEL,
      contents: [{ role: 'user', parts }],
      config: {
        responseModalities: ['IMAGE', 'TEXT'],
        // Only '1:1','2:3','3:2','3:4','4:3','9:16','16:9','21:9' are accepted; an
        // unsupported string is rejected outright, so anything else is left off and
        // the model's own default applies.
        ...(aspectRatio && SUPPORTED_IMAGE_ASPECTS.has(aspectRatio)
          ? { imageConfig: { aspectRatio } }
          : {}),
      } as any,
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if ((part as any).inlineData?.mimeType?.startsWith('image/')) {
        console.log('[Gemini Native] Success!');
        return (part as any).inlineData.data as string;
      }
    }
    return null;
  } catch (err: any) {
    console.warn('[Gemini Native] Failed:', err.message?.slice(0, 100));
    tripBreakerIfDead('1.75:GeminiNative', err);
    return null;
  }
}

/**
 * Terms that mean the prompt has already said what it should look like.
 *
 * Guards the photorealistic default below. That default previously fired for anything
 * that was not literally photorealistic or anime, so picking Watercolour Illustration
 * produced "...watercolor illustration, ..., photorealistic, cinematic lighting, sharp
 * focus" — a prompt asking for two incompatible looks at once. Every phrase in
 * VISUAL_STYLE_PHRASES is covered here, plus the house illustrated styles, so a chosen
 * style is never argued with. Anything genuinely unstyled still gets the photoreal
 * default, which is the right neutral for a stock talking-head render.
 */
const EXPLICIT_STYLE_MARKERS = [
  'photorealistic', 'photo-realistic', 'photoreal',
  'anime', 'manga', 'cel shading', 'cel-shaded',
  'watercolor', 'watercolour', 'illustration', 'illustrated',
  'minimalist', 'flat design', 'flat colour', 'flat color',
  '3d animated', '3d render', '3d rendered',
  'cyberpunk', 'neon aesthetic',
  'painterly', 'graphic novel', 'oil painting', 'sketch', 'pixel art', 'claymation',
];

const hasExplicitStyle = (prompt: string): boolean => {
  const lower = prompt.toLowerCase();
  return EXPLICIT_STYLE_MARKERS.some((marker) => lower.includes(marker));
};

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
    const qualityPrompt = hasExplicitStyle(prompt)
      ? prompt
      : `${prompt}, photorealistic, cinematic lighting, sharp focus`;
    const orientationHint = isLandscape ? 'Horizontal 16:9 landscape orientation.' : 'Vertical 9:16 portrait orientation.';
    const finalPrompt = `${qualityPrompt}. ${orientationHint}`;

    // The prompt's own style is the style. Nothing is appended here.
    //
    // This used to read: if the prompt does not contain the word "anime", append
    // "semi-realistic anime style, flat colour shading, bold clean outlines". Which is
    // every prompt that is not already anime — so choosing Cinematic Realism produced a
    // prompt ending "...photorealistic, cinematic lighting, sharp focus. Horizontal 16:9
    // landscape orientation., semi-realistic anime style, flat colour shading, bold clean
    // outlines", with the anime terms last and therefore weighted hardest. Every
    // non-anime style came out cel-shaded, which is exactly what the dropdown was
    // reported as doing.
    //
    // It was meant to enforce the house look for the illustrated universe, but that
    // universe already carries its own artStyle through resolveArtStyle, which puts it in
    // the prompt ahead of everything else. So this only ever overrode the styles it was
    // not meant to touch. Deleting it is the fix; there is nothing to replace it with.
    const styledPrompt = finalPrompt;

    if (DEBUG_IMAGEGEN) {
      // The exact text the model receives. Diagnosing the anime-override bug needed this
      // and there was no way to see it: the debug block below logged promptChars only, so
      // a prompt that had been rewritten downstream looked identical to one that had not.
      console.log(`[ImageGen:PROMPT] ${styledPrompt}`);
    }
    if (DEBUG_IMAGEGEN) {
      console.log(`[ImageGen:DEBUG] ── ENTRY ${JSON.stringify({
        authMode: isAdcMode ? 'ADC/Vertex' : 'API-key/AI-Studio',
        gcpProject: gcpProject ? `${gcpProject.slice(0, 6)}…` : null,
        region: isAdcMode ? gcpLocation : 'n/a',
        aspectRatio,
        hasLora: !!options?.loraModelUrl,
        hasReferenceImage: !!options?.referenceImageUrl,
        imagenModel: resolveImagenModel(),
        imagenModelVerified: isVerifiedImagenModel(resolveImagenModel()),
        providerOrder: ['0:ReplicateLoRA', '1:VertexImagen', '1.5:GeminiImage', '1.75:GeminiNative', '2:Fal', '3:Together', '4:Gemini2.5', '5:PicsumThrow'],
      })}`);
    }

    // Provider 0: Replicate LoRA (trained character model — highest identity fidelity)
    if (options?.loraModelUrl && process.env.REPLICATE_API_TOKEN && !providerDead('0:ReplicateLoRA')) {
      const triggerWord = (options.loraTriggerWord as string | undefined) || 'CHARACTER';
      console.log('[ImageGen] Using LoRA model:', (options.loraModelUrl as string).slice(-40));
      dbgCall('0:ReplicateLoRA', {
        provider: 'replicate',
        model: options.loraModelUrl,
        region: 'n/a',
        payload: { promptChars: prompt.length, aspect_ratio: aspectRatio, steps: 28, lora_scale: 0.9 },
      });
      const loraResult = await generateImageWithLoRA(prompt, options.loraModelUrl as string, triggerWord, aspectRatio);
      if (loraResult) { dbgOk('0:ReplicateLoRA', String(options.loraModelUrl), loraResult); return loraResult; }
      dbgFail('0:ReplicateLoRA', new Error('generateImageWithLoRA returned null (see [LoRA] logs above)'), '1:GoogleImage');
      console.log('[ImageGen] LoRA failed, falling back to Gemini 3.1 Flash Image');
    }

    const referenceImageUrl = options?.referenceImageUrl as string | undefined;
    // Handles both http(s) URLs and local file paths (anchor fallback)
    const referenceImage = referenceImageUrl ? await loadImageAsBase64(referenceImageUrl) : null;
    if (referenceImage) console.log('[ImageGen] Reference image loaded for character consistency');

    // Provider 1: Vertex AI Imagen — the real text-to-image model, best quality.
    // Skipped when a character reference image is in play: Imagen generate takes no
    // reference input, so identity would drift. The Gemini multimodal image path
    // below owns that case.
    if (isAdcMode && !referenceImage && !providerDead('1:VertexImagen')) {
      console.log('[ImageGen] Trying Vertex Imagen...');
      const imagenResult = await generateImageWithVertexImagen(styledPrompt, aspectRatio);
      if (imagenResult) return imagenResult;
    }

    // Provider 1.5: Gemini image via generateContent — multimodal, so this is the
    // path that can consume a character reference image for identity consistency.
    let imagenApiKey = '';
    try { imagenApiKey = getKeyForTask('image'); } catch { /* falls through to next provider */ }
    if ((imagenApiKey || isAdcMode) && !providerDead('1.5:GeminiImage')) {
      try {
        console.log('[ImageGen] Trying Gemini Flash Image...');
        const { GoogleGenAI } = await import('@google/genai');
        const geminiImageAI = isAdcMode
          ? new GoogleGenAI({ vertexai: true, project: gcpProject, location: gcpLocation } as any)
          : new GoogleGenAI({ apiKey: imagenApiKey });

        const imgParts: any[] = [];
        if (referenceImage) {
          imgParts.push({ inlineData: { data: referenceImage.data, mimeType: referenceImage.mimeType } });
        }
        imgParts.push({ text: styledPrompt });

        dbgCall('1.5:GeminiImage', {
          provider: isAdcMode ? 'vertex-ai' : 'gemini-api',
          sdkCall: 'models.generateContent',
          model: GEMINI_IMAGE_MODEL,
          region: isAdcMode ? gcpLocation : 'n/a',
          isImagenModel: false,
          payload: {
            contents: [{ role: 'user', parts: imgParts.map((p: any) => p.inlineData
              ? { inlineData: { mimeType: p.inlineData.mimeType, data: `<${p.inlineData.data.length} b64 chars>` } }
              : { text: `<${p.text.length} chars> ${String(p.text).slice(0, 80)}…` }) }],
            config: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: { aspectRatio } },
          },
        });

        const geminiImgResponse = await geminiImageAI.models.generateContent({
          model: GEMINI_IMAGE_MODEL,
          contents: [{ role: 'user', parts: imgParts }],
          config: {
            responseModalities: ['IMAGE', 'TEXT'],
            // Without this every image comes back 1024x1024 and is cropped ~44% to
            // reach 16:9. The "16:9 landscape" text in the prompt does nothing — this
            // is the only thing that sets the shape.
            ...(aspectRatio && SUPPORTED_IMAGE_ASPECTS.has(aspectRatio)
              ? { imageConfig: { aspectRatio } }
              : {}),
          } as any,
        });

        const responseParts = geminiImgResponse.candidates?.[0]?.content?.parts || [];
        const imgPart = responseParts.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));
        if (!imgPart?.inlineData?.data) throw new Error('No image in response');
        const base64 = imgPart.inlineData.data as string;
        console.log('[ImageGen] Gemini Flash Image success! Size:', Math.round(base64.length * 0.75 / 1024), 'KB');
        dbgOk('1.5:GeminiImage', GEMINI_IMAGE_MODEL, base64);
        return base64;
      } catch (e: any) {
        console.warn('[ImageGen] Gemini Flash Image failed:', e.message, 'status:', e.status);
        dbgFail('1.5:GeminiImage', e, options?.referenceImageUrl ? '1.75:GeminiNative' : '2:Fal');
        tripBreakerIfDead('1.5:GeminiImage', e);
      }
    }

    // Provider 1.75: Gemini 2.0 Flash Native (reference-image-aware, better character identity)
    if (options?.referenceImageUrl && !providerDead('1.75:GeminiNative')) {
      dbgCall('1.75:GeminiNative', {
        provider: isAdcMode ? 'vertex-ai' : 'gemini-api',
        sdkCall: 'models.generateContent',
        model: GEMINI_IMAGE_MODEL,
        region: isAdcMode ? gcpLocation : 'n/a',
        isImagenModel: false,
        payload: { parts: ['<reference inlineData>', `<prompt ${styledPrompt.length} chars>`], config: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: { aspectRatio } } },
      });
      const nativeResult = await generateImageWithGeminiNative(styledPrompt, options.referenceImageUrl, aspectRatio);
      if (nativeResult) { dbgOk('1.75:GeminiNative', GEMINI_IMAGE_MODEL, nativeResult); return nativeResult; }
      dbgFail('1.75:GeminiNative', new Error('returned null (see [Gemini Native] warn above)'), '2:Fal');
    }

    // Provider 2: Fal.ai FLUX.1 schnell
    if (process.env.FAL_API_KEY && !providerDead('2:Fal')) {
      try {
        console.log('[ImageGen] FAL_API_KEY present:', !!process.env.FAL_API_KEY, 'prefix:', process.env.FAL_API_KEY?.substring(0, 8));
        console.log('[ImageGen] Trying Fal.ai FLUX.1...');
        dbgCall('2:Fal', {
          provider: 'fal.ai',
          sdkCall: 'fal.subscribe',
          model: 'fal-ai/flux/schnell',
          region: 'n/a',
          isImagenModel: false,
          payload: { promptChars: finalPrompt.length, image_size: isLandscape ? '1920x1080' : '1080x1920', num_inference_steps: 4 },
        });
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
        dbgOk('2:Fal', 'fal-ai/flux/schnell', base64);
        return base64;
      } catch (e: any) {
        console.warn('[ImageGen] Fal.ai failed:', e.message, 'status:', e.status, 'body:', JSON.stringify(e.body || e.response || {}));
        dbgFail('2:Fal', e, '3:Together');
        tripBreakerIfDead('2:Fal', e);
      }
    }

    // Provider 3: Together AI FLUX.1 schnell-Free
    if (process.env.TOGETHER_API_KEY && !providerDead('3:Together')) {
      try {
        console.log('[ImageGen] Trying Together AI...');
        dbgCall('3:Together', {
          provider: 'together.ai',
          sdkCall: 'POST /v1/images/generations',
          model: 'black-forest-labs/FLUX.1-schnell-Free',
          region: 'n/a',
          isImagenModel: false,
          payload: { promptChars: finalPrompt.length, width: isLandscape ? 1920 : 1080, height: isLandscape ? 1080 : 1920, steps: 4 },
        });
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
        if (!togetherRes.ok) {
          // The thrown Error discards the HTTP status, so trip the breaker here.
          tripBreakerIfDead('3:Together', { status: togetherRes.status });
          throw new Error(togetherData.error?.message || `HTTP ${togetherRes.status}`);
        }
        const base64 = togetherData.data?.[0]?.b64_json;
        if (!base64) throw new Error('No b64_json in response');
        console.log('[ImageGen] Together AI success! Size:', Math.round(base64.length * 0.75 / 1024), 'KB');
        dbgOk('3:Together', 'black-forest-labs/FLUX.1-schnell-Free', base64);
        return base64;
      } catch (e: any) {
        console.warn('[ImageGen] Together AI failed:', e.message);
        dbgFail('3:Together', e, '4:Gemini2.5');
      }
    }

    // Provider 4: Gemini 2.5 flash image (when quota available)
    let geminiImageKey = '';
    try { geminiImageKey = getKeyForTask('image'); } catch { /* no key configured */ }
    if ((geminiImageKey || isAdcMode) && !providerDead('4:Gemini2.5')) {
      try {
        console.log('[ImageGen] Trying Gemini 2.5 flash image...');
        const ai = getAI(geminiImageKey);
        dbgCall('4:Gemini2.5', {
          provider: isAdcMode ? 'vertex-ai' : 'gemini-api',
          sdkCall: 'models.generateContent',
          model: 'gemini-2.5-flash-image',
          region: isAdcMode ? gcpLocation : 'n/a',
          isImagenModel: false,
          payload: { parts: [`<prompt ${finalPrompt.length} chars>`], config: { responseModalities: ['TEXT', 'IMAGE'] } },
        });
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash-image',
          contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
          config: { responseModalities: ['TEXT', 'IMAGE'] }
        });
        const parts = response.candidates?.[0]?.content?.parts;
        const imagePart = parts?.find((p: any) => p.inlineData);
        if (!imagePart?.inlineData?.data) throw new Error('No image in response');
        console.log('[ImageGen] Gemini success!');
        dbgOk('4:Gemini2.5', 'gemini-2.5-flash-image', imagePart.inlineData.data as string);
        return imagePart.inlineData.data as string;
      } catch (e: any) {
        console.warn('[ImageGen] Gemini failed:', e.message);
        dbgFail('4:Gemini2.5', e, '5:PicsumThrow');
        tripBreakerIfDead('4:Gemini2.5', e);
      }
    }

    // Provider 5: Picsum (always works)
    if (DEBUG_IMAGEGEN) console.log('[ImageGen:DEBUG] ── EXHAUSTED — all providers failed, throwing to Picsum fallback in assetService');
    throw new Error('All AI providers failed - use Picsum fallback');
  },
  generateImageWithNative: generateImageWithGeminiNative,
  clearQuotaFlags: () => {}
};
