import {
  keysForCategory, touchKey, type KeyCategory, type ApiKeyRecord,
} from '../server/services/apiKeyStore.js';

/**
 * Which key a call goes out on.
 *
 * ── What this replaced ─────────────────────────────────────────────────────────
 * A fixed map of four env vars, one per task, and two functions named
 * markKeyExhausted and getPoolStatus that were empty stubs. There was no rotation:
 * each task had exactly one key it could ever use, so a rate-limited key failed that
 * task until the window passed.
 *
 * Worse, the first line of getKeyForTask returned '' whenever GOOGLE_CLOUD_PROJECT was
 * set, which routed everything to Vertex — billed at standard rates — while four real
 * AI Studio keys with a genuine free tier sat unused in .env. That precedence is
 * reversed here: keys win, and ADC is the fallback for having none.
 */

export type KeyTask = 'script' | 'scenes' | 'visual' | 'image';

/**
 * Tasks to pools.
 *
 * script, scenes and visual are all text calls against the same model — that is why
 * the old four-way env split was never four purposes. See apiKeyStore for why the
 * category set stops at two.
 */
const TASK_CATEGORY: Record<KeyTask, KeyCategory> = {
  script: 'text',
  scenes: 'text',
  visual: 'text',
  image: 'image',
};

export function categoryForTask(task?: string): KeyCategory {
  return TASK_CATEGORY[task as KeyTask] ?? 'text';
}

/**
 * How long a key sits out after a rate limit.
 *
 * Long enough for a per-minute window to roll over, short enough that a pool of two
 * does not spend the render idle. A daily cap outlasts this, and the key will simply be
 * put back in cooldown on its next turn — which is the right shape: nothing has to
 * distinguish a minute limit from a day limit to behave sensibly.
 */
const COOLDOWN_MS = Number(process.env.GEMINI_KEY_COOLDOWN_MS || 65_000);

/** key value -> epoch ms it becomes usable again. In memory: a restart clears it, and
 *  that is correct, since the window it was waiting on has almost certainly passed. */
const cooldown = new Map<string, number>();

/** Round-robin cursor per category. */
const cursor: Record<string, number> = {};

function available(keys: ApiKeyRecord[], now: number): ApiKeyRecord[] {
  return keys.filter((k) => (cooldown.get(k.key) ?? 0) <= now);
}

/**
 * The next key for this task, rotating within its category.
 *
 * Precedence, in order:
 *   1. an available key from the store for this task's category — round-robin
 *   2. if every key in that category is cooling down, the one whose cooldown ends
 *      soonest. Deliberately NOT a fall-through to Vertex: silently moving to a billed
 *      endpoint because the free pool is busy is the exact behaviour this file exists
 *      to stop. The caller already retries and backs off.
 *   3. the legacy .env variable for this task, if the store holds nothing
 *   4. '' — which aiService reads as "use ADC/Vertex" — only when GOOGLE_CLOUD_PROJECT
 *      is set and there are no keys anywhere
 *   5. otherwise throw, naming what to do about it
 */
export function getKeyForTask(task: KeyTask): string {
  const category = categoryForTask(task);
  const pool = keysForCategory(category);
  const now = Date.now();

  if (pool.length) {
    const usable = available(pool, now);
    if (usable.length) {
      const i = (cursor[category] = (cursor[category] ?? -1) + 1) % usable.length;
      const picked = usable[i];
      touchKey(picked.id);
      return picked.key;
    }
    // Everything is resting. Take the one that recovers first rather than paying.
    const soonest = [...pool].sort(
      (a, b) => (cooldown.get(a.key) ?? 0) - (cooldown.get(b.key) ?? 0),
    )[0];
    console.warn(
      `[GeminiAuth] Every ${category} key is rate-limited; retrying on the one that frees up first `
      + `(${Math.max(0, Math.ceil(((cooldown.get(soonest.key) ?? now) - now) / 1000))}s).`,
    );
    return soonest.key;
  }

  const legacy = String(process.env[`GEMINI_KEY_${task.toUpperCase()}`] || '').trim();
  if (legacy && !/adc-not-used/i.test(legacy)) return legacy;

  if (process.env.GOOGLE_CLOUD_PROJECT) return ''; // ADC/Vertex — billed, and last
  throw new Error(
    `No API key available for ${task} (${category}). Add one under Settings → API Keys, `
    + 'or get one at https://aistudio.google.com/apikey',
  );
}

/**
 * Take a key out of rotation for a while.
 *
 * Called by aiService when a request comes back 429/RESOURCE_EXHAUSTED, so the retry
 * lands on a different key instead of the one that just refused.
 */
export function markKeyExhausted(key: string, _taskType?: string): void {
  if (!key) return;
  cooldown.set(key, Date.now() + COOLDOWN_MS);
  console.warn(`[GeminiAuth] Key ...${key.slice(-4)} rate-limited — resting ${Math.round(COOLDOWN_MS / 1000)}s.`);
}

/** Test seam and a way to clear cooldowns deliberately. */
export function clearCooldowns(): void {
  cooldown.clear();
  for (const k of Object.keys(cursor)) delete cursor[k];
}

export interface PoolStatus {
  total: number;
  available: number;
  exhausted: string[];
}

/** What the Settings page shows about pool health. Masked — never whole keys. */
export function getPoolStatus(taskType?: string): PoolStatus {
  const category = categoryForTask(taskType);
  const pool = keysForCategory(category);
  const now = Date.now();
  return {
    total: pool.length,
    available: available(pool, now).length,
    exhausted: pool.filter((k) => (cooldown.get(k.key) ?? 0) > now).map((k) => `••••${k.key.slice(-4)}`),
  };
}

/** Kept for the remaining call sites that ask for a key without naming a task. */
export function getGeminiKey(task?: string): string {
  try {
    return getKeyForTask((task as KeyTask) in TASK_CATEGORY ? (task as KeyTask) : 'script');
  } catch {
    return '';
  }
}

/** Is there any usable key at all, in any pool? Decides whether ADC is even reachable. */
export function hasAnyKey(): boolean {
  if (keysForCategory('text').length || keysForCategory('image').length) return true;
  return ['SCRIPT', 'SCENES', 'VISUAL', 'IMAGE'].some((n) => {
    const v = String(process.env[`GEMINI_KEY_${n}`] || '').trim();
    return v.length >= 20 && !/adc-not-used/i.test(v);
  });
}

/** "3 text, 2 image" — for the startup line, so the active pool is visible in the log. */
export function keyPoolSummary(): string {
  const parts = (['text', 'image'] as KeyCategory[])
    .map((c) => `${keysForCategory(c).length} ${c}`)
    .filter((p) => !p.startsWith('0 '));
  return parts.length ? parts.join(', ') : 'legacy .env keys';
}
