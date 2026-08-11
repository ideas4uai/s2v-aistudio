import { describe, it, expect } from 'vitest';
import { buildSpeakerPatterns, detectCharacter } from '../src/pipeline/agents/storyboardAgent.js';

// Any universe's cast, supplied at call time — the point of the change is that
// no character name is baked into the module.
const aiqa = [{ name: 'Ravi' }, { name: 'Arjun' }, { name: 'Priya' }, { name: 'Raj' }, { name: 'Production Monster' }];
const signalSquad = [{ name: 'Veer' }, { name: 'Nova' }, { name: 'Byte' }];

describe('buildSpeakerPatterns', () => {
  it('builds patterns from the name it is given, whatever the universe', () => {
    expect(buildSpeakerPatterns('Ravi').some((p) => p.test('RAVI: Staging is unreachable.'))).toBe(true);
    expect(buildSpeakerPatterns('Ravi').some((p) => p.test('BYTE: Efficiency rating optimal.'))).toBe(false);
  });

  it('escapes regex metacharacters in names', () => {
    expect(() => buildSpeakerPatterns('C++ (v2)')).not.toThrow();
    expect(buildSpeakerPatterns('C++ (v2)').some((p) => p.test('C++ (v2): hello'))).toBe(true);
  });
});

describe('detectCharacter', () => {
  it('attributes a dialogue-prefixed line to the speaking character', () => {
    expect(detectCharacter('RAVI: Staging environment unreachable.', aiqa)).toBe('RAVI');
    expect(detectCharacter('ARJUN: It works on my machine.', aiqa)).toBe('ARJUN');
  });

  it('attributes an explicit spoken attribution', () => {
    expect(detectCharacter('Raj said, "Production is down."', aiqa)).toBe('RAJ');
  });

  it('works for a different universe without any code change', () => {
    // The old implementation hardcoded byte/nova/veer catchphrases, so any
    // other cast collapsed to NARRATOR. Both casts must work identically now.
    expect(detectCharacter('VEER: I never asked for this.', signalSquad)).toBe('VEER');
    expect(detectCharacter('VEER: I never asked for this.', aiqa)).toBe('NARRATOR');
  });

  it('falls back to NARRATOR when there is no universe cast', () => {
    expect(detectCharacter('RAVI: Staging environment unreachable.', [])).toBe('NARRATOR');
    expect(detectCharacter('RAVI: Staging environment unreachable.', undefined as any)).toBe('NARRATOR');
  });

  it('falls back to NARRATOR for third-person narration about a character', () => {
    expect(detectCharacter('Ravi stared at the failing dashboard.', aiqa)).toBe('NARRATOR');
    expect(detectCharacter('You heard Arjun being confident again.', aiqa)).toBe('NARRATOR');
  });

  it('falls back to NARRATOR when two characters are attributed in one line', () => {
    expect(detectCharacter('PRIYA: Is staging clear? RAJ: No.', aiqa)).toBe('NARRATOR');
  });

  it('handles multi-word character names', () => {
    expect(detectCharacter('PRODUCTION MONSTER: ...', [{ name: 'Production Monster' }])).toBe('PRODUCTION MONSTER');
  });

  it('ignores cast entries with no usable name', () => {
    expect(() => detectCharacter('RAVI: hello', [{ name: '' }, { foo: 1 } as any])).not.toThrow();
  });
});
