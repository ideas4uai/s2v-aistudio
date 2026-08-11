import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Loader2, Mic, Trash2, ShieldCheck, History } from 'lucide-react';
import { authenticatedFetch } from '../utils/api';

/**
 * Voice Studio — clone a voice once on this machine, then reuse it in any project.
 *
 * Cloning happens locally (Chatterbox 0.5B, MIT): the sample never leaves the
 * machine. The consent step is deliberately in the way rather than beside the way —
 * it gates the submit button here, and the server rejects a clone request without it
 * regardless of what this form does.
 */

type ClonedVoice = {
  id: string;
  name: string;
  createdAt: string;
  cloneMs?: number;
  peakRssMb?: number | null;
  sample: { originalName: string; bytes: number };
  consent: { statement: string; acceptedAt: string };
};

type AuditEvent = {
  at: string; event: string; voiceId: string; voiceName?: string;
  projectId?: string; detail?: string;
};

const fmtMs = (ms?: number) => (ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const fmtBytes = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

export function VoiceStudio() {
  const [voices, setVoices] = useState<ClonedVoice[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const [v, a, h] = await Promise.all([
        authenticatedFetch('/api/voices/cloned').then((r) => r.json()),
        authenticatedFetch('/api/voices/audit').then((r) => r.json()),
        authenticatedFetch('/api/voices/health').then((r) => r.json()),
      ]);
      setVoices(Array.isArray(v) ? v : []);
      setAudit(Array.isArray(a) ? a : []);
      setHealth(h);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function clone(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !consent || !name.trim()) return;
    setBusy(true);
    setError(null);
    setStatus('Cloning locally — this runs on your CPU and can take a minute…');
    try {
      const body = new FormData();
      body.append('sample', file);
      body.append('name', name.trim());
      body.append('consent', 'true');

      const res = await authenticatedFetch('/api/voices/clone', { method: 'POST', body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `clone failed (${res.status})`);

      setStatus(`Cloned "${data.voice.name}" in ${fmtMs(data.cloneMs)}${data.peakRssMb ? ` · peak RSS ${data.peakRssMb} MB` : ''}. It is now selectable in any project.`);
      setName(''); setFile(null); setConsent(false);
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (e: any) {
      setError(e.message);
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  async function remove(v: ClonedVoice) {
    if (!confirm(`Delete "${v.name}"? This erases the checkpoint, the original sample and its audit entries.`)) return;
    try {
      const res = await authenticatedFetch(`/api/voices/cloned/${v.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(((await res.json()) as any).error);
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  const cloneReady = health?.clone?.ok !== false;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <Link to="/" className="inline-flex items-center gap-2 text-neutral-600 hover:text-neutral-900 mb-6">
        <ArrowLeft className="w-4 h-4" /> Back to dashboard
      </Link>

      <h1 className="text-3xl font-bold flex items-center gap-3 mb-2">
        <Mic className="w-7 h-7 text-indigo-600" /> Voice Studio
      </h1>
      <p className="text-neutral-600 mb-8">
        Clone a voice once from a short sample. It is stored on this machine and can be
        selected in any project afterwards — there is no re-cloning and no per-video cost.
      </p>

      {health && !cloneReady && (
        <div className="mb-6 p-4 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-900">
          <strong>Cloning engine unavailable.</strong> {health.clone?.error}
        </div>
      )}

      <form onSubmit={clone} className="p-6 rounded-2xl border border-neutral-200 bg-white mb-10">
        <h2 className="font-bold text-lg mb-4">Clone a new voice</h2>

        <label className="block text-sm font-bold text-neutral-700 mb-2">Voice name</label>
        <input
          className="w-full px-4 py-3 rounded-xl border border-neutral-300 mb-4 outline-none focus:ring-2 focus:ring-indigo-500"
          value={name} onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Narrator (my voice)" required
        />

        <label className="block text-sm font-bold text-neutral-700 mb-2">Voice sample</label>
        <input
          ref={fileRef} type="file" accept="audio/*" required
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="w-full px-4 py-3 rounded-xl border border-neutral-300 mb-2 bg-white"
        />
        <p className="text-xs text-neutral-500 mb-5">
          10–30 seconds of clean speech, one speaker, no music or background noise. WAV or MP3, up to 25 MB.
        </p>

        {/* Consent is a gate, not a notice. The server enforces the same rule, so
            disabling this checkbox in devtools does not get a clone through. */}
        <label className="flex gap-3 items-start p-4 rounded-xl bg-neutral-50 border border-neutral-200 mb-5 cursor-pointer">
          <input
            type="checkbox" checked={consent} required
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-1"
          />
          <span className="text-sm text-neutral-700">
            <ShieldCheck className="w-4 h-4 inline mr-1 text-emerald-600" />
            I own this voice or have explicit permission from the speaker to clone it, and I
            accept responsibility for how the cloned voice is used.
          </span>
        </label>

        <button
          type="submit"
          disabled={busy || !file || !consent || !name.trim() || !cloneReady}
          className="px-6 py-3 rounded-xl bg-indigo-600 text-white font-bold disabled:opacity-40 inline-flex items-center gap-2"
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          {busy ? 'Cloning…' : 'Clone voice'}
        </button>

        {status && <p className="mt-4 text-sm text-emerald-700">{status}</p>}
        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      </form>

      <h2 className="font-bold text-lg mb-4">Your cloned voices</h2>
      {voices.length === 0 ? (
        <p className="text-neutral-500 mb-10">None yet. Cloned voices are private to your account.</p>
      ) : (
        <div className="space-y-3 mb-10">
          {voices.map((v) => (
            <div key={v.id} className="p-4 rounded-xl border border-neutral-200 bg-white flex justify-between gap-4">
              <div className="min-w-0">
                <div className="font-bold">{v.name}</div>
                <div className="text-sm text-neutral-500">
                  Cloned {new Date(v.createdAt).toLocaleString()} · {fmtMs(v.cloneMs)}
                  {v.peakRssMb ? ` · peak RSS ${v.peakRssMb} MB` : ''}
                </div>
                <div className="text-xs text-neutral-400 truncate">
                  from {v.sample.originalName} ({fmtBytes(v.sample.bytes)}) · consent accepted{' '}
                  {new Date(v.consent.acceptedAt).toLocaleString()}
                </div>
              </div>
              <button
                onClick={() => remove(v)}
                className="shrink-0 self-start p-2 rounded-lg text-red-600 hover:bg-red-50"
                title="Delete this voice, its sample and its audit trail"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      <h2 className="font-bold text-lg mb-4 flex items-center gap-2">
        <History className="w-5 h-5" /> Audit trail
      </h2>
      {audit.length === 0 ? (
        <p className="text-neutral-500">No cloning or usage recorded yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-200">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left">
              <tr>
                <th className="p-3">When</th><th className="p-3">Event</th>
                <th className="p-3">Voice</th><th className="p-3">Project</th><th className="p-3">Detail</th>
              </tr>
            </thead>
            <tbody>
              {audit.slice().reverse().map((e, i) => (
                <tr key={i} className="border-t border-neutral-100">
                  <td className="p-3 whitespace-nowrap">{new Date(e.at).toLocaleString()}</td>
                  <td className="p-3">{e.event}</td>
                  <td className="p-3">{e.voiceName ?? e.voiceId}</td>
                  <td className="p-3 font-mono text-xs">{e.projectId ?? '—'}</td>
                  <td className="p-3 text-neutral-500">{e.detail ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
