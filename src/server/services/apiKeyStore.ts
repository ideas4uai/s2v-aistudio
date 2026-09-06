import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Every Google AI Studio API key this installation can call with.
 *
 * ── Why a store rather than more env vars ──────────────────────────────────────
 * The old shape was four fixed variables — GEMINI_KEY_SCRIPT, _SCENES, _VISUAL and
 * _IMAGE — which is not a pool, it is a 1:1 task-to-key map. It cannot hold a fifth
 * key, it cannot disable one without editing a file and restarting, and it cannot
 * rotate, because each task had exactly one key to choose from.
 *
 * AI Studio's free tier is rate-limited PER KEY, so the number of keys is the thing
 * that has to grow. That does not fit fixed env vars, so it moves to a store the app
 * can add to at runtime.
 *
 * ── Why two categories and not more ────────────────────────────────────────────
 * Text and image are the only split that corresponds to something real: they are
 * different models (gemini-2.5-flash vs gemini-2.5-flash-image) with separate quotas,
 * and image generation burns its allowance far faster. Keeping them apart means a
 * render's images cannot exhaust the keys the scriptwriter needs.
 *
 * The old four-way split was never four purposes — script, scenes and visual are all
 * text calls against the same model. Splitting further would fragment the pool: every
 * extra category needs its own keys to rotate across, and a category with one key in it
 * has no rotation at all, which is the problem this exists to solve.
 *
 * Fixed set, never free-form. A label the user types is for the user; routing has to
 * key off something the code can rely on.
 *
 * ── Security posture ───────────────────────────────────────────────────────────
 * Same as config/youtube-tokens.json, deliberately: one gitignored file, 0600, written
 * write-then-rename so a crash cannot leave a half-written credential. The API never
 * returns a full key once stored — see maskKey.
 */

export const KEY_CATEGORIES = ['text', 'image'] as const;
export type KeyCategory = (typeof KEY_CATEGORIES)[number];

export const CATEGORY_INFO: Record<KeyCategory, { label: string; help: string }> = {
  text: {
    label: 'Text generation',
    help: 'Scripts, scene breakdowns, visual prompts, titles and descriptions. Uses gemini-2.5-flash.',
  },
  image: {
    label: 'Image generation',
    help: 'Scene backgrounds and thumbnails. Uses gemini-2.5-flash-image, which has a much smaller free allowance than text — most installs want more keys here.',
  },
};

export function isKeyCategory(v: unknown): v is KeyCategory {
  return typeof v === 'string' && (KEY_CATEGORIES as readonly string[]).includes(v);
}

export type ApiKeyRecord = {
  id: string;
  /** The secret itself. Never leaves the server — see maskKey for what the API returns. */
  key: string;
  /** The operator's own note. Never used for routing: see the category comment above. */
  label?: string;
  category: KeyCategory;
  /** False parks a rate-limited or revoked key without losing it. */
  enabled: boolean;
  createdAt: string;
  lastUsedAt?: string;
};

/**
 * Which credential image generation uses.
 *
 * A manual switch, never automatic. AI Studio's free tier is limit: 0 for every image
 * model — confirmed against the live API and Google's own pricing page, which lists
 * "Free tier: Not available" for all of them — so on AI Studio images are billed at
 * $0.039/image (gemini-2.5-flash-image) and need billing enabled on the key's project.
 *
 * Automatic failover between the two was explicitly rejected: quietly moving to the
 * other billed endpoint when one runs out is how you end up paying somewhere you did
 * not choose. When the selected provider cannot serve, image generation fails loudly.
 */
export const IMAGE_PROVIDERS = ['aistudio', 'vertex'] as const;
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number];

export function isImageProvider(v: unknown): v is ImageProvider {
  return typeof v === 'string' && (IMAGE_PROVIDERS as readonly string[]).includes(v);
}

export type StoreSettings = { imageProvider: ImageProvider };

/**
 * Vertex by default, and only because it is what works today with no action from
 * anyone: a live call to Vertex gemini-2.5-flash-image returns an image right now,
 * while the same model on AI Studio returns limit: 0 until billing is enabled.
 *
 * This is not a recommendation to stay on Vertex. It is the default that does not
 * silently break image generation for an operator who has not yet chosen.
 */
export const DEFAULT_SETTINGS: StoreSettings = { imageProvider: 'vertex' };

export type ApiKeyStore = { version: 1; keys: ApiKeyRecord[]; settings?: StoreSettings };

export function keyStorePath(): string {
  return process.env.AI_KEY_STORE_PATH || path.join(process.cwd(), 'config', 'ai-keys.json');
}

const empty = (): ApiKeyStore => ({ version: 1, keys: [], settings: { ...DEFAULT_SETTINGS } });

/** Last 4 characters only, which is enough to tell two keys apart and no use to anyone. */
export function maskKey(key: string): string {
  const s = String(key || '');
  return s.length <= 4 ? '••••' : `••••••••${s.slice(-4)}`;
}

/** What the API and the UI are allowed to see. */
export function publicView(rec: ApiKeyRecord) {
  const { key, ...rest } = rec;
  return { ...rest, masked: maskKey(key) };
}

