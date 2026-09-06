import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  listKeys, addKey, updateKey, removeKey, keysForCategory, publicView, maskKey,
  migrateEnvKeys, keyStorePath, isKeyCategory, KEY_CATEGORIES,
  getImageProvider, setImageProvider, isImageProvider, IMAGE_PROVIDERS,
} from '../src/server/services/apiKeyStore.js';
import {
  getKeyForTask, markKeyExhausted, clearCooldowns, getPoolStatus, categoryForTask, hasAnyKey,
} from '../src/utils/geminiAuth.js';

/**
 * The AI Studio key pool.
 *
 * Two things were wrong before this. The routing check was
 * `if (process.env.GOOGLE_CLOUD_PROJECT) return ''` at the top of getKeyForTask, so
 * setting a cloud project sent every call to Vertex — billed — while four real keys sat
 * unused in .env. And the "rotation" was a fixed map of one key per task, with
 * markKeyExhausted and getPoolStatus as empty stubs, so a rate-limited key failed its
 * task until the window passed.
 */

const KEY_A = 'AIzaTESTKEY000000000000000000000000AAAA';
const KEY_B = 'AIzaTESTKEY000000000000000000000000BBBB';
const KEY_C = 'AIzaTESTKEY000000000000000000000000CCCC';
const IMG_KEY = 'AIzaTESTKEY000000000000000000000000IMG1';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aikeys-'));
  process.env.AI_KEY_STORE_PATH = path.join(dir, 'ai-keys.json');
  for (const n of ['SCRIPT', 'SCENES', 'VISUAL', 'IMAGE']) delete process.env[`GEMINI_KEY_${n}`];
  delete process.env.GOOGLE_CLOUD_PROJECT;
  clearCooldowns();
});
afterEach(() => {
  delete process.env.AI_KEY_STORE_PATH;
  vi.unstubAllEnvs();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
});

describe('storage', () => {
  it('holds any number of keys, not four', () => {
    for (let i = 0; i < 7; i++) {
      addKey({ key: `AIzaTESTKEY00000000000000000000000000${i}`, category: 'text' });
    }
    expect(listKeys()).toHaveLength(7);
  });

  it('never returns a whole key to a caller', () => {
    const rec = addKey({ key: KEY_A, label: 'mine', category: 'text' });
    const view = publicView(rec) as Record<string, unknown>;
    expect(view.key).toBeUndefined();
    expect(view.masked).toBe('••••••••AAAA');
    expect(JSON.stringify(view)).not.toContain(KEY_A);
    // Enough to tell two keys apart, no use to anyone reading over a shoulder.
    expect(maskKey(KEY_A)).not.toContain(KEY_A.slice(0, 10));
  });

  it('refuses a duplicate rather than rotating onto the same key twice', () => {
    addKey({ key: KEY_A, category: 'text' });
    expect(() => addKey({ key: KEY_A, category: 'image' })).toThrow(/already saved/i);
  });

  it('refuses something that is not a key', () => {
    expect(() => addKey({ key: 'nope', category: 'text' })).toThrow();
  });

  it('only accepts the fixed category set', () => {
    expect(KEY_CATEGORIES).toEqual(['text', 'image']);
    expect(isKeyCategory('text')).toBe(true);
    expect(isKeyCategory('image')).toBe(true);
    // Free-form names would give the router nothing reliable to dispatch on.
    expect(isKeyCategory('my cool key')).toBe(false);
    expect(() => addKey({ key: KEY_A, category: 'whatever' as any })).toThrow(/category/i);
  });

  it('pauses a key without losing it', () => {
    const rec = addKey({ key: KEY_A, category: 'text' });
    updateKey(rec.id, (k) => { k.enabled = false; });
    expect(listKeys()).toHaveLength(1);
    expect(keysForCategory('text')).toHaveLength(0);
  });

  it('deletes a key', () => {
    const rec = addKey({ key: KEY_A, category: 'text' });
    expect(removeKey(rec.id)).toBe(true);
    expect(removeKey(rec.id)).toBe(false);
    expect(listKeys()).toHaveLength(0);
  });

  it('writes the store where only the owner can read it', () => {
    addKey({ key: KEY_A, category: 'text' });
    expect(fs.existsSync(keyStorePath())).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(keyStorePath()).mode & 0o077).toBe(0);
    }
  });
});

