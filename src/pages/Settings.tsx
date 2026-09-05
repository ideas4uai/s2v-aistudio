import { useEffect, useState } from 'react';
import { Key, Plus, Trash2, ExternalLink, AlertTriangle, Check, Pause, Play } from 'lucide-react';

/**
 * Settings → API Keys.
 *
 * The pool this manages exists because AI Studio's free tier is rate-limited PER KEY:
 * one key is a bottleneck, several rotate. So the page is built around adding more,
 * not around configuring one.
 *
 * A saved key is shown as its last four characters and never in full. There is no
 * reveal button on purpose — a key you cannot read back is a key that has to be
 * replaced at the source rather than copied around, and replacing one takes seconds.
 */

type KeyRow = {
  id: string;
  label?: string;
  category: string;
  enabled: boolean;
  masked: string;
  createdAt: string;
  lastUsedAt?: string;
};
type Category = { id: string; label: string; help: string };
type Pool = { total: number; available: number; exhausted: string[] };

const AI_STUDIO_KEYS_URL = 'https://aistudio.google.com/apikey';

export function Settings() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [pools, setPools] = useState<Record<string, Pool>>({});
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [newKey, setNewKey] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newCategory, setNewCategory] = useState('text');

  const load = async () => {
    try {
      const [k, c] = await Promise.all([
        fetch('/api/api-keys').then((r) => r.json()),
        fetch('/api/api-keys/categories').then((r) => r.json()),
      ]);
      if (k?.error) throw new Error(k.error);
      setKeys(k.keys ?? []);
      setPools(k.pools ?? {});
      setCategories(Array.isArray(c) ? c : []);
      setError('');
    } catch (err: any) {
      setError(err?.message || 'Could not load API keys');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: newKey.trim(), label: newLabel.trim(), category: newCategory }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || 'Could not save that key');
      // Cleared immediately: the value has been stored and is never coming back to the
      // browser, so leaving it in the field is only a chance to leak it over someone's
      // shoulder.
      setNewKey('');
      setNewLabel('');
      setError('');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Could not save that key');
    } finally {
      setBusy(false);
    }
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await fetch(`/api/api-keys/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await load();
    } finally { setBusy(false); }
  };

  const remove = async (row: KeyRow) => {
    const name = row.label || row.masked;
    if (!confirm(`Delete ${name}? This cannot be undone — you would need to create a new key in AI Studio.`)) return;
    setBusy(true);
    try {
      await fetch(`/api/api-keys/${row.id}`, { method: 'DELETE' });
      await load();
    } finally { setBusy(false); }
  };

  const catLabel = (id: string) => categories.find((c) => c.id === id)?.label ?? id;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-neutral-900">Settings</h1>
        <p className="text-neutral-500 mt-1">API keys used to generate scripts and images.</p>
      </div>

      <section className="bg-white rounded-2xl border border-neutral-200 p-6">
        <div className="flex items-center gap-2 mb-1">
          <Key className="w-5 h-5 text-indigo-600" />
          <h2 className="text-xl font-bold text-neutral-900">API Keys</h2>
        </div>
        <p className="text-sm text-neutral-600 mb-4">
          Google AI Studio keys are rate-limited per key on the free tier, so adding several
          of them to a pool lets requests rotate and keeps a render moving when one hits its
          limit. Add as many as you like.{' '}
          <a
            href={AI_STUDIO_KEYS_URL}
            target="_blank"
            rel="noreferrer"
            className="text-indigo-600 font-medium hover:underline inline-flex items-center gap-1"
          >
            Get a key from Google AI Studio <ExternalLink className="w-3 h-3" />
          </a>
        </p>

        {categories.length > 0 && (
          <dl className="mb-6 grid gap-3 sm:grid-cols-2">
            {categories.map((c) => (
              <div key={c.id} className="rounded-xl border border-neutral-200 bg-neutral-50 p-3">
                <dt className="text-sm font-bold text-neutral-800 flex items-center justify-between">
                  {c.label}
                  <span className="text-xs font-medium text-neutral-500">
                    {pools[c.id]?.available ?? 0}/{pools[c.id]?.total ?? 0} ready
                  </span>
                </dt>
                <dd className="text-xs text-neutral-600 mt-1">{c.help}</dd>
              </div>
            ))}
          </dl>
        )}

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        <form onSubmit={add} className="mb-6 grid gap-3 sm:grid-cols-[1fr_auto_auto] items-end">
          <div className="sm:col-span-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="apikey" className="block text-xs font-bold text-neutral-700 mb-1">API key</label>
              <input
                id="apikey"
                type="password"
                autoComplete="off"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="AIza…"
                className="w-full px-3 py-2 rounded-xl border border-neutral-300 font-mono text-sm outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label htmlFor="apilabel" className="block text-xs font-bold text-neutral-700 mb-1">
                Label <span className="font-normal text-neutral-400">(optional, for your reference)</span>
              </label>
              <input
                id="apilabel"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Personal account"
                className="w-full px-3 py-2 rounded-xl border border-neutral-300 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>
          <div>
            <label htmlFor="apicat" className="block text-xs font-bold text-neutral-700 mb-1">Used for</label>
            <select
              id="apicat"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              className="px-3 py-2 rounded-xl border border-neutral-300 text-sm bg-white outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
          <button
            type="submit"
            disabled={busy || newKey.trim().length < 20}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-40"
          >
            <Plus className="w-4 h-4" /> Add key
          </button>
        </form>

        {loading ? (
          <p className="text-sm text-neutral-500">Loading…</p>
        ) : keys.length === 0 ? (
          <div className="rounded-xl border border-dashed border-neutral-300 p-8 text-center">
            <p className="text-sm font-medium text-neutral-700">No API keys yet</p>
            <p className="text-xs text-neutral-500 mt-1">
              Without one, generation falls back to billed Vertex AI or fails.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-neutral-500 border-b border-neutral-200">
                  <th className="py-2 pr-4 font-medium">Key</th>
                  <th className="py-2 pr-4 font-medium">Label</th>
                  <th className="py-2 pr-4 font-medium">Used for</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 font-medium sr-only">Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} className="border-b border-neutral-100 last:border-0">
                    <td className="py-3 pr-4 font-mono text-neutral-800 whitespace-nowrap">{k.masked}</td>
                    <td className="py-3 pr-4 text-neutral-600">{k.label || <span className="text-neutral-400">—</span>}</td>
                    <td className="py-3 pr-4">
                      <select
                        aria-label={`Category for ${k.masked}`}
                        value={k.category}
                        disabled={busy}
                        onChange={(e) => patch(k.id, { category: e.target.value })}
                        className="px-2 py-1 rounded-lg border border-neutral-300 bg-white text-xs"
                      >
                        {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                      </select>
                    </td>
                    <td className="py-3 pr-4">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                        k.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-neutral-100 text-neutral-500'
                      }`}>
                        {k.enabled ? <Check className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                        {k.enabled ? 'Active' : 'Paused'}
                      </span>
                    </td>
                    <td className="py-3 text-right whitespace-nowrap">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => patch(k.id, { enabled: !k.enabled })}
                        title={k.enabled ? 'Pause this key' : 'Resume this key'}
                        className="p-2 rounded-lg text-neutral-500 hover:bg-neutral-100 disabled:opacity-40"
                      >
                        {k.enabled ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => remove(k)}
                        title="Delete this key"
                        className="p-2 rounded-lg text-red-600 hover:bg-red-50 disabled:opacity-40"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-neutral-400 mt-3">
              Keys are stored on this machine only and are never shown in full again after saving.
              Pause a key to take it out of rotation without losing it.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
