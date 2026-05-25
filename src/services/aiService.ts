import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from '@google/genai';
import { getGeminiKey, markKeyExhausted, getPoolStatus } from '../utils/geminiAuth.js';

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
  'image': 'gemini-3.1-flash-image-preview',
  'default': 'gemini-2.5-flash'
};

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

export const AIService = {
  generateText: async (prompt: string, options?: any) => {
    const task = options?.task;
    let model = options?.model;
    const maxRetries = 2;
    let retryCount = 0;
    let keyRotationCount = 0;
    const maxKeyRotations = 10;

    // Auto-select best model for task if not explicitly overridden
    if (!model) {
      model = task && TASK_MODELS[task] ? TASK_MODELS[task] : TASK_MODELS['default'];
    }
    
    const execute = async (currentModel: string): Promise<string> => {
      const apiKey = getGeminiKey(task);
      const ai = getAI(apiKey);
      console.log(`[AIService] Generating text for task: ${task || 'general'} with model: ${currentModel} (Attempt ${retryCount + 1})`);
      console.log('[AIService] Using key prefix:', apiKey?.substring(0, 10));
      console.log('[AIService] Using model:', currentModel);

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

        if (is429 || is503) {
          markKeyExhausted(apiKey, 'text');
          const status = getPoolStatus('text');
          console.log(`[AIService] ${is503 ? '503 server overload' : 'quota exhausted'} on key ...${apiKey.slice(-4)}, rotating... (${status.available}/${status.total} available)`);

          if (status.available > 0 && keyRotationCount < maxKeyRotations) {
            keyRotationCount++;
            if (is503) await delay(3000);
            return execute(currentModel);
          }

          // All keys exhausted — fall back to cheaper model
          if (retryCount < maxRetries) {
            retryCount++;
            keyRotationCount = 0;
            const backoffDelay = Math.pow(2, retryCount) * 1000;
            console.warn(`[AIService] All keys exhausted for ${currentModel}. Falling to gemini-2.5-flash-lite in ${backoffDelay}ms...`);
            await delay(backoffDelay);
            if (currentModel === 'gemini-2.5-flash-lite') {
              throw new Error('429 RESOURCE_EXHAUSTED: AI Quota Exceeded. Please try again in 1 minute or upgrade to a paid API key in Settings.');
            }
            return execute('gemini-2.5-flash-lite');
          }
          throw new Error('429 RESOURCE_EXHAUSTED: AI Quota Exceeded. Please try again in 1 minute or upgrade to a paid API key in Settings.');
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
    const task = 'world';
    const model = options?.model || TASK_MODELS[task] || 'gemini-2.5-flash';
    console.log(`[AIService] Analyzing image with model: ${model}`);

    try {
      const apiKey = getGeminiKey(task);
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
    const aspectRatio = options?.aspectRatio || '9:16';
    const apiKey = getGeminiKey('image') || getGeminiKey();
    if (!apiKey) throw new Error('No API key available for image generation');
    const ai = getAI(apiKey);
    console.log('[ImageGen] key prefix:', apiKey?.substring(0, 10), 'aspectRatio:', aspectRatio);

    // gemini-3.1-flash-image-preview
    const geminiModel = options?.model || 'gemini-3.1-flash-image-preview';
    try {
      console.log(`[ImageGen] Trying ${geminiModel}...`);
      const cleanedPrompt = prompt
        .replace(/\[CHAR:[^\]]*\]/g, '')
        .replace(/\[.*?\]/g, '')
        .trim();
      const response = await ai.models.generateContent({
        model: geminiModel,
        contents: cleanedPrompt,
        config: { responseModalities: ['IMAGE', 'TEXT'] }
      });
      const candidate = response.candidates?.[0];
      if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
          if (part.inlineData) {
            const base64Result = part.inlineData.data as string;
            console.log('[ImageGen] Gemini success! Size:', Math.round(base64Result.length * 0.75 / 1024), 'KB');
            return base64Result;
          }
        }
      }
      throw new Error('No image part in Gemini response');
    } catch (geminiErr: any) {
      markKeyExhausted(apiKey, 'image');
      console.error('[ImageGen] Gemini failed:', geminiErr?.message, 'status:', geminiErr?.status);
      console.error('[ImageGen] full error:', JSON.stringify(geminiErr, null, 2));
    }

    throw new Error('Gemini image generation failed');
  },
  clearQuotaFlags: () => {}
};
