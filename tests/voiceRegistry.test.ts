import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// Point the registry at a scratch directory before importing it: VOICES_DIR is
// resolved at module load, and the real one holds voice samples and real user ids.
const TEST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-registry-test-'));
process.env.VOICES_DIR = TEST_DIR;

const {
  CONSENT_STATEMENT, addVoice, appendAudit, deleteVoice, getVoiceForUser, listVoices,
  listVoicesForUser, newVoiceId, readAudit, readAuditForUser, recordUse, sha256, voiceFileStem,
} = await import('../src/server/services/voiceRegistry.js');

type Voice = Awaited<ReturnType<typeof listVoices>>[number];

const makeVoice = (over: Partial<Voice> = {}): Voice => ({
  id: newVoiceId(),
  name: 'Test Voice',
  ownerUid: 'alice',
  createdAt: new Date().toISOString(),
  consent: { statement: CONSENT_STATEMENT, acceptedAt: new Date().toISOString() },
  sample: { originalName: 'me.wav', bytes: 1234, sha256: 'abc', storedPath: path.join(TEST_DIR, 'nope.wav') },
  checkpointPath: path.join(TEST_DIR, 'nope.pt'),
  ...over,
});

beforeEach(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  await fs.mkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

describe('cloned voices are owner-only by default', () => {
  it('does not show one user another user\'s voice', async () => {
    await addVoice(makeVoice({ ownerUid: 'alice', name: 'Alice voice' }));
    await addVoice(makeVoice({ ownerUid: 'bob', name: 'Bob voice' }));

    expect((await listVoicesForUser('alice')).map((v) => v.name)).toEqual(['Alice voice']);
    expect((await listVoicesForUser('bob')).map((v) => v.name)).toEqual(['Bob voice']);
  });

  it('refuses a lookup by a user who does not own the voice', async () => {
    const v = makeVoice({ ownerUid: 'alice' });
    await addVoice(v);

    expect(await getVoiceForUser(v.id, 'alice')).not.toBeNull();
    // The absence of a sharing mechanism must read as denied, not as unrestricted.
    expect(await getVoiceForUser(v.id, 'bob')).toBeNull();
  });

  it('returns null for an unknown id rather than throwing', async () => {
    expect(await getVoiceForUser('no-such-voice', 'alice')).toBeNull();
  });
});

describe('consent is recorded, not just requested', () => {
  it('stores the accepted wording verbatim on the voice', async () => {
    const v = makeVoice();
    await addVoice(v);
    const stored = await getVoiceForUser(v.id, 'alice');
    expect(stored!.consent.statement).toBe(CONSENT_STATEMENT);
    expect(stored!.consent.acceptedAt).toBeTruthy();
  });

  it('states ownership or permission in the required wording', () => {
    expect(CONSENT_STATEMENT).toMatch(/own this voice or have explicit permission/i);
  });
});

describe('audit trail', () => {
  it('records every use of a voice against a project', async () => {
    const v = makeVoice();
    await addVoice(v);
    await recordUse(v, 'project-1');
    await recordUse(v, 'project-2');

    const events = await readAuditForUser('alice');
    expect(events.filter((e) => e.event === 'use').map((e) => e.projectId)).toEqual(['project-1', 'project-2']);
  });

  it('scopes the audit trail to the asking user', async () => {
    const a = makeVoice({ ownerUid: 'alice' });
    const b = makeVoice({ ownerUid: 'bob' });
    await addVoice(a); await addVoice(b);
    await recordUse(a, 'p-alice');
    await recordUse(b, 'p-bob');

    expect((await readAuditForUser('alice')).map((e) => e.projectId)).toEqual(['p-alice']);
    expect((await readAuditForUser('bob')).map((e) => e.projectId)).toEqual(['p-bob']);
  });

  it('can filter to a single voice', async () => {
    const a = makeVoice({ ownerUid: 'alice' });
    const b = makeVoice({ ownerUid: 'alice' });
    await addVoice(a); await addVoice(b);
    await recordUse(a, 'p1');
    await recordUse(b, 'p2');

    expect((await readAuditForUser('alice', a.id)).map((e) => e.projectId)).toEqual(['p1']);
  });

  it('survives a missing audit file', async () => {
    expect(await readAudit()).toEqual([]);
  });
});

describe('deletion', () => {
  it('removes the voice, its files and its audit entries, leaving a tombstone', async () => {
    const checkpointPath = path.join(TEST_DIR, 'ck.pt');
    const storedPath = path.join(TEST_DIR, 'sample.wav');
    await fs.writeFile(checkpointPath, 'ck');
    await fs.writeFile(storedPath, 'wav');

    const v = makeVoice({ checkpointPath, sample: { ...makeVoice().sample, storedPath } });
    await addVoice(v);
    await recordUse(v, 'p1');

    await deleteVoice(v.id, 'alice');

    expect(await listVoices()).toEqual([]);
    await expect(fs.access(checkpointPath)).rejects.toThrow();
    await expect(fs.access(storedPath)).rejects.toThrow();

    // The prior trail is erased with the data, but the deletion itself is accounted for.
    const events = await readAudit();
    expect(events.map((e) => e.event)).toEqual(['delete']);
  });

  it('leaves other users\' voices and audit entries alone', async () => {
    const a = makeVoice({ ownerUid: 'alice' });
    const b = makeVoice({ ownerUid: 'bob' });
    await addVoice(a); await addVoice(b);
    await recordUse(a, 'p-alice');
    await recordUse(b, 'p-bob');

    await deleteVoice(a.id, 'alice');

    expect((await listVoices()).map((v) => v.ownerUid)).toEqual(['bob']);
    expect((await readAuditForUser('bob')).some((e) => e.projectId === 'p-bob')).toBe(true);
  });

  it('returns null when there is nothing to delete', async () => {
    expect(await deleteVoice('missing', 'alice')).toBeNull();
  });
});

describe('voiceFileStem — user-supplied names reach the filesystem', () => {
  it('reuses the project-title sanitiser rather than a second one', () => {
    expect(voiceFileStem('My Voice', 'abcdef12-3456')).toBe('my-voice-abcdef12');
  });

  it('strips path traversal and separators', () => {
    const stem = voiceFileStem('../../etc/passwd', 'abcdef12-3456');
    expect(stem).not.toContain('..');
    expect(stem).not.toContain('/');
    expect(stem).not.toContain('\\');
  });

  it('falls back to a generic stem for a name with no ASCII', () => {
    expect(voiceFileStem('हिंदी आवाज़', 'abcdef12-3456')).toBe('voice-abcdef12');
  });

  it('keeps the id so two voices with the same name cannot collide', () => {
    const a = voiceFileStem('Same', 'aaaaaaaa-1111');
    const b = voiceFileStem('Same', 'bbbbbbbb-2222');
    expect(a).not.toBe(b);
  });
});

describe('sample fingerprinting', () => {
  it('hashes the sample so a record can be tied back to the audio it came from', () => {
    expect(sha256(Buffer.from('hello'))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});

describe('appendAudit', () => {
  it('creates the log directory on first write', async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    await appendAudit({
      at: new Date().toISOString(), event: 'clone', voiceId: 'v1',
      ownerUid: 'alice', actorUid: 'alice',
    });
    expect(await readAudit()).toHaveLength(1);
  });
});
