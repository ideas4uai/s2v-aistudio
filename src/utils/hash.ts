export function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

export function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}

export const generateHash = hashString;
/**
 * How the synthesiser itself changed, as part of every audio key.
 *
 * Bump this whenever a fix changes the sound of text that did not change. Every audio
 * cache in the app keys off generateAudioHash — the TTS clip cache, and the
 * orchestrator's "is the narration on disk still the narration this wants" check — so
 * without it a fix can only reach projects whose script someone happens to edit.
 *
 * v2: the TTS sidecar decoded its stdin as the Windows locale codepage while Node
 * wrote UTF-8, so an em dash reached Kokoro as "â€”" and was spoken aloud. Measured on
 * one 22.9s scene: 1.80s of "a circumflex euro" in the middle of the narration, and
 * captions up to 1.05s late because that phantom speech sat inside the measured span.
 */
export const SYNTH_VERSION = 'v2';
export const generateAudioHash = (text: string, preset: string, character?: string) =>
  hashString(SYNTH_VERSION + text + preset + (character || 'NARRATOR'));
export const generateVisualHash = (...args: any[]) => hashString(JSON.stringify(args));
export const generateSceneHash = (...args: any[]) => hashString(JSON.stringify(args));
export const generateAssetHash = (...args: any[]) => hashString(JSON.stringify(args));
