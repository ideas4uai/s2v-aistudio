import { describe, it, expect } from 'vitest';
import { isSilentBeat, silenceIsDeliberate } from '../src/utils/narration.js';
import { checkAudioPresent } from '../src/services/qualityService.js';

/**
 * A scene that is deliberately silent — an image held for its own beat, no words.
 *
 * The script prompt has always permitted one: "No scene's narration may be under N
 * words, except at most one wordless reaction beat." The render pipeline did not. The
 * content-integrity check treated ANY empty narration_text as unsalvageable and halted
 * the whole render, so the pipeline refused exactly what its own writing instructions
 * asked for.
 *
 * That check is right to exist — it stops the renderer quietly rewriting an approved
 * script — so the fix is not to weaken it. Deliberate and accidental silence look
 * identical field-by-field, and are told apart by shape instead: a wordless beat is
 * punctuation inside a script that speaks.
 */

const speaking = (id: string) => ({
  scene_id: id, narration_text: 'A leaf is a factory running on light.',
  visuals: [{ prompt: 'close-up of a green leaf' }],
});
const silent = (id: string) => ({
  scene_id: id, narration_text: '',
  visuals: [{ prompt: 'a held close-up of a brittle selector on paper' }],
});
/** Narration AND visual both gone — nothing to render either way. */
const empty = (id: string) => ({ scene_id: id, narration_text: '', visuals: [{ prompt: '' }] });

describe('telling deliberate silence from lost narration', () => {
  it('recognises a wordless beat that still has its visual', () => {
    expect(isSilentBeat(silent('a'))).toBe(true);
    expect(isSilentBeat(speaking('a'))).toBe(false);
  });

  it('does not call a scene with no visual either a silent beat', () => {
    // Nothing to show and nothing to say is a broken scene, not a craft choice.
    expect(isSilentBeat(empty('a'))).toBe(false);
  });

  it('accepts silence as punctuation inside a script that speaks', () => {
    expect(silenceIsDeliberate([speaking('a'), silent('b'), speaking('c')])).toBe(true);
  });

  it('rejects a script that mostly lost its words', () => {
    // The real shape of the accident: a failed expansion retry returned fourteen scenes
    // with `narration: undefined` and they were accepted. Halting on that is correct.
    const mostlySilent = [speaking('a'), speaking('b'), ...Array.from({ length: 12 }, (_, i) => silent(`s${i}`))];
    expect(silenceIsDeliberate(mostlySilent)).toBe(false);
  });

  it('rejects a script with no words at all', () => {
    expect(silenceIsDeliberate([silent('a'), silent('b')])).toBe(false);
  });

  it('says nothing is deliberate when nothing is silent', () => {
    expect(silenceIsDeliberate([speaking('a'), speaking('b')])).toBe(false);
  });

  it('needs a strict majority to speak, not just a plurality', () => {
    // Half and half is not punctuation; it is a script that half failed.
    expect(silenceIsDeliberate([speaking('a'), silent('b')])).toBe(false);
  });
});

describe('the quality gate accepts a silent beat', () => {
  const project = (scenes: any[]) => ({ project_id: 'p', scenes } as any);

  it('does not report a wordless beat as missing audio', async () => {
    // package.json stands in for a real narration file: present and over 1000 bytes.
    const check = await checkAudioPresent(project([
      { ...speaking('a'), narration_path: 'package.json' },
      { ...silent('b'), narration_path: undefined },
      { ...speaking('c'), narration_path: 'package.json' },
    ]));
    expect(check.status).toBe('pass');
    expect(check.detail).toContain('1 silent beat');
  });

  it('still fails a speaking scene whose audio never arrived', async () => {
    const check = await checkAudioPresent(project([
      { ...speaking('a'), narration_path: undefined },
      { ...silent('b'), narration_path: undefined },
      { ...speaking('c'), narration_path: 'package.json' },
    ]));
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('no narration audio');
  });

  it('still fails a project whose narration mostly went missing', async () => {
    // Not deliberate, so every silent scene is counted as the missing audio it is.
    const check = await checkAudioPresent(project([
      { ...speaking('a'), narration_path: 'package.json' },
      ...Array.from({ length: 4 }, (_, i) => ({ ...silent(`s${i}`), narration_path: undefined })),
    ]));
    expect(check.status).toBe('fail');
  });
});

describe('the expansion retry cannot silence a script', () => {
  it('is guarded in the agent', async () => {
    // The accident this whole area exists for: a structurally valid array whose scenes
    // carry no narration replaced a 122-word script with 18 words and twelve undefined
    // narrations, which then reached the render as images with no speech.
    const fs = await import('fs');
    const src = fs.readFileSync('src/pipeline/agents/scriptwriterAgent.ts', 'utf8');
    expect(src).toContain('Expansion rejected');
    expect(src).toContain('speaking(expanded) < speaking(scenes)');
  });
});
