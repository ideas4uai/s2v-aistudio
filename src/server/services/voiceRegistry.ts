import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { slugifyTitle } from '../../utils/filename.js';

/**
 * Ownership, consent and audit records for locally cloned voices.
 *
 * A cloned voice can impersonate a real person, so the record of who created it,
 * what they consented to, and where it has been used is part of the feature rather
 * than an add-on. Everything here is on local disk in the same shape as the rest of
 * the project's state (`outputs/*.json`): a JSON registry plus an append-only
 * JSONL audit log. No database, but queryable through the routes in voices.ts.
 *
 * Layout, all gitignored (voice samples are personal data and checkpoints are large):
 *   voices/cloned/<id>.pt          reusable speaker conditionals
 *   voices/cloned/<id>.sample.wav  the original upload, kept for provenance + deletion
 *   voices/registry.json           ClonedVoice[]
 *   voices/audit.jsonl             one AuditEvent per line
 */

/** Overridable so tests can exercise the real read/write paths without writing into
 *  the working copy — the registry names real users and stores real voice samples. */
export const VOICES_DIR = process.env.VOICES_DIR || path.join(process.cwd(), 'voices');
export const CLONED_DIR = path.join(VOICES_DIR, 'cloned');
const REGISTRY = path.join(VOICES_DIR, 'registry.json');
const AUDIT = path.join(VOICES_DIR, 'audit.jsonl');

/** The exact wording a user must accept. Stored verbatim on the record so that a
 *  later change to this text cannot rewrite what somebody actually agreed to. */
export const CONSENT_STATEMENT =
  'I own this voice or have explicit permission from the speaker to clone it, and I ' +
  'accept responsibility for how the cloned voice is used.';

export type ClonedVoice = {
  id: string;
  name: string;
  ownerUid: string;
  createdAt: string;
  /** Verbatim text the owner accepted, plus when and from where. */
  consent: { statement: string; acceptedAt: string; ip?: string };
  sample: { originalName: string; bytes: number; sha256: string; storedPath: string };
  checkpointPath: string;
  /** Wall-clock cost of the one-time cloning step, reported in the UI. */
  cloneMs?: number;
  peakRssMb?: number | null;
};

export type AuditEvent = {
  at: string;
  event: 'clone' | 'use' | 'delete';
  voiceId: string;
  voiceName?: string;
  ownerUid: string;
  actorUid: string;
  projectId?: string;
  sampleSha256?: string;
  detail?: string;
};

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export async function listVoices(): Promise<ClonedVoice[]> {
  return readJson<ClonedVoice[]>(REGISTRY, []);
}

/**
 * Voices this user may use. Owner-only by default: there is no sharing mechanism,
 * and the absence of one must read as "denied", not as "unrestricted".
 */
export async function listVoicesForUser(uid: string): Promise<ClonedVoice[]> {
  return (await listVoices()).filter((v) => v.ownerUid === uid);
}

export async function getVoiceForUser(id: string, uid: string): Promise<ClonedVoice | null> {
  return (await listVoices()).find((v) => v.id === id && v.ownerUid === uid) ?? null;
}

async function writeRegistry(voices: ClonedVoice[]) {
  await fs.mkdir(VOICES_DIR, { recursive: true });
  await fs.writeFile(REGISTRY, JSON.stringify(voices, null, 2), 'utf8');
}

export async function addVoice(voice: ClonedVoice): Promise<void> {
  const voices = await listVoices();
  voices.push(voice);
  await writeRegistry(voices);
}

/** Deletes the record, the checkpoint and the original sample. The audit trail for
 *  the voice goes with it — a user who asks for their voice data to be removed is
 *  asking for the sample too, and a trail pointing at deleted files helps nobody.
 *  A single tombstone event is kept so the deletion itself is accounted for. */
export async function deleteVoice(id: string, actorUid: string): Promise<ClonedVoice | null> {
  const voices = await listVoices();
  const voice = voices.find((v) => v.id === id);
  if (!voice) return null;

  await writeRegistry(voices.filter((v) => v.id !== id));
  for (const f of [voice.checkpointPath, voice.sample.storedPath]) {
    await fs.rm(f, { force: true }).catch(() => {});
  }

  const kept = (await readAudit()).filter((e) => e.voiceId !== id);
  await fs.writeFile(AUDIT, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
  await appendAudit({
    at: new Date().toISOString(), event: 'delete', voiceId: id, voiceName: voice.name,
    ownerUid: voice.ownerUid, actorUid, detail: 'voice, sample and prior audit entries erased',
  });
  return voice;
}

export async function appendAudit(event: AuditEvent): Promise<void> {
  await fs.mkdir(VOICES_DIR, { recursive: true });
  await fs.appendFile(AUDIT, JSON.stringify(event) + '\n', 'utf8');
}

export async function readAudit(): Promise<AuditEvent[]> {
  try {
    return (await fs.readFile(AUDIT, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditEvent);
  } catch {
    return [];
  }
}

/** Audit entries a user is entitled to see: the ones about their own voices. */
export async function readAuditForUser(uid: string, voiceId?: string): Promise<AuditEvent[]> {
  return (await readAudit()).filter((e) => e.ownerUid === uid && (!voiceId || e.voiceId === voiceId));
}

/** Records that a render used a cloned voice. Called from the synthesis path, so a
 *  voice cannot end up in a video without leaving a trace. */
export async function recordUse(voice: ClonedVoice, projectId: string): Promise<void> {
  await appendAudit({
    at: new Date().toISOString(), event: 'use', voiceId: voice.id, voiceName: voice.name,
    ownerUid: voice.ownerUid, actorUid: voice.ownerUid, projectId,
  });
}

export function newVoiceId(): string {
  return crypto.randomUUID();
}

/** Filenames are derived from user-supplied voice names, so they go through the
 *  same sanitiser as project titles rather than a second, subtly different one. */
export function voiceFileStem(name: string, id: string): string {
  return `${slugifyTitle(name) || 'voice'}-${id.slice(0, 8)}`;
}

export function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