/**
 * The four env keys, if they hold real values.
 *
 * script, scenes and visual are all text calls against the same model, so they land in
 * the text pool; image is its own. Nothing is deleted from .env — this reads it. A key
 * that is still in .env and also in the store is the same key twice, which the dedupe
 * in migrate() collapses.
 */
function envKeys(): Array<{ key: string; category: KeyCategory; from: string }> {
  const from: Array<[string, KeyCategory]> = [
    ['GEMINI_KEY_SCRIPT', 'text'],
    ['GEMINI_KEY_SCENES', 'text'],
    ['GEMINI_KEY_VISUAL', 'text'],
    ['GEMINI_KEY_IMAGE', 'image'],
  ];
  const out: Array<{ key: string; category: KeyCategory; from: string }> = [];
  for (const [name, category] of from) {
    const value = String(process.env[name] || '').trim();
    // 'adc-not-used' was the documented placeholder while ADC was the live path. A
    // placeholder is not a credential and must not become one.
    if (!value || value.length < 20 || /adc-not-used/i.test(value)) continue;
    out.push({ key: value, category, from: name });
  }
  return out;
}

export function readKeyStore(): ApiKeyStore {
  try {
    const raw = JSON.parse(fs.readFileSync(keyStorePath(), 'utf-8'));
    if (raw?.version === 1 && Array.isArray(raw.keys)) return raw as ApiKeyStore;
  } catch { /* absent or unreadable — fall through to empty */ }
  return empty();
}

export function writeKeyStore(store: ApiKeyStore): void {
  const file = keyStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  try { fs.chmodSync(tmp, 0o600); } catch { /* not POSIX */ }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* not POSIX */ }
}

/**
 * Brings the .env keys into the store, once, without losing anything.
 *
 * Runs on every read and is idempotent: a key already in the store is matched by its
 * own value and skipped, so re-running cannot duplicate it and a key the operator
 * deliberately deleted does not come back — deletion writes the store, and the store
 * file existing is what marks migration as done.
 */
export function migrateEnvKeys(): { migrated: number; store: ApiKeyStore } {
  const store = readKeyStore();
  const storeExisted = fs.existsSync(keyStorePath());
  if (storeExisted) return { migrated: 0, store };

  const known = new Set(store.keys.map((k) => k.key));
  let migrated = 0;
  for (const { key, category, from } of envKeys()) {
    if (known.has(key)) continue;
    known.add(key);
    store.keys.push({
      id: crypto.randomUUID(),
      key,
      label: `Migrated from ${from}`,
      category,
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    migrated++;
  }
  if (migrated) {
    writeKeyStore(store);
    console.log(`[ApiKeys] Migrated ${migrated} key(s) from .env into ${keyStorePath()}`);
  }
  return { migrated, store };
}

/** Every key, migrating the .env ones in on first call. */
export function listKeys(): ApiKeyRecord[] {
  return migrateEnvKeys().store.keys;
}

/** Enabled keys for one category, in stored order. Rotation happens in geminiAuth. */
export function keysForCategory(category: KeyCategory): ApiKeyRecord[] {
  return listKeys().filter((k) => k.category === category && k.enabled);
}

export function addKey(input: { key: string; label?: string; category: KeyCategory }): ApiKeyRecord {
  const key = String(input.key || '').trim();
  if (key.length < 20) throw new Error('That does not look like an API key.');
  if (!isKeyCategory(input.category)) throw new Error(`Unknown category "${input.category}".`);

  const store = migrateEnvKeys().store;
  const existing = store.keys.find((k) => k.key === key);
  if (existing) throw new Error(`That key is already saved as "${existing.label || existing.id}".`);

  const rec: ApiKeyRecord = {
    id: crypto.randomUUID(),
    key,
    label: String(input.label || '').trim() || undefined,
    category: input.category,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  store.keys.push(rec);
  writeKeyStore(store);
  return rec;
}

export function updateKey(id: string, mutate: (k: ApiKeyRecord) => void): ApiKeyRecord | undefined {
  const store = migrateEnvKeys().store;
  const rec = store.keys.find((k) => k.id === id);
  if (!rec) return undefined;
  mutate(rec);
  writeKeyStore(store);
  return rec;
}

export function removeKey(id: string): boolean {
  const store = migrateEnvKeys().store;
  const before = store.keys.length;
  store.keys = store.keys.filter((k) => k.id !== id);
  if (store.keys.length === before) return false;
  writeKeyStore(store);
  return true;
}

/** Stamps when a key was last handed out, so the UI can show the pool is being used. */
export function touchKey(id: string): void {
  try {
    updateKey(id, (k) => { k.lastUsedAt = new Date().toISOString(); });
  } catch { /* recording use must never fail a request */ }
}

/** Which provider image generation is pointed at. Never inferred from quota. */
export function getImageProvider(): ImageProvider {
  const stored = readKeyStore().settings?.imageProvider;
  return isImageProvider(stored) ? stored : DEFAULT_SETTINGS.imageProvider;
}

export function setImageProvider(provider: ImageProvider): ImageProvider {
  if (!isImageProvider(provider)) throw new Error(`Unknown image provider "${provider}".`);
  const store = migrateEnvKeys().store;
  store.settings = { ...DEFAULT_SETTINGS, ...store.settings, imageProvider: provider };
  writeKeyStore(store);
  return provider;
}
