import { Router } from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import {
  KOKORO_VOICES, DEFAULT_ENGINE, gradeRank, isSilentWav, SilentSynthesisError,
} from '../services/ttsService.js';
import { sidecarRequest, sidecarAvailable } from '../services/ttsSidecar.js';
import {
  CLONED_DIR, CONSENT_STATEMENT, addVoice, appendAudit, deleteVoice, getVoiceForUser,
  listVoicesForUser, newVoiceId, readAuditForUser, sha256, voiceFileStem, type ClonedVoice,
} from '../services/voiceRegistry.js';

export const voicesRouter = Router();

/**
 * Voice Studio API: browse voices, preview them, clone one locally, and manage the
 * ownership/consent/audit records that come with a cloned voice.
 *
 * The previous contents of this file cloned voices through the ElevenLabs API. That
 * path was dead — no ELEVENLABS_API_KEY is configured and there is no ElevenLabs
 * synthesis path anywhere, so a voice cloned through it could never be used in a
 * render (ttsService warns about exactly this for settings.customVoiceId). Cloning
 * now runs locally, which is also the only way the voice sample never leaves the
 * machine.
 */

// 25MB ceiling: a 30-second sample is ~5MB as WAV, so this is generous for the
// documented 10-30s guidance while still refusing an accidental video upload.
const upload = multer({
  dest: path.join(os.tmpdir(), 'ais-voice-uploads'),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/**
 * Kept short on purpose. Kokoro synthesises at roughly 1.18x realtime on this CPU, so
 * preview latency is essentially the length of the clip: the previous 74-character line
 * produced 5.5s of audio and took 4.7-6.5s to appear on every first click of a voice.
 * The sidecar is not the problem — measured, it stays warm and the 3rd and 4th distinct
 * voices cost the same as the 1st. Auditioning a voice needs a couple of seconds of it,
 * not a paragraph.
 */
const PREVIEW_TEXT = 'Hi, this is how I sound.';

/** Short digest of the preview text, so changing it invalidates previously cached clips
 *  instead of serving audio of a sentence that is no longer the preview sentence. */
const PREVIEW_TAG = sha256(Buffer.from(PREVIEW_TEXT)).slice(0, 8);

function uid(req: any): string {
  return req.user?.uid || 'dev-user';
}

/** Everything the voice picker needs, in one call so the UI has a single source of truth. */
voicesRouter.get('/catalog', async (req, res) => {
  try {
    const cloned = await listVoicesForUser(uid(req));
    res.json({
      defaultEngine: DEFAULT_ENGINE,
      previewText: PREVIEW_TEXT,
      kokoro: Object.entries(KOKORO_VOICES)
        .map(([id, v]) => ({ id, ...v }))
        .sort((a, b) => a.lang.localeCompare(b.lang) || gradeRank(a.grade) - gradeRank(b.grade)),
      // Piper stays selectable as the explicit offline engine. These are style names,
      // not model names — the model behind each is chosen in ttsService.
      piper: [
        { id: 'professional', label: 'Professional & Clear' },
        { id: 'energetic', label: 'Energetic & Upbeat' },
        { id: 'dramatic', label: 'Dramatic & Deep' },
        { id: 'casual', label: 'Casual & Conversational' },
        { id: 'calm', label: 'Calm & Measured' },
      ],
      cloned: cloned.map((v) => ({ id: v.id, name: v.name, createdAt: v.createdAt })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Whether each engine can actually run, so the UI can say so instead of failing later. */
voicesRouter.get('/health', async (_req, res) => {
  const [kokoro, clone] = await Promise.all([sidecarAvailable('kokoro'), sidecarAvailable('clone')]);
  res.json({ kokoro, clone, piperConfigured: Boolean(process.env.PIPER_BIN_PATH) });
});

/**
 * Synthesises a few seconds of fixed sample text so a voice can be heard before it is
 * chosen.
 *
 * The clip is cached on disk per voice. The text is fixed, so a preview is the same
 * audio every time — and auditioning is a browsing activity, so the same voice gets
 * clicked repeatedly. That matters most for cloned voices, where one preview costs
 * over a minute of CPU.
 */
voicesRouter.post('/preview', async (req: any, res) => {
  const { voice, engine = 'kokoro', clonedVoiceId } = req.body || {};
  try {
    const dir = path.join(os.tmpdir(), 'ais-voice-previews');
    await fs.mkdir(dir, { recursive: true });
    const out = path.join(dir, `preview-${engine}-${clonedVoiceId || voice}-${PREVIEW_TAG}.wav`);

    try {
      const cached = await fs.readFile(out);
      return res.type('audio/wav').send(cached);
    } catch { /* not previewed yet — synthesize below */ }

    if (clonedVoiceId) {
      const v = await getVoiceForUser(clonedVoiceId, uid(req));
      if (!v) return res.status(404).json({ error: 'Cloned voice not found for this account.' });
      await sidecarRequest('clone', {
        op: 'synth', engine: 'chatterbox', conds: v.checkpointPath, text: PREVIEW_TEXT, out,
      });
    } else {
      if (!KOKORO_VOICES[voice]) {
        return res.status(400).json({ error: `Unknown Kokoro voice "${voice}".` });
      }
      await sidecarRequest('kokoro', {
        op: 'synth', engine: 'kokoro', voice, speed: 1.0, text: PREVIEW_TEXT, out,
      });
    }

    // The same guard the render path uses: a preview that is silence would otherwise
    // look like a broken speaker rather than a broken voice.
    if (await isSilentWav(out)) throw new SilentSynthesisError(clonedVoiceId || voice, 'preview', engine);

    res.type('audio/wav').send(await fs.readFile(out));
  } catch (err: any) {
    console.error('[Voices] Preview failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Clones a voice from an uploaded sample, on this machine.
 *
 * Consent is enforced here rather than in the UI: a checkbox is a suggestion, a
 * server-side rejection is a requirement. The accepted wording is stored verbatim on
 * the record so a later edit to CONSENT_STATEMENT cannot retroactively change what
 * somebody agreed to.
 */
voicesRouter.post('/clone', upload.single('sample'), async (req: any, res) => {
  const file = req.file;
  const cleanup = async () => { if (file) await fs.rm(file.path, { force: true }).catch(() => {}); };

  try {
    const { name, consent } = req.body || {};
    if (!file) return res.status(400).json({ error: 'No voice sample uploaded.' });
    if (!name?.trim()) return res.status(400).json({ error: 'A name for the voice is required.' });
    if (consent !== 'true' && consent !== true) {
      return res.status(400).json({
        error: 'Cloning requires explicit consent.',
        required: CONSENT_STATEMENT,
      });
    }

    const owner = uid(req);
    const id = newVoiceId();
    const stem = voiceFileStem(name, id);
    await fs.mkdir(CLONED_DIR, { recursive: true });

    const bytes = await fs.readFile(file.path);
    const ext = path.extname(file.originalname || '.wav') || '.wav';
    const samplePath = path.join(CLONED_DIR, `${stem}.sample${ext}`);
    await fs.writeFile(samplePath, bytes);

    const checkpointPath = path.join(CLONED_DIR, `${stem}.pt`);
    console.log(`[Voices] Cloning "${name}" for ${owner} from ${file.originalname} (${bytes.length} bytes)`);
    const result = await sidecarRequest('clone', { op: 'clone', sample: samplePath, out: checkpointPath });

    const voice: ClonedVoice = {
      id,
      name: name.trim(),
      ownerUid: owner,
      createdAt: new Date().toISOString(),
      consent: {
        statement: CONSENT_STATEMENT,
        acceptedAt: new Date().toISOString(),
        ip: req.ip,
      },
      sample: {
        originalName: file.originalname,
        bytes: bytes.length,
        sha256: sha256(bytes),
        storedPath: samplePath,
      },
      checkpointPath,
      cloneMs: result.ms,
      peakRssMb: result.peak_rss_mb ?? null,
    };

    await addVoice(voice);
    await appendAudit({
      at: voice.createdAt, event: 'clone', voiceId: id, voiceName: voice.name,
      ownerUid: owner, actorUid: owner, sampleSha256: voice.sample.sha256,
      detail: `chatterbox-tts 0.5B (CPU), ${result.ms}ms, peak RSS ${result.peak_rss_mb ?? '?'}MB`,
    });

    console.log(`[Voices] Cloned "${voice.name}" in ${result.ms}ms (peak RSS ${result.peak_rss_mb}MB)`);
    res.json({
      success: true,
      voice: { id, name: voice.name, createdAt: voice.createdAt },
      cloneMs: result.ms,
      peakRssMb: result.peak_rss_mb ?? null,
    });
  } catch (err: any) {
    console.error('[Voices] Cloning failed:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    await cleanup();
  }
});

/** Cloned voices belonging to the caller. There is deliberately no "all voices" route. */
voicesRouter.get('/cloned', async (req: any, res) => {
  try {
    const voices = await listVoicesForUser(uid(req));
    res.json(voices.map((v) => ({
      id: v.id, name: v.name, createdAt: v.createdAt, cloneMs: v.cloneMs,
      peakRssMb: v.peakRssMb, sample: { originalName: v.sample.originalName, bytes: v.sample.bytes },
      consent: v.consent,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** The audit trail for the caller's own voices: who cloned what, when, and where it was used. */
voicesRouter.get('/audit', async (req: any, res) => {
  try {
    res.json(await readAuditForUser(uid(req), req.query.voiceId as string | undefined));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Deletes a cloned voice, its checkpoint, the original sample and its audit entries. */
voicesRouter.delete('/cloned/:id', async (req: any, res) => {
  try {
    const owner = uid(req);
    if (!(await getVoiceForUser(req.params.id, owner))) {
      return res.status(404).json({ error: 'Cloned voice not found for this account.' });
    }
    const removed = await deleteVoice(req.params.id, owner);
    res.json({ success: true, deleted: removed?.name });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
