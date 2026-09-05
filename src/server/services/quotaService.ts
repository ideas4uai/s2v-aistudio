import { logEvent, currentProjectId } from '../../services/logService.js';

/**
 * Usage recording for the things that cost money.
 *
 * This was a stub: checkQuota returned true, consumeQuota did nothing, and the one
 * caller in the orchestrator incremented a counter that was never written anywhere. So
 * "what did this video cost" had no answer.
 *
 * Measurement only, deliberately. Enforcement needs a policy — per-account allowances,
 * a billing period, what happens when someone runs out — and none of that exists yet.
 * Recording first means the eventual limits can be set from real numbers instead of
 * guesses. checkQuota therefore still returns true, and now says why.
 */
export const quotaService = {
  /** Always true: nothing is metered yet. See the note above before changing this. */
  checkQuota: async () => true,
  consumeQuota: async () => {},
};

export class QuotaService {
  /** One generated image. Priced by estimateCostUsd against ANALYTICS_IMAGE_COST_USD. */
  static async incrementAiImage(): Promise<void> {
    logEvent('ai_image', currentProjectId(), { count: 1 });
  }

  /** One synthesised narration clip. Local TTS, so no API spend — counted for volume. */
  static async incrementAudio(): Promise<void> {
    logEvent('tts_generated', currentProjectId(), { count: 1 });
  }
}
