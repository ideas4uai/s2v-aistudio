const POOL_KEY_NAMES = [
  'GEMINI_API_KEY_SCRIPT',
  'GEMINI_API_KEY_SCENES',
  'GEMINI_API_KEY_IMAGES',
  'GEMINI_API_KEY',
  'MY_CUSTOM_GEMINI_API_KEY',
  'GEMINI_API_KEY_2',
  'GEMINI_API_KEY_3',
  'GEMINI_API_KEY_4',
  'GEMINI_API_KEY_5',
  'GEMINI_API_KEY_6',
];

const TASK_PREFERRED: Record<string, string> = {
  'script':           'GEMINI_API_KEY_SCRIPT',
  'planning':         'GEMINI_API_KEY_SCRIPT',
  'scenes':           'GEMINI_API_KEY_SCENES',
  'segmentation':     'GEMINI_API_KEY_SCENES',
  'visual_expansion': 'GEMINI_API_KEY_SCENES',
  'world':            'GEMINI_API_KEY_SCENES',
  'image':            'GEMINI_API_KEY_IMAGES',
};

const COOLDOWN_MS = 60_000;
// composite key: `${taskType}:${apiKeyValue}` → expiry timestamp
const cooldowns = new Map<string, number>();
const lastUsed  = new Map<string, number>(); // key value → last-used timestamp

const clean = (k?: string): string =>
  k ? k.trim().replace(/^["']|["']$/g, '') : '';

const isReal = (k: string) => k.length > 5;

const resolveKey = (name: string): string => {
  const env = (typeof process !== 'undefined' ? process.env : {}) as Record<string, string | undefined>;
  const viteEnv = (typeof import.meta !== 'undefined' && import.meta.env
    ? import.meta.env : {}) as Record<string, string | undefined>;
  return clean(env[name] || viteEnv[name] || viteEnv[`VITE_${name}`]);
};

const isOnCooldown = (key: string, taskType: 'text' | 'image' = 'text'): boolean => {
  const cooldownKey = `${taskType}:${key}`;
  const expiry = cooldowns.get(cooldownKey);
  if (!expiry) return false;
  if (Date.now() < expiry) return true;
  cooldowns.delete(cooldownKey);
  return false;
};

const resolvePool = (): Array<{ name: string; value: string }> =>
  POOL_KEY_NAMES
    .map(name => ({ name, value: resolveKey(name) }))
    .filter(({ value }) => isReal(value));

const lruSort = <T extends { value: string }>(entries: T[]): T[] =>
  [...entries].sort((a, b) => (lastUsed.get(a.value) ?? 0) - (lastUsed.get(b.value) ?? 0));

export interface PoolStatus {
  total: number;
  available: number;
  exhausted: string[];
}

export const getPoolStatus = (taskType: 'text' | 'image' = 'text'): PoolStatus => {
  const pool = resolvePool();
  const exhausted = pool
    .filter(({ value }) => isOnCooldown(value, taskType))
    .map(({ value }) => `...${value.slice(-4)}`);
  return { total: pool.length, available: pool.length - exhausted.length, exhausted };
};

export const markKeyExhausted = (key: string, taskType: 'text' | 'image' = 'text'): void => {
  if (!isReal(key)) return;
  cooldowns.set(`${taskType}:${key}`, Date.now() + COOLDOWN_MS);
  const { available, total } = getPoolStatus(taskType);
  console.warn(`[KeyPool] Key ...${key.slice(-4)} marked exhausted (${taskType}). ${available}/${total} keys available.`);
};

export const getGeminiKey = (task?: string): string => {
  const taskType: 'text' | 'image' = task === 'image' ? 'image' : 'text';

  // 1. Preferred key for this task type (if not in cooldown)
  const preferredName = task ? (TASK_PREFERRED[task] ?? 'GEMINI_API_KEY') : 'GEMINI_API_KEY';
  const preferredVal = resolveKey(preferredName);
  if (isReal(preferredVal) && !isOnCooldown(preferredVal, taskType)) {
    lastUsed.set(preferredVal, Date.now());
    return preferredVal;
  }

  // 2. LRU pick from any available (non-cooldown) pool key
  const available = lruSort(resolvePool().filter(({ value }) => !isOnCooldown(value, taskType)));
  if (available.length > 0) {
    const { value } = available[0];
    lastUsed.set(value, Date.now());
    return value;
  }

  // 3. All keys on cooldown — return LRU anyway (best effort)
  const all = lruSort(resolvePool());
  if (all.length > 0) {
    const { value } = all[0];
    lastUsed.set(value, Date.now());
    return value;
  }

  return '';
};

export const getSafeGeminiKey = getGeminiKey;

// Startup diagnostic
console.log('[KeyPool] Image key:', resolveKey('GEMINI_API_KEY_IMAGES')?.substring(0, 10) || '(not set)');
