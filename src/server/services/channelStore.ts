import fs from 'fs';
import path from 'path';

/**
 * Every YouTube channel this installation can publish to, and the credentials for each.
 *
 * ── Why one file rather than one file per channel ──────────────────────────────
 * The single-channel store was config/youtube-tokens.json and this stays that file.
 * Per-channel files would mean a directory to create, a glob to read, N chmod calls to
 * get right and N chances to leave one world-readable, and a partial write would leave
 * the set inconsistent with no way to tell. One file keeps the security posture that
 * already exists — one gitignore line, one 0600, one atomic replace — and channel
 * lookup becomes a map read.
 *
 * ── Why connecting is per channel, not once for the account ────────────────────
 * `channels.list?mine=true` returns the channel the CONSENT was granted for, not every
 * channel the Google account owns. Brand-Account channels each have their own identity
 * and Google's consent screen makes the operator pick one; the token is bound to that
 * pick. The parameter that means "everything this account manages" is
 * `managedByMe=true`, and it requires `onBehalfOfContentOwner` — a YouTube CMS
 * credential issued to multi-channel networks, not to ordinary creators.
 *
 * So connecting three channels is three consents. addChannel() is written to be called
 * repeatedly and to merge rather than replace, which is what makes that bearable: the
 * operator runs the flow once per channel and the set accumulates.
 */

/**
 * Stands in for a pre-channels connection whose channel id was never recorded.
 *
 * Not a real YouTube id, so anything that compares against one has to skip it — see the
 * upload's channel-mismatch check, which would otherwise reject every legacy upload.
 */
export const LEGACY_CHANNEL_KEY = 'legacy-single-channel';

export type ChannelRecord = {
  /** YouTube's own channel id (UC...). The primary key — stable, and what uploads target. */
  channelId: string;
  /** The channel's display name, as YouTube reports it. Refreshed on every reconnect. */
  title: string;
  refreshToken: string;
  accessToken?: string;
  expiresAtMs?: number;
  scopes?: string[];
  /**
   * Watermark for this channel, as an absolute path on disk. Absent means this channel
   * has no watermark and renders/thumbnails are left alone — an unset logo must never
   * become a placeholder burned into a video.
   */
  logoPath?: string;
  connectedAt: string;
  updatedAt: string;
};

export type ChannelStore = {
  version: 2;
  /**
   * What the last upload targeted. The publish UI defaults to it when a project carries
   * no channel of its own — see the default order in the publish route.
   */
  lastUsedChannelId?: string;
  channels: Record<string, ChannelRecord>;
};

export function storePath(): string {
  return process.env.YOUTUBE_TOKEN_PATH || path.join(process.cwd(), 'config', 'youtube-tokens.json');
}

export function logoDir(): string {
  return process.env.CHANNEL_LOGO_DIR || path.join(process.cwd(), 'config', 'channel-logos');
}

const empty = (): ChannelStore => ({ version: 2, channels: {} });

/**
 * The v1 file was a single channel's tokens at the top level. Read it as a one-channel
 * store rather than asking anyone to reconnect: the refresh token in it is still valid
 * for the channel it was issued for, and silently dropping it would disconnect a
 * working install on upgrade.
 *
 * Converted in memory on every read and only written back in v2 shape when something
 * changes, so a downgrade does not corrupt anything that was never touched.
 */
function migrate(raw: any): ChannelStore {
  if (!raw || typeof raw !== 'object') return empty();
  if (raw.version === 2 && raw.channels) return raw as ChannelStore;

  if (raw.refreshToken) {
    const now = raw.connectedAt || new Date().toISOString();
    // A v1 file could carry a refresh token and NO channel id: the old connect flow
    // logged a warning and carried on when the channel-name lookup failed, and the
    // upload worked anyway because the token itself decides where a video lands. Those
    // installs are still connected and must keep working, so they get a placeholder key
    // rather than being read as "nothing is connected".
    const key = raw.channelId || LEGACY_CHANNEL_KEY;
    return {
      version: 2,
      lastUsedChannelId: key,
      channels: {
        [key]: {
          channelId: key,
          title: raw.channelTitle || raw.channelId || 'Connected channel',
          refreshToken: raw.refreshToken,
          accessToken: raw.accessToken,
          expiresAtMs: raw.expiresAtMs,
          scopes: raw.scopes,
          connectedAt: now,
          updatedAt: now,
        },
      },
    };
  }
  return empty();
}

