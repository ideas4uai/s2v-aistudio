import { describe, it, expect } from 'vitest';
import { NO_TEXT_CLAUSE, hasTextBan } from '../src/services/aiService.js';

// Garbled lettering is the most recognisable AI tell in a generated still, and this
// pipeline produced it constantly: real prompts it sent asked for "legal document
// clauses dynamically assembling", and real output came back reading "BUILD FAILED".
// The rule against it existed, but only in the StoryboardAgent's instructions to the
// model that WRITES prompts — so it never reached the model that draws the picture.
describe('the ban on rendered text reaches the image model', () => {
  it('says the things it does not want, not "no letterbox"-style layout negation', () => {
    // A controlled A/B on this project showed asking for "no letterbox / no black bars"
    // produced MORE bars than never mentioning them. Layout is fixed after generation.
    expect(NO_TEXT_CLAUSE).not.toMatch(/letterbox|black bars|border/i);
    for (const banned of ['text', 'words', 'letters', 'numbers', 'logos', 'signage']) {
      expect(NO_TEXT_CLAUSE.toLowerCase()).toContain(banned);
    }
  });

  it('is not repeated when the caller already banned text', () => {
    // The orchestrator's background prompt carries its own ban and does not show the tell.
    const background =
      'a quiet control room, absolutely no text, no words, no numbers, no lettering anywhere in the image';
    expect(hasTextBan(background)).toBe(true);
  });

  it('fires for the scene-visual prompts that never carried a ban', () => {
    const real =
      'Close-up of a futuristic interface screen showing pulsating energy grid data, ' +
      'cybernetic blue lighting, 3D animated film style, 16:9 landscape, cinematic lighting, sharp focus.';
    expect(hasTextBan(real)).toBe(false);
  });

  it('does not mistake an unrelated "no" for a ban', () => {
    expect(hasTextBan('a monk takes a vow of silence, no textiles in the room')).toBe(false);
    expect(hasTextBan('a wide shot with no wordplay intended')).toBe(false);
  });
});
