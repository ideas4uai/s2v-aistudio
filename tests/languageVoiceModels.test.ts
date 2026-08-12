import { describe, it, expect, vi } from 'vitest';
import { resolveVoiceModel, MissingVoiceModelError, isSilentWav } from '../src/server/services/ttsService.js';
import fsSync from 'fs';
import os from 'os';
import pathMod from 'path';

const VOICES = 'C:/piper/voices';

// Stands in for the on-disk check so these tests don't depend on which models
// happen to be installed on the machine running them.
const installed = (...models: string[]) => async (m: string) => models.includes(m);

describe('resolveVoiceModel — missing model must never become silent audio', () => {
  it('uses the mapped Hindi model when it is installed', async () => {
    const m = await resolveVoiceModel(VOICES, 'en_US-lessac-medium', 'hindi', installed('hi_IN-rohan-medium'));
    expect(m).toBe('hi_IN-rohan-medium');
  });

  it('uses the mapped Telugu model when it is installed', async () => {
    const m = await resolveVoiceModel(VOICES, 'en_US-lessac-medium', 'telugu', installed('te_IN-maya-medium'));
    expect(m).toBe('te_IN-maya-medium');
  });

  it('THROWS for Spanish, which the product no longer offers', async () => {
    // Spanish was dropped from both dropdowns and from LANGUAGE_VOICES. The model file
    // may well still be sitting in the voices dir, so "installed" is not the question —
    // an unoffered language must fail loudly rather than quietly still work.
    await expect(
      resolveVoiceModel(VOICES, 'en_US-lessac-medium', 'spanish', installed('es_ES-davefx-medium')),
    ).rejects.toBeInstanceOf(MissingVoiceModelError);
  });

  // The actual bug: this used to fall through to a Piper failure that the caller
  // swallowed, producing a "completed" render with no audio at all.
  it('THROWS rather than substituting English when the Hindi model is absent', async () => {
    await expect(
      resolveVoiceModel(VOICES, 'en_US-lessac-medium', 'hindi', installed('en_US-lessac-medium')),
    ).rejects.toBeInstanceOf(MissingVoiceModelError);
  });

  it('THROWS when the Telugu model is absent', async () => {
    await expect(
      resolveVoiceModel(VOICES, 'en_US-lessac-medium', 'telugu', installed('en_US-lessac-medium')),
    ).rejects.toBeInstanceOf(MissingVoiceModelError);
  });

  it('THROWS for a language with no model mapping at all', async () => {
    await expect(
      resolveVoiceModel(VOICES, 'en_US-lessac-medium', 'french', installed('en_US-lessac-medium')),
    ).rejects.toBeInstanceOf(MissingVoiceModelError);
  });

  it('names the model, the language and where to get it in the error', async () => {
    const err = await resolveVoiceModel(VOICES, 'en_US-lessac-medium', 'telugu', installed()).catch((e) => e);
    expect(err.message).toContain('te_IN-maya-medium');
    expect(err.message).toContain('telugu');
    expect(err.message).toContain('huggingface.co/rhasspy/piper-voices');
    expect(err.message).toContain(VOICES);
    expect(err.message).toContain('silent audio');
  });

  it('lists the supported languages when the language has no mapping at all', async () => {
    const err = await resolveVoiceModel(VOICES, 'en_US-lessac-medium', 'french', installed()).catch((e) => e);
    expect(err.modelName).toBeNull();
    for (const supported of ['english', 'hindi', 'telugu']) {
      expect(err.message).toContain(supported);
    }
    expect(err.message).not.toContain('spanish');
  });

  it('falls back to the default English voice with a warning when an English style voice is absent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = await resolveVoiceModel(VOICES, 'en_US-ryan-high', 'english', installed('en_US-lessac-medium'));
    expect(m).toBe('en_US-lessac-medium');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('en_US-ryan-high'));
    warn.mockRestore();
  });

  it('keeps the requested English voice when it IS installed', async () => {
    const m = await resolveVoiceModel(VOICES, 'en_US-ryan-high', 'english', installed('en_US-ryan-high', 'en_US-lessac-medium'));
    expect(m).toBe('en_US-ryan-high');
  });

  it('THROWS when no English voice at all is installed', async () => {
    await expect(
      resolveVoiceModel(VOICES, 'en_US-ryan-high', 'english', installed()),
    ).rejects.toBeInstanceOf(MissingVoiceModelError);
  });
});

// Piper exits 0 even when it synthesizes nothing, so this check — not the exit
// code — is what stops a silent track being cached and shipped as a real render.
describe('isSilentWav — a "successful" synth that is actually silence', () => {
  const writeWav = (name: string, samples: number[]) => {
    const data = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22); header.writeUInt32LE(22050, 24); header.writeUInt32LE(44100, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(data.length, 40);
    const p = pathMod.join(os.tmpdir(), `s2v-test-${name}-${Date.now()}.wav`);
    fsSync.writeFileSync(p, Buffer.concat([header, data]));
    return p;
  };

  it('flags an all-zero track as silent', async () => {
    const p = writeWav('silent', new Array(4000).fill(0));
    expect(await isSilentWav(p)).toBe(true);
    fsSync.unlinkSync(p);
  });

  it('does not flag real speech-level audio as silent', async () => {
    const p = writeWav('speech', Array.from({ length: 4000 }, (_, i) => Math.round(9000 * Math.sin(i / 8))));
    expect(await isSilentWav(p)).toBe(false);
    fsSync.unlinkSync(p);
  });

  it('treats dither/noise below the audible floor as silent', async () => {
    const p = writeWav('dither', Array.from({ length: 4000 }, (_, i) => (i % 2 ? 3 : -3)));
    expect(await isSilentWav(p)).toBe(true);
    fsSync.unlinkSync(p);
  });
});

describe('every language the UI offers maps to a real model on this machine', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const dir = process.env.PIPER_VOICES_DIR;

  // Both dropdowns, in the value formats they actually send. CreateProject sends the
  // ISO code, ProjectEditor sends the English name — and the set is now exactly
  // English, Hindi and Telugu in both.
  const UI_LANGUAGES = ['en', 'hi', 'te', 'English', 'Hindi', 'Telugu'];
  const toLang = (ui: string) => {
    const raw = ui.toLowerCase();
    return raw === 'te' ? 'telugu' : raw === 'hi' ? 'hindi' : raw === 'en' ? 'english' : raw;
  };

  for (const ui of UI_LANGUAGES) {
    it(`"${ui}" resolves to an installed model`, async () => {
      if (!dir) return; // no Piper configured on this machine — nothing to assert
      const model = await resolveVoiceModel(dir, 'en_US-lessac-medium', toLang(ui));
      expect(fs.existsSync(path.join(dir, `${model}.onnx`))).toBe(true);
    });
  }

  it('offers nothing beyond those three', async () => {
    // The removed languages must not still resolve through a leftover mapping.
    for (const gone of ['spanish', 'french', 'italian', 'portuguese', 'japanese', 'mandarin']) {
      await expect(
        resolveVoiceModel(dir || VOICES, 'en_US-lessac-medium', gone),
        `"${gone}" still resolves to a model`,
      ).rejects.toBeInstanceOf(MissingVoiceModelError);
    }
  });
});