describe('migration from the four .env keys', () => {
  it('carries real values across, text and image split correctly', () => {
    process.env.GEMINI_KEY_SCRIPT = KEY_A;
    process.env.GEMINI_KEY_SCENES = KEY_B;
    process.env.GEMINI_KEY_VISUAL = KEY_C;
    process.env.GEMINI_KEY_IMAGE = IMG_KEY;

    const { migrated } = migrateEnvKeys();
    expect(migrated).toBe(4);
    // script/scenes/visual were never three purposes — all three are text calls.
    expect(keysForCategory('text').map((k) => k.key).sort()).toEqual([KEY_A, KEY_B, KEY_C].sort());
    expect(keysForCategory('image').map((k) => k.key)).toEqual([IMG_KEY]);
  });

  it('does not import the documented placeholder as a credential', () => {
    process.env.GEMINI_KEY_SCRIPT = 'adc-not-used';
    process.env.GEMINI_KEY_SCENES = KEY_B;
    expect(migrateEnvKeys().migrated).toBe(1);
    expect(keysForCategory('text').map((k) => k.key)).toEqual([KEY_B]);
  });

  it('runs once, so a deleted key does not come back', () => {
    process.env.GEMINI_KEY_SCRIPT = KEY_A;
    expect(migrateEnvKeys().migrated).toBe(1);
    removeKey(listKeys()[0].id);
    // .env still holds it, but the store file exists, so migration is done.
    expect(migrateEnvKeys().migrated).toBe(0);
    expect(listKeys()).toHaveLength(0);
  });
});

describe('rotation', () => {
  it('spreads calls across every key in the category', () => {
    for (const k of [KEY_A, KEY_B, KEY_C]) addKey({ key: k, category: 'text' });
    const picked = Array.from({ length: 9 }, () => getKeyForTask('script'));
    expect(new Set(picked).size).toBe(3);
    // Round-robin, not random: each key takes an equal share.
    for (const k of [KEY_A, KEY_B, KEY_C]) {
      expect(picked.filter((p) => p === k)).toHaveLength(3);
    }
  });

  it('keeps the pools apart', () => {
    // Image generation must not be able to exhaust the keys the scriptwriter needs.
    addKey({ key: KEY_A, category: 'text' });
    addKey({ key: IMG_KEY, category: 'image' });
    expect(getKeyForTask('image')).toBe(IMG_KEY);
    expect(getKeyForTask('script')).toBe(KEY_A);
    expect(categoryForTask('scenes')).toBe('text');
    expect(categoryForTask('visual')).toBe('text');
    expect(categoryForTask('image')).toBe('image');
  });

  it('drops a rate-limited key out of rotation', () => {
    for (const k of [KEY_A, KEY_B, KEY_C]) addKey({ key: k, category: 'text' });
    markKeyExhausted(KEY_B);
    const picked = Array.from({ length: 6 }, () => getKeyForTask('script'));
    expect(picked).not.toContain(KEY_B);
    expect(new Set(picked)).toEqual(new Set([KEY_A, KEY_C]));
    expect(getPoolStatus('script')).toMatchObject({ total: 3, available: 2 });
  });

  it('skips a paused key', () => {
    const a = addKey({ key: KEY_A, category: 'text' });
    addKey({ key: KEY_B, category: 'text' });
    updateKey(a.id, (k) => { k.enabled = false; });
    expect(Array.from({ length: 4 }, () => getKeyForTask('script'))).toEqual([KEY_B, KEY_B, KEY_B, KEY_B]);
  });

  it('retries the soonest-free key rather than falling through to billed Vertex', () => {
    // The whole point of the change: being busy is not a reason to start paying.
    process.env.GOOGLE_CLOUD_PROJECT = 'some-project';
    addKey({ key: KEY_A, category: 'text' });
    markKeyExhausted(KEY_A);
    expect(getKeyForTask('script')).toBe(KEY_A);
  });
});

describe('the image pool rests a key the endpoint refused', () => {
  it('marks a key exhausted on every rate-limit shape AI Studio returns', async () => {
    // The real one, verbatim from a live call: gemini-2.5-flash-preview-image reports
    // `limit: 0` on the free tier -- it has no free allowance at all.
    const fs2 = await import('fs');
    const src = fs2.readFileSync('src/services/aiService.ts', 'utf8');
    // Both AI Studio image providers, not just text.
    expect(src).toContain("markKeyExhausted(imagenApiKey, 'image')");
    expect(src).toContain("markKeyExhausted(geminiImageKey, 'image')");
    expect(src).toMatch(/exceeded your current quota/);
  });

  it('rotates the image pool when one key is spent', () => {
    const IMG_B = 'AIzaTESTKEY000000000000000000000000IMG2';
    addKey({ key: IMG_KEY, category: 'image' });
    addKey({ key: IMG_B, category: 'image' });
    markKeyExhausted(IMG_KEY);
    expect(Array.from({ length: 3 }, () => getKeyForTask('image'))).toEqual([IMG_B, IMG_B, IMG_B]);
  });
});

