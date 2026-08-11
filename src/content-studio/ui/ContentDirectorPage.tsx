import { ArrowRight, BrainCircuit, FilePlus2, Layers3, Sparkles } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { authenticatedFetch } from '../../utils/api';

export function ContentDirectorPage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  // Scopes which knowledge base the agents may read. Blank means the shared
  // 'default' universe, so this stays optional for single-brand users.
  const [universe, setUniverse] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createEpisode(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await authenticatedFetch('/api/content-studio/episodes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, topic, universe }),
      });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not create the episode.');
      navigate('/content-studio/episodes');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not create the episode.');
    } finally {
      setSubmitting(false);
    }
  }

  return <div className="space-y-6">
    <header><p className="text-sm font-semibold text-indigo-600">Guided planning</p><h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">Content Director</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Create a durable episode and its Production Package first. Workflow agents fill the package; Script2Video renders only after approval.</p></header>
    <div className="grid gap-6 xl:grid-cols-[1fr_0.8fr]">
      <form onSubmit={createEpisode} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-3"><div className="rounded-xl bg-indigo-50 p-2.5 text-indigo-600"><FilePlus2 className="h-5 w-5" /></div><div><h2 className="font-bold text-slate-950">Start an episode</h2><p className="text-sm text-slate-500">This creates a draft, its workflow state, and a versioned package.</p></div></div>
        <label className="mt-6 block text-sm font-semibold text-slate-700">Working title<input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={160} placeholder="e.g. The deploy that broke on a Friday" className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100" /></label>
        <label className="mt-4 block text-sm font-semibold text-slate-700">Topic<input value={topic} onChange={(event) => setTopic(event.target.value)} required maxLength={400} placeholder="What should the audience learn or feel?" className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100" /></label>
        <label className="mt-4 block text-sm font-semibold text-slate-700">Universe<input value={universe} onChange={(event) => setUniverse(event.target.value)} maxLength={80} placeholder="e.g. aiqa-engineer — scopes which bibles the agents read" className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100" /></label>
        {error && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <button disabled={submitting} className="mt-6 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"><Sparkles className="h-4 w-4" />{submitting ? 'Creating...' : 'Create production package'}</button>
      </form>
      <section className="rounded-2xl bg-slate-950 p-6 text-white shadow-sm"><BrainCircuit className="h-6 w-6 text-indigo-300" /><h2 className="mt-5 text-xl font-bold">How this stays modular</h2><ol className="mt-4 space-y-3 text-sm leading-6 text-slate-300"><li><span className="mr-2 font-bold text-white">1.</span>The workflow coordinator chooses one agent stage at a time.</li><li><span className="mr-2 font-bold text-white">2.</span>Every agent receives the same Production Package and relevant knowledge.</li><li><span className="mr-2 font-bold text-white">3.</span>Approvals, retries, skips, metrics, and logs are persisted with the workflow.</li></ol><Link to="/content-studio/knowledge" className="mt-6 inline-flex items-center gap-2 text-sm font-bold text-indigo-200 hover:text-white">Prepare knowledge <ArrowRight className="h-4 w-4" /></Link></section>
    </div>
    <Link to="/content-studio/episodes" className="inline-flex items-center gap-2 text-sm font-bold text-indigo-600 hover:text-indigo-700"><Layers3 className="h-4 w-4" />View existing episodes</Link>
  </div>;
}
