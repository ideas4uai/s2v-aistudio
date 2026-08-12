import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { narrationPath } from '../src/server/services/ttsService.js';
import { generateAudioHash } from '../src/utils/hash.js';

// Regression cover for a render that shipped the wrong words.
//
// Editing a scene's script marked the scene stale and re-encoded its video, but the
// narration was never re-synthesised: audio_hash was computed only when absent, and TTS
// was skipped whenever `narration-${scene_id}.wav` existed. Measured on project 04fa8d80,
// scene f3d60ac9 — the script was replaced with a completely different, much longer one
// and the WAV came back byte-identical (sha256 b8afb6d951e1…, 172704 bytes both times).
// The published video would speak the old script under the new captions.
//
// The fix is the rule already used for visual clips: content that is not a file cannot be
// caught by comparing timestamps, so it goes in the name. These assert that property on
// the real path builder and the real hash — the bug lived entirely in path construction
// and an fs.existsSync check, so there is nothing worth mocking.

const PROJECT = 'proj-narration-test';
const SCENE = 'scene-narration-test';
const VOICE = 'professional';

const dir = path.join(os.tmpdir(), 'ais-audio', PROJECT);

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('narration is keyed to the text it speaks', () => {
  it('sends edited narration to a different file than the text it replaced', () => {
    const before = generateAudioHash('The original line.', VOICE, 'NARRATOR');
    const after = generateAudioHash('A completely different line.', VOICE, 'NARRATOR');
    expect(after).not.toBe(before);

    const pathBefore = narrationPath(PROJECT, SCENE, before);
    const pathAfter = narrationPath(PROJECT, SCENE, after);
    // The whole bug in one assertion: these used to be the same path, so the recording of
    // the old line was already on disk and TTS was skipped.
    expect(pathAfter).not.toBe(pathBefore);
  });

  it('treats an existing recording of the OLD text as absent', () => {
    const before = generateAudioHash('The original line.', VOICE, 'NARRATOR');
    const after = generateAudioHash('A completely different line.', VOICE, 'NARRATOR');

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(narrationPath(PROJECT, SCENE, before), 'old recording');

    // What the orchestrator asks before deciding to skip TTS.
    expect(fs.existsSync(narrationPath(PROJECT, SCENE, after))).toBe(false);
  });

  it('reuses the recording when the text has not changed', () => {
    const hash = generateAudioHash('The original line.', VOICE, 'NARRATOR');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(narrationPath(PROJECT, SCENE, hash), 'recording');

    // Recomputing the hash from unchanged text must land back on the same file — the fix
    // must not turn into "re-synthesise every render", which would undo the caching that
    // incremental re-render depends on.
    const again = generateAudioHash('The original line.', VOICE, 'NARRATOR');
    expect(fs.existsSync(narrationPath(PROJECT, SCENE, again))).toBe(true);
  });

  it('separates voices and characters, not just text', () => {
    const base = narrationPath(PROJECT, SCENE, generateAudioHash('Same words.', VOICE, 'VEER'));
    const otherVoice = narrationPath(PROJECT, SCENE, generateAudioHash('Same words.', 'casual', 'VEER'));
    const otherChar = narrationPath(PROJECT, SCENE, generateAudioHash('Same words.', VOICE, 'NOVA'));
    expect(otherVoice).not.toBe(base);
    expect(otherChar).not.toBe(base);
  });

  it('keeps the silence-fallback suffix derivable from the path', () => {
    // ttsService builds the fallback as outputPath.replace(/\.wav$/, '-silence.wav') and
    // voiceService flags a degraded scene by testing that suffix. Adding the hash must not
    // break either, or a silent render stops being reported as degraded.
    const p = narrationPath(PROJECT, SCENE, generateAudioHash('x', VOICE, 'NARRATOR'));
    expect(p.endsWith('.wav')).toBe(true);
    expect(p.replace(/\.wav$/, '-silence.wav').endsWith('-silence.wav')).toBe(true);
  });
});
