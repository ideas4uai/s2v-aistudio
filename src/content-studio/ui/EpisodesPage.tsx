import { AlertCircle, CheckCircle2, CircleDashed, Clock, Play, RefreshCw, Rocket, SkipForward } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { authenticatedFetch } from '../../utils/api';

type StageStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed' | 'awaiting_approval';
interface StageState { stage: string; status: StageStatus; attempts: number; error?: string }
interface Episode { id: string; title: string; topic: string; status: string; productionPackageId: string; workflowRunId?: string; updatedAt: string }
interface Run { id: string; status: string; stages: StageState[] }
interface ProductionPackage { story: { title: string; hook: string }; scenes: unknown[]; qualityScores: { overall?: number }; render: { script2VideoProjectId?: string } }

const STAGE_LABELS: Record<string, string> = {
  idea: 'Idea', story: 'Story + review', package: 'Scenes + copy', handoff: 'Send to Script2Video',
};

const STAGE_ICONS: Record<StageStatus, typeof CheckCircle2> = {
  completed: CheckCircle2, failed: AlertCircle, awaiting_approval: Clock,
  running: RefreshCw, skipped: SkipForward, pending: CircleDashed,
};

const STAGE_TONES: Record<StageStatus, string> = {
  completed: 'text-emerald-600', failed: 'text-red-600', awaiting_approval: 'text-amber-600',
  running: 'text-indigo-600', skipped: 'text-slate-400', pending: 'text-slate-300',
};

export function EpisodesPage() {
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [selected, setSelected] = useState<Episode | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [pkg, setPkg] = useState<ProductionPackage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(async (url: string, init?: RequestInit) => {
    const response = await authenticatedFetch(url, init);
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Request failed (${response.status}).`);
    return response.status === 204 ? null : response.json();
  }, []);

  const loadEpisodes = useCallback(async () => {
    try {
      setEpisodes(await call('/api/content-studio/episodes'));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load episodes.');
    }
  }, [call]);

  useEffect(() => { void loadEpisodes(); }, [loadEpisodes]);

  const open = useCallback(async (episode: Episode) => {
    setSelected(episode);
    setError(null);
    setRun(null);
    try {
      const detail = await call(`/api/content-studio/episodes/${episode.id}`);
      setPkg(detail.productionPackage);
      if (episode.workflowRunId) setRun((await call(`/api/content-studio/workflows/${episode.workflowRunId}`)).run);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : 'Could not load the episode.');
    }
  }, [call]);

  async function act(request: () => Promise<any>) {
    setBusy(true);
    setError(null);
    try {
      setRun(await request());
      if (selected) {
        const detail = await call(`/api/content-studio/episodes/${selected.id}`);
        setPkg(detail.productionPackage);
      }
      await loadEpisodes();
    } catch (actError) {
      setError(actError instanceof Error ? actError.message : 'The workflow action failed.');
    } finally {
      setBusy(false);
    }
  }

  const startRun = () => act(async () => {
    const created = await call(`/api/content-studio/episodes/${selected!.id}/workflows`, { method: 'POST' });
    setSelected({ ...selected!, workflowRunId: created.id });
    return created;
  });

  const stageAction = (action: string, stage: string) =>
    act(() => call(`/api/content-studio/workflows/${run!.id}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage }),
    }));

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-semibold text-indigo-600">Production</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">Episodes</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Advance an episode one agent at a time. The final stage creates a draft Script2Video project — rendering stays yours to trigger.
        </p>
      </header>

      {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
        <aside className="space-y-2">
          {episodes.length === 0 && (
            <div className="rounded-2xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
              No episodes yet.{' '}
              <Link to="/content-studio/director" className="font-bold text-indigo-600 hover:text-indigo-700">Create one</Link>.
            </div>
          )}
          {episodes.map((episode) => (
            <button
              key={episode.id}
              onClick={() => void open(episode)}
              className={`w-full rounded-xl border px-4 py-3 text-left transition ${selected?.id === episode.id ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}
            >
              <p className="truncate text-sm font-bold text-slate-950">{episode.title}</p>
              <p className="mt-0.5 truncate text-xs text-slate-500">{episode.topic}</p>
              <span className="mt-2 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600">{episode.status}</span>
            </button>
          ))}
        </aside>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          {!selected && <p className="text-sm text-slate-500">Select an episode to see its workflow.</p>}

          {selected && (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-bold text-slate-950">{pkg?.story.title || selected.title}</h2>
                  {pkg?.story.hook && <p className="mt-1 max-w-xl text-sm italic text-slate-600">“{pkg.story.hook}”</p>}
                  <p className="mt-2 text-xs text-slate-500">
                    {pkg?.scenes.length ?? 0} scenes{pkg?.qualityScores.overall ? ` · scored ${pkg.qualityScores.overall}/10` : ''}
                  </p>
                </div>
                {!run && (
                  <button onClick={startRun} disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-indigo-700 disabled:opacity-60">
                    <Play className="h-4 w-4" /> Start workflow
                  </button>
                )}
                {run && (
                  <button onClick={() => act(() => call(`/api/content-studio/workflows/${run.id}/run-next`, { method: 'POST' }))} disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-indigo-700 disabled:opacity-60">
                    <Play className="h-4 w-4" /> {busy ? 'Running…' : 'Run next stage'}
                  </button>
                )}
              </div>

              {run && (
                <ol className="mt-6 space-y-2">
                  {run.stages.map((stage) => {
                    const Icon = STAGE_ICONS[stage.status];
                    return (
                      <li key={stage.stage} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-100 px-4 py-3">
                        <Icon className={`h-4 w-4 shrink-0 ${STAGE_TONES[stage.status]}`} />
                        <span className="text-sm font-semibold text-slate-800">{STAGE_LABELS[stage.stage] ?? stage.stage}</span>
                        <span className="text-xs text-slate-400">{stage.status.replace(/_/g, ' ')}{stage.attempts ? ` · attempt ${stage.attempts}` : ''}</span>
                        {stage.error && <span className="w-full text-xs text-red-600">{stage.error}</span>}
                        <span className="ml-auto flex gap-2">
                          {stage.status === 'awaiting_approval' && (
                            <button onClick={() => stageAction('approve', stage.stage)} disabled={busy} className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-60">Approve</button>
                          )}
                          {stage.status === 'failed' && (
                            <button onClick={() => stageAction('retry', stage.stage)} disabled={busy} className="rounded-lg bg-slate-800 px-2.5 py-1 text-xs font-bold text-white hover:bg-slate-900 disabled:opacity-60">Retry</button>
                          )}
                          {(stage.status === 'failed' || stage.status === 'awaiting_approval') && (
                            <button onClick={() => stageAction('skip', stage.stage)} disabled={busy} className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-60">Skip</button>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}

              {pkg?.render.script2VideoProjectId && (
                <Link to={`/projects/${pkg.render.script2VideoProjectId}`} className="mt-6 inline-flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-bold text-white hover:bg-slate-800">
                  <Rocket className="h-4 w-4" /> Open in Script2Video
                </Link>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
