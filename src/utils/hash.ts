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
export const generateAudioHash = (text: string, preset: string) => hashString(text + preset);
export const generateVisualHash = (...args: any[]) => hashString(JSON.stringify(args));
export const generateSceneHash = (...args: any[]) => hashString(JSON.stringify(args));
export const generateAssetHash = (...args: any[]) => hashString(JSON.stringify(args));