export function readStore(): ChannelStore {
  try {
    return migrate(JSON.parse(fs.readFileSync(storePath(), 'utf-8')));
  } catch {
    return empty();
  }
}

export function writeStore(store: ChannelStore): void {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename: a refresh token half-written is a channel that can no longer
  // publish, and there is no way to recover it except another consent flow.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  try { fs.chmodSync(tmp, 0o600); } catch { /* not POSIX */ }
  fs.renameSync(tmp, file);
  // A refresh token is a long-lived credential to publish on someone's channel.
  // chmod is a no-op on Windows but costs nothing and matters everywhere else.
  try { fs.chmodSync(file, 0o600); } catch { /* not POSIX */ }
}

export function listChannels(): ChannelRecord[] {
  return Object.values(readStore().channels)
    .sort((a, b) => a.title.localeCompare(b.title));
}

export function getChannel(channelId?: string | null): ChannelRecord | undefined {
  if (!channelId) return undefined;
  return readStore().channels[channelId];
}

/**
 * Add or update one channel, keeping every other channel untouched.
 *
 * Merge, not replace: re-consenting to a channel that is already connected must not
 * drop the other two, and it must not lose the logo that was uploaded for it — Google
 * knows nothing about that, so a naive overwrite would silently un-brand the channel.
 */
export function addChannel(
  rec: Omit<ChannelRecord, 'connectedAt' | 'updatedAt'> & { connectedAt?: string },
): ChannelRecord {
  const store = readStore();
  const now = new Date().toISOString();
  const existing = store.channels[rec.channelId];
  const merged: ChannelRecord = {
    ...existing,
    ...rec,
    logoPath: rec.logoPath ?? existing?.logoPath,
    connectedAt: rec.connectedAt || existing?.connectedAt || now,
    updatedAt: now,
  };
  store.channels[rec.channelId] = merged;
  if (!store.lastUsedChannelId) store.lastUsedChannelId = rec.channelId;
  writeStore(store);
  return merged;
}

/** Applies a change to one channel. Returns false if that channel is not connected. */
export function updateChannel(channelId: string, mutate: (c: ChannelRecord) => void): boolean {
  const store = readStore();
  const rec = store.channels[channelId];
  if (!rec) return false;
  mutate(rec);
  rec.updatedAt = new Date().toISOString();
  writeStore(store);
  return true;
}

export function removeChannel(channelId: string): boolean {
  const store = readStore();
  if (!store.channels[channelId]) return false;
  delete store.channels[channelId];
  if (store.lastUsedChannelId === channelId) {
    // Do not leave the publish UI defaulting to a channel that is gone.
    store.lastUsedChannelId = Object.keys(store.channels)[0];
  }
  writeStore(store);
  return true;
}

export function setLastUsed(channelId: string): void {
  updateChannelStoreField((s) => { s.lastUsedChannelId = channelId; });
}

function updateChannelStoreField(mutate: (s: ChannelStore) => void): void {
  const store = readStore();
  mutate(store);
  writeStore(store);
}

/**
 * Which channel an upload should target, most specific first.
 *
 * The project's own tag wins, because it was chosen when the project was created and
 * says what this content IS. Last-used is the fallback for an untagged project and is
 * a convenience, never an override — publishing AI QA Engineer content to a personal
 * channel because that is what was published last is exactly the mistake this order
 * exists to prevent. Returns undefined rather than guessing when nothing is connected.
 */
export function resolveChannel(opts: {
  requested?: string | null;
  projectChannelId?: string | null;
}): ChannelRecord | undefined {
  const store = readStore();
  const pick = (id?: string | null) => (id ? store.channels[id] : undefined);
  return pick(opts.requested)
    || pick(opts.projectChannelId)
    || pick(store.lastUsedChannelId)
    || Object.values(store.channels)[0];
}
