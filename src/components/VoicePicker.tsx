import { useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../utils/api';

/**
 * Voice selector with an audible preview.
 *
 * One control covers all three sources — Kokoro (the default engine), the caller's
 * own cloned voices, and Piper (offline) — because from the user's point of view
 * they are all just "which voice", and making them separate controls would invite
 * choosing two at once.
 *
 * The value is encoded into the strings ttsService already parses:
 *   kokoro:af_heart      a specific Kokoro voice
 *   piper:professional   the offline engine, by style
 *   cloned:<uuid>        a locally cloned voice (lifted out into clonedVoiceId)
 */

export type VoiceSelection = { voiceStyle: string; clonedVoiceId?: string };

type Catalog = {
  defaultEngine: string;
  previewText: string;
  kokoro: { id: string; lang: string; grade: string; label: string }[];
  piper: { id: string; label: string }[];
  cloned: { id: string; name: string; createdAt: string }[];
};

const LANG_LABEL: Record<string, string> = {
  english: 'English', hindi: 'Hindi', spanish: 'Spanish', french: 'French',
  italian: 'Italian', portuguese: 'Portuguese', japanese: 'Japanese', mandarin: 'Mandarin',
};

export function VoicePicker({ value, onChange }: { value: VoiceSelection; onChange: (v: VoiceSelection) => void }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    authenticatedFetch('/api/voices/catalog')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`catalog ${r.status}`))))
      .then((c) => { if (!cancelled) setCatalog(c); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, []);

  // Revoke the previous object URL rather than leaking one per preview click.
  useEffect(() => () => { if (audioRef.current?.src) URL.revokeObjectURL(audioRef.current.src); }, []);

  const selected = value.clonedVoiceId ? `cloned:${value.clonedVoiceId}` : value.voiceStyle || 'kokoro:af_heart';

  function handleChange(next: string) {
    if (next.startsWith('cloned:')) onChange({ voiceStyle: 'professional', clonedVoiceId: next.slice(7) });
    else onChange({ voiceStyle: next, clonedVoiceId: undefined });
  }

  async function preview() {
    setPreviewing(true);
    setError(null);
    try {
      const body = selected.startsWith('cloned:')
        ? { clonedVoiceId: selected.slice(7), engine: 'chatterbox' }
        : selected.startsWith('piper:')
          // Piper previews would need the Piper binary and a per-style model lookup;
          // the preview path only covers the engines that can synthesise on demand.
          ? null
          : { voice: selected.replace(/^kokoro:/, ''), engine: 'kokoro' };

      if (!body) { setError('Preview is available for Kokoro and cloned voices.'); return; }

      const res = await authenticatedFetch('/api/voices/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as any).error || `preview ${res.status}`);

      const url = URL.createObjectURL(await res.blob());
      if (audioRef.current?.src) URL.revokeObjectURL(audioRef.current.src);
      const audio = audioRef.current ?? new Audio();
      audioRef.current = audio;
      audio.src = url;
      await audio.play();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setPreviewing(false);
    }
  }

  if (error && !catalog) {
    return <p className="text-sm text-red-600">Could not load voices: {error}</p>;
  }
  if (!catalog) return <p className="text-sm text-neutral-500">Loading voices…</p>;

  const byLang = catalog.kokoro.reduce<Record<string, Catalog['kokoro']>>((acc, v) => {
    (acc[v.lang] ||= []).push(v);
    return acc;
  }, {});

  return (
    <div>
      <div className="flex gap-2">
        <select
          className="flex-1 px-4 py-3 rounded-xl border border-neutral-300 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white"
          value={selected}
          onChange={(e) => handleChange(e.target.value)}
        >
          {catalog.cloned.length > 0 && (
            <optgroup label="Your cloned voices">
              {catalog.cloned.map((v) => (
                <option key={v.id} value={`cloned:${v.id}`}>{v.name} (cloned)</option>
              ))}
            </optgroup>
          )}
          {Object.entries(byLang).map(([lang, voices]) => (
            <optgroup key={lang} label={`${LANG_LABEL[lang] ?? lang} — Kokoro`}>
              {voices.map((v) => (
                <option key={v.id} value={`kokoro:${v.id}`}>
                  {v.label}{v.grade ? ` · ${v.grade}` : ''}
                </option>
              ))}
            </optgroup>
          ))}
          <optgroup label="Piper (offline fallback)">
            {catalog.piper.map((p) => (
              <option key={p.id} value={`piper:${p.id}`}>{p.label}</option>
            ))}
          </optgroup>
        </select>
        <button
          type="button"
          onClick={preview}
          disabled={previewing}
          className="px-4 py-3 rounded-xl border border-neutral-300 bg-white hover:bg-neutral-50 disabled:opacity-50 whitespace-nowrap"
          title={`Hear: "${catalog.previewText}"`}
        >
          {previewing ? '…' : '▶ Preview'}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <p className="mt-2 text-xs text-neutral-500">
        Kokoro-82M (Apache-2.0) is the default engine. Piper stays available offline.
        Grades are the model's own quality ratings — A is best.
      </p>
    </div>
  );
}
