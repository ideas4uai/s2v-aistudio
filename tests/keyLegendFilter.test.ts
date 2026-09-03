import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { isKeyLegend } from '../src/services/textDefocus.js';

// A real 11-scene render returned ten regions on one still, every one a keyboard key
// legend, and softened all ten — despite DETECT_PROMPT having forbidden exactly that
// since the pass was written. The prompt is a request to a model; this is the guarantee.
const FROM_THE_FAILING_STILL = [
  'Keyboard key: Alt',
  'Keyboard key: Ctrl',
  'Keyboard key: Enter',
  'Shift key label',
  'Caps Lock key label',
  'Tab key label',
  'Ctrl key label',
  'Alt key label',
  'Enter key label',
  'Backspace key label',
];

// Every label the detector produced across the real stills this session that SHOULD be
// acted on. The filter is worthless if it costs any of these.
const GENUINE_DETECTIONS = [
  'projected code/characters',
  'projected characters on face',
  'projected code/text',
  'Projected code on man\'s face',
  'code editor on monitor',
  'code and UI elements on monitor screen',
  'monitor screen displaying legible code',
  'readable code on monitor screen',
  'Matrix-style code on monitor',
  'green matrix-like code',
  'streaming green characters on a monitor screen',
  'programming code',
];

describe('keyboard key legends are never acted on', () => {
  it('rejects every label from the still that produced the false positives', () => {
    const missed = FROM_THE_FAILING_STILL.filter((l) => !isKeyLegend(l));
    expect(missed).toEqual([]);
  });

  it('keeps every genuine detection this session actually produced', () => {
    const lost = GENUINE_DETECTIONS.filter((l) => isKeyLegend(l));
    expect(lost).toEqual([]);
  });

  it('does not fire on the bare word "key", which is ordinary in real text', () => {
    // The loosening this guards against: "API key" is a string a screen genuinely shows,
    // and matching /key/ would have suppressed it along with the keycaps.
    for (const l of ['API key visible in the editor', 'primary key column', 'key metrics panel',
                     'a keyring on the desk', 'monkey illustration']) {
      expect(isKeyLegend(l)).toBe(false);
    }
  });

  it('catches the phrasings the model varies between', () => {
    for (const l of ['keycap legends', 'the Esc key', 'command key', 'Windows key',
                     'keyboard lettering', 'function key labels']) {
      expect(isKeyLegend(l)).toBe(true);
    }
  });

  it('is stated in the detection prompt as well as enforced after it', () => {
    // Both, deliberately: the filter cannot recover the vision spend, only the pixels.
    // The failing still burned 47s of detection calls on regions it then softened.
    const src = fs.readFileSync('src/services/textDefocus.ts', 'utf8');
    expect(src).toContain('DO NOT report the legends printed on keyboard keys');
    expect(src).toContain('if (isKeyLegend(what)) continue;');
  });
});
