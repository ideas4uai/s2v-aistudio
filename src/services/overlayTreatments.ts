import { extractFigure, PERCENT_RE, MULTIPLIER_RE } from '../pipeline/agents/scriptPrompt.js';

/**
 * Content detection for the treatment classifier.
 *
 * Everything here answers one question: does this beat's narration *actually* contain
 * the thing a treatment would illustrate? Not "could it plausibly", not "is there a
 * slot free" — the whole design principle carried over from the kinetic-text work is
 * that a script with no diagram content gets no diagram, and that a wrong call-out is
 * worse than none. So every detector below returns null far more often than not, and
 * each one's failure modes are written down next to it rather than discovered later.
 *
 * These are heuristics over English prose. They are stated as such, they are tested
 * against real generated scripts, and their false-positive behaviour is reported.
 */

export interface DetectedStep {
  label: string;
  /** Index into wordTimings() of the word this step is announced on. */
  wordIndex: number;
}

export interface DetectedComparison {
  before: string;
  after: string;
  beforeIndex: number;
  afterIndex: number;
}

const words = (text: string): string[] => String(text || '').split(/\s+/).filter(Boolean);
// Keeps the characters a figure needs (40%, C#, 3.5x) but never leading or
// trailing punctuation — "repairs." was reaching a diagram node as its label.
const bare = (w: string): string =>
  w.replace(/[^a-zA-Z0-9%+.#-]/g, '').replace(/^[.#-]+|[.,;:!?-]+$/g, '');

/** Words that carry no identity — never a step label, never a name card. */
const FILLER = new Set([
  'the', 'a', 'an', 'it', 'its', 'this', 'that', 'these', 'those', 'your', 'you', 'our',
  'their', 'they', 'and', 'but', 'or', 'so', 'then', 'now', 'just', 'also', 'very',
  'is', 'are', 'was', 'were', 'be', 'been', 'will', 'can', 'could', 'would', 'should',
  'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'over', 'up',
]);

/**
 * Ordered-sequence markers. Two or more of these in one beat is the strongest signal
 * that the narration is walking through steps rather than making one point.
 */
const SEQUENCE_MARKERS = /^(first|firstly|then|next|second|secondly|third|thirdly|finally|lastly|afterwards)\b/i;

/**
 * Steps in a beat, or null.
 *
 * Two shapes are recognised:
 *
 *   1. Sequence markers — "First X, then Y, finally Z". Two or more required. Near-zero
 *      false positives; those words exist to signal sequence, and they are the one case
 *      allowed to span sentences.
 *   2. A punctuated list INSIDE one sentence: three or more comma/colon clauses of two
 *      to five words each, every one carrying a non-filler word.
 *
 * Measured on 176 beats of real generated script across seven projects, this fires on
 * 2.3% of beats. Of the four it caught, three are correct ("GET to read, POST to
 * create, PUT to update, DELETE to remove"; "investigate the failure, find what
 * changed, update the test, and run it again") and one is not — a list of capabilities
 * read as a list of steps. So roughly one diagram in four is a false positive, on a
 * treatment that reaches one beat in forty. The false negatives are prose that
 * describes a process without punctuating it as a list, which is the safe direction.
 *
 * A step's label is the first non-filler word of its clause plus at most one more —
 * "the planner drafts" becomes "planner drafts". Long labels do not fit in a node.
 */
export function detectSteps(text: string): DetectedStep[] | null {
  const all = words(text);
  if (all.length < 6) return null;

  /** Clause spans, with the word index each one starts at, so timing can anchor there. */
  const split = (src: string, offset: number, re: RegExp) => {
    const out: { text: string; wordIndex: number }[] = [];
    let cursor = offset;
    for (const piece of src.split(re)) {
      const n = words(piece).length;
      if (n) out.push({ text: piece.trim(), wordIndex: cursor });
      cursor += n;
    }
    return out;
  };

  // Sentences first, then clauses INSIDE a sentence. Splitting the whole beat on
  // sentence boundaries as well as commas is what made this fire on ordinary prose:
  // measured against 176 real generated beats, "Imagine that at your home. It just
  // began speaking. Pretty unsettling, you know?" came back as a four-step process,
  // because three short sentences have exactly the shape of a three-item list. A list
  // has to be punctuated as one.
  const sentenceSpans: { text: string; wordIndex: number }[] = [];
  let at = 0;
  for (const sen of String(text).match(/[^.!?]+[.!?]*/g) ?? []) {
    const n = words(sen).length;
    if (n) sentenceSpans.push({ text: sen.trim(), wordIndex: at });
    at += n;
  }

  const markedAll = split(String(text), 0, /[,;:]|(?<=[.!?])\s/)
    .filter((c) => SEQUENCE_MARKERS.test(c.text.trim()));

  let picked: { text: string; wordIndex: number }[] | null = null;
  if (markedAll.length >= 2) {
    // Explicit sequence words. These may legitimately span sentences — "First X.
    // Then Y. Finally Z." is a list however it is punctuated.
    picked = markedAll;
  } else {
    for (const sen of sentenceSpans) {
      const parts = split(sen.text, sen.wordIndex, /[,;:]/);
      if (parts.length < 3) continue;
      const items = /:/.test(sen.text) ? parts.slice(1) : parts;
      if (items.length < 3) continue;
      // Every item has to be a real phrase: two to five words, at least one of them
      // carrying meaning. A one-word item is a sentence adverb, not a step — "Normally,
      // you investigate the failure, find what changed, update the test" was producing
      // a node labelled "Normally".
      const tidy = items.filter((c) => {
        const n = words(c.text).length;
        return n >= 2 && n <= 5
          && words(c.text).some((w) => !FILLER.has(bare(w).toLowerCase()));
      });
      // Three items for an unmarked list. Two is as often a pair of clauses as a
      // process, and the explicit-marker branch above already covers the two-step case
      // where the script says outright that it is stepping through something.
      if (tidy.length < 3) continue;
      picked = tidy;
      break;
    }
  }
  if (!picked) return null;

  const steps = picked.slice(0, 4).map((c) => {
    const parts = words(c.text)
      .map((w) => bare(w))
      .filter((w) => w && !SEQUENCE_MARKERS.test(w));
    const meaty = parts.filter((w) => !FILLER.has(w.toLowerCase()));
    const label = (meaty.length ? meaty : parts).slice(0, 2).join(' ');
    return { label, wordIndex: c.wordIndex };
  }).filter((s) => s.label);

  // Two nodes and a connector is a diagram. One node is a label.
  return steps.length >= 2 ? steps : null;
}

/**
 * Marker table for before/after contrast. Each entry says where each side's phrase
 * sits relative to the marker, because English puts them in different orders:
 * "instead of X, Y" leads with the rejected state, "X versus Y" does not.
 */
const CONTRASTS: { re: RegExp; order: 'after-then-rest' | 'split' }[] = [
  { re: /\binstead of\b/i, order: 'after-then-rest' },
  { re: /\brather than\b/i, order: 'after-then-rest' },
  { re: /\bused to\b/i, order: 'after-then-rest' },
  { re: /\bno longer\b/i, order: 'after-then-rest' },
  { re: /\s(?:vs\.?|versus)\s/i, order: 'split' },
];

const phrase = (list: string[], from: number, count: number): string =>
  list.slice(from, from + count).map(bare).filter(Boolean).join(' ');

/**
 * A before/after contrast in a beat, or null.
 *
 * Only the five markers above count. "Better", "improved", "faster" are NOT markers:
 * they describe a change without naming two states, and treating them as contrast is
 * how a split panel ends up with one empty half. A marker also has to have real words
 * on both sides — "instead of that" alone gives nothing to put in the panel.
 *
 * Known false negative, accepted: a contrast spread across two sentences ("Tests used
 * to break. Now they heal.") only matches when both halves are in the same beat, which
 * they usually are, but the two-sentence form with the marker in the first sentence
 * only is missed. Known false positive: "instead of" used non-contrastively ("do this
 * instead of nothing").
 */
export function detectComparison(text: string): DetectedComparison | null {
  const all = words(text);
  if (all.length < 6) return null;

  for (const { re, order } of CONTRASTS) {
    const m = re.exec(text);
    if (!m) continue;
    // Word index of the marker: count the words before its character offset.
    const markerIndex = words(text.slice(0, m.index)).length;
    const markerLen = words(m[0]).length;

    if (order === 'split') {
      const before = phrase(all, Math.max(0, markerIndex - 3), Math.min(3, markerIndex));
      const after = phrase(all, markerIndex + markerLen, 3);
      if (!before || !after) return null;
      return {
        before, after,
        beforeIndex: Math.max(0, markerIndex - 3),
        afterIndex: markerIndex + markerLen,
      };
    }

    // "instead of X, Y" — the rejected state follows the marker, the kept state
    // follows the next clause break.
    const rest = text.slice(m.index + m[0].length);
    const breakAt = rest.search(/[,;]|\bnow\b/i);
    const beforeIndex = markerIndex + markerLen;
    const beforeCount = breakAt >= 0 ? words(rest.slice(0, breakAt)).length : 3;
    const before = phrase(all, beforeIndex, Math.min(4, beforeCount));
    const afterIndex = beforeIndex + beforeCount;
    const after = phrase(all, afterIndex, 4);
    if (!before || !after || afterIndex >= all.length) return null;
    return { before, after, beforeIndex, afterIndex };
  }
  return null;
}

/**
 * Words that are capitalised for a reason other than being a name — sentence starts
 * are excluded structurally, these are the rest.
 */
const NOT_A_NAME = new Set([
  'i', 'im', 'ive', 'ai', 'api', 'ui', 'ux', 'ci', 'cd', 'it', 'the', 'a', 'an',
  'and', 'but', 'so', 'then', 'now', 'what', 'why', 'how', 'when', 'your', 'you',
]);

/**
 * The product/tool/company a beat names, or null.
 *
 * Two signals, and BOTH the position and the topic have to agree:
 *   - the token is capitalised and is not the first word of its sentence, and
 *   - it appears in the project's topic.
 *
 * Requiring the topic match is what keeps this from firing on every capitalised word.
 * The topic is the one piece of ground truth about what the video is actually about,
 * it costs nothing, and it already exists on the project. The cost is a real false
 * negative: a tool named in passing that is not the subject of the video gets no card.
 * That is the conservative direction, and it is the one to be wrong in.
 */
export function detectName(text: string, topic = ''): { name: string; wordIndex: number } | null {
  const all = words(text);
  const topicLower = String(topic || '').toLowerCase();
  if (!topicLower || all.length < 3) return null;

  // First word of each sentence is capitalised by grammar, not by being a name.
  const sentenceStarts = new Set<number>([0]);
  all.forEach((w, i) => { if (/[.!?]$/.test(w)) sentenceStarts.add(i + 1); });

  for (let i = 0; i < all.length; i++) {
    if (sentenceStarts.has(i)) continue;
    const token = bare(all[i]);
    if (token.length < 3 || !/^[A-Z]/.test(token)) continue;
    if (NOT_A_NAME.has(token.toLowerCase())) continue;
    if (!topicLower.includes(token.toLowerCase())) continue;
    return { name: token, wordIndex: i };
  }
  return null;
}

/**
 * A figure split into the parts a count-up needs: the number to count to, and whatever
 * trails it. Built on extractFigure so there is still exactly one place that decides
 * what counts as a figure.
 */
export function countUpParts(text: string): { to: number; suffix: string } | null {
  const figure = extractFigure(text);
  if (!figure) return null;
  const m = /^(\d[\d,]*)(?:\.(\d+))?\s*(.*)$/.exec(figure);
  // Fractional values are shown as-is: a count-up through decimals reads as a glitch
  // rather than as a counter, and the figures that matter here are whole numbers.
  if (!m || m[2]) return null;
  const to = parseInt(m[1].replace(/,/g, ''), 10);
  if (!Number.isFinite(to) || to <= 0 || to > 100000) return null;
  return { to, suffix: m[3] ? (m[3].length <= 2 ? m[3] : ` ${m[3]}`) : '' };
}

/** Re-exported so callers have one import for "does this beat state a figure". */
export { extractFigure, PERCENT_RE, MULTIPLIER_RE };
