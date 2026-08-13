import React from 'react';
import {
  MIN_TARGET_SECONDS,
  MAX_TARGET_SECONDS,
  targetLengthSeconds,
  targetWordCount,
  sceneCountRange,
} from '../utils/targetLength';

/**
 * Target duration as a free number of seconds, with the old presets kept as
 * one-click shortcuts.
 *
 * The presets were never the mechanism — targetLengthSeconds has always parsed
 * any value — they were just the only thing the form would emit, so a script
 * that naturally ran 40 seconds had to be padded up to the nearest option. The
 * quick picks stay because most videos really are 30 or 60; the field is what
 * makes the other ones expressible.
 *
 * Stored as `${seconds}s` so existing projects, which hold strings like '60s',
 * need no migration.
 */

const PRESETS = [15, 30, 60, 180, 300];

const label = (secs: number): string =>
  secs >= 60 && secs % 60 === 0 ? `${secs / 60}m` : `${secs}s`;

export function TargetLengthField({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (next: string) => void;
}) {
  const seconds = targetLengthSeconds(value);
  // What the box shows while typing, so a half-typed "4" is not clamped to 5
  // under the cursor. Committed on blur.
  const [draft, setDraft] = React.useState(String(seconds));
  React.useEffect(() => setDraft(String(targetLengthSeconds(value))), [value]);

  const commit = (raw: string) => {
    const parsed = Number(raw);
    const next = Number.isFinite(parsed) && parsed > 0
      ? Math.min(Math.max(Math.round(parsed), MIN_TARGET_SECONDS), MAX_TARGET_SECONDS)
      : seconds;
    setDraft(String(next));
    onChange(`${next}s`);
  };

  const outOfRange = draft !== '' && Number(draft) > 0
    && (Number(draft) < MIN_TARGET_SECONDS || Number(draft) > MAX_TARGET_SECONDS);
  const [sceneLo, sceneHi] = sceneCountRange(seconds);

  return (
    <div>
      <label htmlFor="target-length" className="block text-sm font-bold text-neutral-700 mb-2">
        Target Length
      </label>
      <div className="flex items-center gap-2">
        <input
          id="target-length"
          type="number"
          inputMode="numeric"
          min={MIN_TARGET_SECONDS}
          max={MAX_TARGET_SECONDS}
          step={1}
          aria-describedby="target-length-help"
          aria-invalid={outOfRange || undefined}
          className={`w-28 px-4 py-3 rounded-xl border outline-none transition-all focus:ring-2 ${
            outOfRange
              ? 'border-red-400 focus:ring-red-400'
              : 'border-neutral-300 focus:ring-indigo-500 focus:border-indigo-500'
          }`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); }}
        />
        <span className="text-sm font-medium text-neutral-500">seconds</span>
        <div className="flex flex-wrap gap-1.5 ml-auto">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => { setDraft(String(p)); onChange(`${p}s`); }}
              aria-pressed={seconds === p}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
                seconds === p
                  ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                  : 'border-neutral-200 text-neutral-600 hover:border-neutral-300'
              }`}
            >
              {label(p)}
            </button>
          ))}
        </div>
      </div>
      <p id="target-length-help" className="text-xs text-neutral-500 mt-2">
        {outOfRange ? (
          <span className="text-red-600 font-medium">
            Enter {MIN_TARGET_SECONDS}–{MAX_TARGET_SECONDS} seconds. Values outside the range are clamped.
          </span>
        ) : (
          <>
            {MIN_TARGET_SECONDS}–{MAX_TARGET_SECONDS} seconds. At {seconds}s the script runs about{' '}
            <strong>{targetWordCount(seconds)} words</strong> across {sceneLo}–{sceneHi} scenes.
            {seconds > 60 && ' Longer videos cost one image and one narration per scene — a few minutes of video is a long render.'}
          </>
        )}
      </p>
    </div>
  );
}
