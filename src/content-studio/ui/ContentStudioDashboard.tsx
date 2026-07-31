import { Activity, ArrowRight, BookOpen, FilePlus2, Layers3, Lightbulb, RefreshCw, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { authenticatedFetch } from '../../utils/api';

interface StudioDashboardData {
  ideasWaiting: number;
  episodes: number;
  inProduction: number;
  knowledgeDocuments: number;
  recentlyPublished: Array<{ id: string; title: string; publishedAt?: string }>;
  publishingQueue: Array<{ id: string; title: string }>;
}

const emptyDashboard: StudioDashboardData = {
  ideasWaiting: 0, episodes: 0, inProduction: 0, knowledgeDocuments: 0, recentlyPublished: [], publishingQueue: [],
};

export function ContentStudioDashboard() {
  const [data, setData] = useState<StudioDashboardData>(emptyDashboard);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/content-studio/dashboard');
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      setData(await response.json());
    } catch (loadError) {
      console.error('Failed to load Content Studio dashboard', loadError);
      setError('The Content Studio dashboard could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  const metrics = [
    { label: 'Ideas waiting', value: data.ideasWaiting, icon: Lightbulb, accent: 'bg-amber-50 text-amber-700' },
    { label: 'Episodes', value: data.episodes, icon: Layers3, accent: 'bg-indigo-50 text-indigo-700' },
    { label: 'In production', value: data.inProduction, icon: Activity, accent: 'bg-violet-50 text-violet-700' },
    { label: 'Knowledge health', value: data.knowledgeDocuments, icon: BookOpen, accent: 'bg-emerald-50 text-emerald-700' },
  ];

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-2 text-sm font-semibold text-indigo-600">Content operating system</p>
          <h1 className="text-3xl font-black tracking-tight text-slate-950">AI Content Studio</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Choose the story, create a production package, then hand it to Script2Video only when it is ready to render.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void loadDashboard()} aria-label="Refresh dashboard" className="rounded-xl border border-slate-200 bg-white p-2.5 text-slate-500 transition hover:bg-slate-50 hover:text-slate-900">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <Link to="/content-studio/ideas" className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-indigo-700">
            <FilePlus2 className="h-4 w-4" /> New idea
          </Link>
        </div>
      </header>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(({ label, value, icon: Icon, accent }) => (
          <div key={label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className={`mb-4 inline-flex rounded-xl p-2 ${accent}`}><Icon className="h-4 w-4" /></div>
            <p className="text-2xl font-black text-slate-950">{loading ? '—' : value}</p>
            <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div><h2 className="font-bold text-slate-950">Publishing queue</h2><p className="mt-1 text-sm text-slate-500">Approved work, waiting for production.</p></div>
            <Link to="/content-studio/production-packages" className="text-sm font-semibold text-indigo-600 hover:text-indigo-700">Open packages</Link>
          </div>
          {loading ? <div className="mt-5 h-20 animate-pulse rounded-xl bg-slate-100" /> : data.publishingQueue.length ? (
            <div className="mt-4 divide-y divide-slate-100">{data.publishingQueue.map((episode) => <div className="flex items-center justify-between py-3" key={episode.id}><span className="text-sm font-medium text-slate-800">{episode.title}</span><ArrowRight className="h-4 w-4 text-slate-400" /></div>)}</div>
          ) : <EmptyState title="Nothing is ready to render" body="Move an episode through review to create a production-ready package." action="Open Content Director" to="/content-studio/director" />}
        </section>
        <section className="rounded-2xl border border-slate-200 bg-slate-950 p-5 text-white shadow-sm">
          <Sparkles className="mb-5 h-5 w-5 text-indigo-300" />
          <h2 className="text-lg font-bold">Start with a strong premise</h2>
          <p className="mt-2 text-sm leading-6 text-slate-300">The Content Director will turn a topic into an approved package while preserving your brand and character knowledge.</p>
          <Link to="/content-studio/director" className="mt-5 inline-flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-bold text-slate-900 transition hover:bg-indigo-50">Open Content Director <ArrowRight className="h-4 w-4" /></Link>
        </section>
      </div>
    </div>
  );
}

function EmptyState({ title, body, action, to }: { title: string; body: string; action: string; to: string }) {
  return <div className="mt-5 rounded-xl border border-dashed border-slate-200 bg-slate-50 p-5"><p className="font-semibold text-slate-800">{title}</p><p className="mt-1 text-sm leading-6 text-slate-500">{body}</p><Link to={to} className="mt-3 inline-flex text-sm font-semibold text-indigo-600 hover:text-indigo-700">{action} <ArrowRight className="ml-1 h-4 w-4" /></Link></div>;
}