describe('precedence: keys before Vertex', () => {
  it('uses a stored key even when a cloud project is configured', () => {
    // This is the exact bug. GOOGLE_CLOUD_PROJECT used to short-circuit to '' on the
    // first line of getKeyForTask, so real keys were never reached.
    process.env.GOOGLE_CLOUD_PROJECT = 'some-project';
    addKey({ key: KEY_A, category: 'text' });
    expect(getKeyForTask('script')).toBe(KEY_A);
  });

  it('falls back to the legacy .env key when the store is empty', () => {
    process.env.GEMINI_KEY_SCRIPT = KEY_A;
    fs.writeFileSync(keyStorePath(), JSON.stringify({ version: 1, keys: [] }));
    expect(getKeyForTask('script')).toBe(KEY_A);
  });

  it('falls back to ADC only when there is no key anywhere', () => {
    process.env.GOOGLE_CLOUD_PROJECT = 'some-project';
    expect(hasAnyKey()).toBe(false);
    expect(getKeyForTask('script')).toBe(''); // '' is aiService's signal to use Vertex
  });

  it('throws with somewhere to go when there is nothing configured at all', () => {
    expect(() => getKeyForTask('script')).toThrow(/aistudio\.google\.com\/apikey/);
  });
});

describe('the image provider toggle', () => {
  it('defaults to Vertex, because that is what serves an image today', () => {
    // AI Studio returns limit: 0 for every image model until billing is on the key's
    // project. Defaulting there would break image generation for anyone who has not
    // opened Settings yet.
    expect(getImageProvider()).toBe('vertex');
  });

  it('remembers the choice', () => {
    expect(setImageProvider('aistudio')).toBe('aistudio');
    expect(getImageProvider()).toBe('aistudio');
    expect(setImageProvider('vertex')).toBe('vertex');
    expect(getImageProvider()).toBe('vertex');
  });

  it('only accepts the two real providers', () => {
    expect(IMAGE_PROVIDERS).toEqual(['aistudio', 'vertex']);
    expect(isImageProvider('aistudio')).toBe(true);
    expect(isImageProvider('cheapest')).toBe(false);
    expect(() => setImageProvider('cheapest' as any)).toThrow(/provider/i);
  });

  it('does not disturb the keys when it changes', () => {
    addKey({ key: IMG_KEY, category: 'image' });
    setImageProvider('aistudio');
    expect(keysForCategory('image').map((k) => k.key)).toEqual([IMG_KEY]);
    // Rotation is unaffected by which provider is selected — the toggle decides where a
    // call goes, the pool decides which key it goes out on.
    expect(getKeyForTask('image')).toBe(IMG_KEY);
  });

  it('is never written by the pipeline — the switch is the user, not the quota', async () => {
    // The one rule the toggle exists to enforce: exhausting AI Studio must not quietly
    // start billing Vertex, and vice versa. So nothing outside the settings route may
    // call setImageProvider.
    const { readFileSync } = await import('fs');
    for (const f of ['src/services/aiService.ts', 'src/utils/geminiAuth.ts']) {
      expect(readFileSync(f, 'utf8')).not.toContain('setImageProvider');
    }
    // And the route that does write it is a PUT — no GET or side-effecting read.
    const route = readFileSync('src/server/routes/apiKeys.ts', 'utf8');
    expect(route).toMatch(/put\('\/settings'/);
  });

  it('routes image calls on the toggle, not on whether keys happen to exist', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/services/aiService.ts', 'utf8');
    expect(src).toContain("getImageProvider() === 'vertex'");
    // adcActive() means "no keys anywhere". Deciding an image route on it would make
    // adding a text key silently move image generation, so every image call site reads
    // imageViaVertex() instead; the one survivor is a debug field reporting auth mode.
    expect(src.match(/adcActive\(\)/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/authMode: adcActive\(\)/);
  });
});
