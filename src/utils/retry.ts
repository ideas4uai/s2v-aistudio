import { geminiRateLimiter } from './rateLimiter.js';

export interface RetryOptions {
  retries?: number;
  delayMs?: number;
  backoffFactor?: number;
  retryOn429?: boolean;
}

/**
 * Executes an async function with exponential backoff retry logic and rate limiting.
 * 
 * @param fn The async function to execute.
 * @param options Configuration for retries, initial delay, and backoff multiplier.
 * @returns The result of the async function if successful.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const retries = options?.retries ?? 3;
  let delayMs = options?.delayMs ?? 2000;
  const backoffFactor = options?.backoffFactor ?? 2;
  const retryOn429 = options?.retryOn429 ?? true;

  let attempt = 0;

  while (true) {
    try {
      // Acquire rate limiter slot before each attempt
      await geminiRateLimiter.acquire();
      return await fn();
    } catch (error: any) {
      attempt++;
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isRateLimit = errorMessage.includes('429') || 
                          errorMessage.includes('RESOURCE_EXHAUSTED') ||
                          error.status === 429;
      
      const isBadRequest = errorMessage.includes('400') || 
                           errorMessage.includes('INVALID_ARGUMENT') ||
                           error.status === 400;
      
      if (attempt > retries || isBadRequest) {
        if (isBadRequest) {
          console.error(`[Retry] Bad request (400). Skipping retries. Error: ${errorMessage}`);
        } else {
          console.error(`[Retry] Max retries (${retries}) reached. Throwing error.`);
        }
        throw error;
      }

      if (isRateLimit && !retryOn429) {
        throw error;
      }

      // If it's a rate limit, try to parse the retryDelay from the error message
      let currentDelay = isRateLimit ? Math.max(delayMs, 10000) : delayMs;
      
      if (isRateLimit) {
        if (errorMessage.includes('limit: 0')) {
          console.error(`[Retry] Quota limit is 0. Stopping retries.`);
          throw new Error('Image generation is not available on your current Gemini API tier (Quota limit: 0). Please upgrade your plan or use a different API key.');
        }

        try {
          // The error message is often a JSON string
          const errorJson = JSON.parse(errorMessage);
          const details = errorJson.error?.details || [];
          const quotaFailure = details.find((d: any) => d['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure');
          
          if (quotaFailure) {
            const isDailyLimit = quotaFailure.violations?.some((v: any) => v.quotaId?.includes('PerDay'));
            if (isDailyLimit) {
              console.error(`[Retry] Daily quota limit reached. Stopping retries.`);
              throw new Error('Daily quota limit reached for Gemini API. Please try again tomorrow or upgrade your plan.');
            }
          }

          const retryInfo = details.find((d: any) => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
          if (retryInfo && retryInfo.retryDelay) {
            // retryDelay is a string like "49s"
            const seconds = parseFloat(retryInfo.retryDelay.replace('s', ''));
            if (!isNaN(seconds)) {
              currentDelay = (seconds + 1) * 1000; // Add 1s buffer
              console.log(`[Retry] API requested retry delay: ${seconds}s. Waiting ${currentDelay}ms...`);
            }
          }
        } catch (e) {
          // If parsing fails, use the default/backoff delay
          // Also check for "Please retry in X.Xs" in the raw message
          const retryMatch = errorMessage.match(/Please retry in (\d+\.?\d*)s/);
          if (retryMatch) {
            const seconds = parseFloat(retryMatch[1]);
            currentDelay = (seconds + 1) * 1000;
            console.log(`[Retry] Found retry delay in message: ${seconds}s. Waiting ${currentDelay}ms...`);
          }
        }
      }
      
      console.warn(`[Retry] Attempt ${attempt} failed. Retrying in ${currentDelay}ms... Error: ${errorMessage}`);
      
      // Wait for the specified delay before the next attempt
      await new Promise((resolve) => setTimeout(resolve, currentDelay));
      
      // Apply exponential backoff for the NEXT attempt if needed
      delayMs *= backoffFactor;
    }
  }
}
