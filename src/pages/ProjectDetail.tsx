import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Video, ArrowLeft, Pencil, Undo2, Trash2 } from 'lucide-react';
import { authenticatedFetch } from '../utils/api';

export function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<any>(null);

  // Bumping this re-runs the load effect — the polling effect uses it to ask for a
  // full refetch without calling the loader directly (which would be a setState
  // reachable synchronously from an effect body).
  const [reloadKey, setReloadKey] = useState(0);
  const [restoring, setRestoring] = useState(false);

  // Initial load + re-fetch when the window regains focus (user navigates back).
  // The request is the external system; setProject runs from its .then callback,
  // never synchronously inside the effect.
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      authenticatedFetch(`/api/projects/${id}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => { if (data && !cancelled) setProject(data); })
        .catch((error) => { if (!cancelled) console.error('Error fetching project:', error); });

    load();
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [id, reloadKey]);

  // Poll status while a render is in progress; apply output_path as soon as it lands
  useEffect(() => {
    if (!project) return;
    // Nothing is running on a trashed project — trashing aborts its processes — so
    // polling one would be a request every three seconds forever.
    if (project.deleted_at) return;
    if (['completed', 'degraded', 'failed', 'cancelled'].includes(project.status)) return;

    const interval = setInterval(async () => {
      try {
        const res = await authenticatedFetch(`/api/projects/${id}/status`);
        if (!res.ok) return;
        const data = await res.json();

        if (data.output_path) {
          setProject((prev: any) => prev ? {
            ...prev,
            output_path: data.output_path,
            outputPath:  data.output_path,
            status:      data.status,
          } : prev);
        }

        // 'degraded' is terminal too — it is what a finished render that failed the
        // quality gate reports. Leaving it out polled forever and never refetched, so
        // the gate result never reached the page.
        if (['completed', 'degraded', 'failed', 'cancelled'].includes(data.status)) {
          clearInterval(interval);
          setReloadKey((k) => k + 1); // pull the finished project in full
        }
      } catch { /* non-fatal */ }
    }, 3000);

    return () => clearInterval(interval);
  }, [project?.status, project?.deleted_at, id]);

  if (!project) return <div className="p-8 text-center text-neutral-500 animate-pulse">Loading project details...</div>;

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto">
      <button 
        onClick={() => navigate('/')}
        className="flex items-center gap-2 text-neutral-500 hover:text-neutral-900 mb-6 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Dashboard
      </button>

      <div className="bg-white rounded-3xl p-8 border border-neutral-200 shadow-sm mb-8">
        {/* A trashed project stays readable by direct URL rather than 404ing.
            Deliberate: the record is intact, the video still plays, and 404 would make
            the one thing you came here to do — get it back — impossible. What it must
            not do is look like a live project, so the state is stated plainly, Restore
            is offered here, and the Edit button below is withheld: editing something
            the dashboard has already hidden is how you lose an afternoon's work to a
            render nobody can find. */}
        {project.deleted_at && (
          <div className="mb-5 flex flex-col sm:flex-row sm:items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4">
            <div className="flex items-start gap-3">
              <Trash2 className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-bold text-amber-900">This project is in Trash</p>
                <p className="text-sm text-amber-800">
                  Deleted {new Date(project.deleted_at).toLocaleString()}. It is hidden from the
                  dashboard and cannot be edited until you restore it. Nothing has been removed.
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={restoring}
              onClick={async () => {
                setRestoring(true);
                try {
                  const res = await authenticatedFetch(`/api/projects/${project.project_id || project.id || id}/restore`, { method: 'POST' });
                  if (res.ok) setReloadKey((k) => k + 1);
                  else console.error('Restore failed', await res.text());
                } finally { setRestoring(false); }
              }}
              className="shrink-0 sm:ml-auto flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-600 text-white text-sm font-bold hover:bg-amber-700 disabled:opacity-50"
            >
              <Undo2 className="w-4 h-4" /> {restoring ? 'Restoring…' : 'Restore'}
            </button>
          </div>
        )}

        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-2">
          <h1 className="text-3xl font-bold text-neutral-900">{project.title}</h1>
          {/* The only way into the editor from here. The dashboard sends completed
              projects to this page and everything else straight to the editor, so
              without this a finished video had no route back to the thing that made
              it. Not gated on status: this page is also reached by direct URL and by
              back-navigation, and a degraded or failed render is exactly the one you
              want to open and re-run. Re-rendering from there reuses the existing
              staleness checks, so approved scenes are not regenerated. */}
          {!project.deleted_at && (
          <button
            type="button"
            onClick={() => navigate(`/projects/${project.project_id || project.id || id}/edit`)}
            className="shrink-0 self-start flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
          >
            <Pencil className="w-4 h-4" /> Edit
          </button>
          )}
        </div>
        <p className="text-neutral-500 mb-8 max-w-3xl">{project.description || 'No description provided.'}</p>
        
        <div className="bg-neutral-900 rounded-2xl overflow-hidden aspect-video flex items-center justify-center">
          {project.output_path || project.previewVideoPath || project.outputPath ? (
            <video 
              src={project.output_path || project.previewVideoPath || project.outputPath} 
              controls 
              className="w-full h-full object-contain"
            />
          ) : (
            <div className="flex flex-col items-center justify-center text-neutral-500 gap-4">
              <Video className="w-12 h-12 mb-2 opacity-50" />
              <p>Video is rendering or not available yet.</p>
            </div>
          )}
        </div>

        {/* Cloud backup. Separate from the quality gate on purpose: a failed upload says
            nothing about the video, which is finished and playing above from local disk.
            It is shown because the alternative — a console line — is how three weeks of
            uploads went missing without anyone noticing. */}
        {project.cloud_backup && project.cloud_backup.status !== 'uploaded' && (
          <div
            className={`mt-6 rounded-2xl border p-4 ${
              project.cloud_backup.status === 'failed'
                ? 'border-red-300 bg-red-50'
                : 'border-neutral-200 bg-neutral-50'
            }`}
          >
            <div className="text-sm font-bold uppercase tracking-wider text-neutral-700">
              {project.cloud_backup.status === 'failed' ? 'No cloud backup' : 'Cloud backup in progress'}
            </div>
            <p className="mt-1 text-sm text-neutral-700">
              {project.cloud_backup.status === 'failed'
                ? 'This video exists only on this machine. The render itself is fine and the video plays above — but it is not backed up.'
                : 'Uploading a copy to cloud storage. The video above is already final and playable.'}
            </p>
            {project.cloud_backup.error && (
              <p className="mt-2 text-xs text-red-900 font-mono break-all">{project.cloud_backup.error}</p>
            )}
          </div>
        )}

        {/* Quality gate. A video that failed the gate still renders and downloads —
            it is simply not cleared to publish, and the reasons say exactly why. */}
        {project.quality_gate && (
          <div
            className={`mt-6 rounded-2xl border p-5 ${
              project.quality_gate.passed
                ? 'border-green-200 bg-green-50'
                : 'border-amber-300 bg-amber-50'
            }`}
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-bold uppercase tracking-wider text-neutral-700">
                {project.quality_gate.passed ? 'Quality gate passed' : 'Not ready to publish'}
              </span>
              <span className="text-xs text-neutral-500">
                score {project.quality_gate.score}/100
              </span>
            </div>

            {!project.quality_gate.passed && (
              <ul className="list-disc list-inside space-y-1 mb-3">
                {project.quality_gate.failures.map((f: string, i: number) => (
                  <li key={i} className="text-sm text-amber-900">{f}</li>
                ))}
              </ul>
            )}

            <details>
              <summary className="text-xs text-neutral-500 cursor-pointer">All checks</summary>
              <ul className="mt-2 space-y-1">
                {project.quality_gate.checks.map((c: any) => (
                  <li key={c.id} className="text-xs text-neutral-600">
                    <span
                      className={
                        c.status === 'pass' ? 'text-green-700'
                          : c.status === 'fail' ? 'text-amber-700'
                          : 'text-neutral-400'
                      }
                    >
                      {c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'NOT CHECKED'}
                    </span>{' '}
                    {c.label} — {c.detail}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}

        <PublishPanel project={project} onPublished={() => setReloadKey((k) => k + 1)} />
      </div>
    </div>
  );
}

/**
 * Manual publish to YouTube.
 *
 * Deliberately a button per video, not a switch that publishes everything. Nothing here
 * decides whether the video is publishable — the server enforces the quality gate, so
 * this panel only has to explain the answer it gets back. Privacy defaults to unlisted:
 * the first upload from a new pipeline should be reviewable before it is public.
 */
function PublishPanel({ project, onPublished }: { project: any; onPublished: () => void }) {
  const [status, setStatus] = useState<any>(null);
  const [privacy, setPrivacy] = useState<'private' | 'unlisted' | 'public'>('unlisted');
  // Which channel this upload will go to. Resolved once status arrives, in the same
  // order the server uses: the project's own tag first, then last-used. Held in state
  // so it is always an explicit value on screen rather than an implicit server default.
  const [channelId, setChannelId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ failures: string[]; score: number } | null>(null);

  useEffect(() => {
    authenticatedFetch('/api/youtube/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        setStatus(s);
        const known = new Set((s?.channels || []).map((c: any) => c.channelId));
        // The project's tag wins over last-used, and last-used is only a convenience.
        // A tag pointing at a disconnected channel falls through rather than selecting
        // nothing, which would leave the button enabled with no target.
        const tagged = project.channel_id;
        const pick = (known.has(tagged) && tagged)
          || (known.has(s?.lastUsedChannelId) && s?.lastUsedChannelId)
          || (s?.channels?.[0]?.channelId ?? '');
        setChannelId(pick || '');
      })
      .catch(() => setStatus(null));
  }, [project.channel_id]);

  const published = project.youtube;

  async function publish(force = false) {
    setBusy(true); setError(null); setBlocked(null);
    try {
      const res = await authenticatedFetch(`/api/projects/${project.project_id || project.id}/publish/youtube`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privacyStatus: privacy, force, channelId: channelId || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // A gate block is not an error the user needs to debug — it is the system
        // working, so it gets the reasons and an explicit way to overrule it.
        if (res.status === 409 && body.failures) setBlocked({ failures: body.failures, score: body.score });
        else setError(body.error || `Publish failed (${res.status})`);
        return;
      }
      onPublished();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!project.output_path) return null;

  return (
    <div className="mt-6 rounded-2xl border border-neutral-200 bg-white p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-bold uppercase tracking-wider text-neutral-700">Publish to YouTube</span>
        {status?.channelTitle && <span className="text-xs text-neutral-500">{status.channelTitle}</span>}
      </div>

      {published ? (
        <p className="text-sm text-green-700">
          Published to <strong>{published.channelTitle || 'your channel'}</strong> as{' '}
          <strong>{published.privacyStatus}</strong> —{' '}
          <a className="underline" href={published.url} target="_blank" rel="noreferrer">{published.url}</a>
          {published.forcedPastQualityGate && (
            <span className="block mt-1 text-xs text-amber-700">Published past a failing quality gate.</span>
          )}
        </p>
      ) : status && !status.configured ? (
        <p className="text-sm text-neutral-600">
          Not configured. Set <code>YOUTUBE_CLIENT_ID</code> and <code>YOUTUBE_CLIENT_SECRET</code> in{' '}
          <code>.env</code>, then connect the channel.
        </p>
      ) : status && !status.connected ? (
        <p className="text-sm text-neutral-600">
          No channel connected.{' '}
          <a className="text-indigo-600 underline" href="/api/youtube/auth">Connect a YouTube channel</a>.
        </p>
      ) : (
        <div className="space-y-4">
          {/* The channel, stated as a banner rather than offered as a dropdown.
              Publishing to the wrong one of three similarly-named channels is the
              expensive mistake here, and it is not caught by a control that reads as a
              default. It says the name, shows the watermark that will be on the video,
              and says WHY that channel was chosen. */}
          {(status?.channels?.length ?? 0) > 0 && (() => {
            const sel = status.channels.find((c: any) => c.channelId === channelId);
            const why = project.channel_id === channelId ? 'tagged on this project at creation'
              : status.lastUsedChannelId === channelId ? 'the channel you published to last'
              : 'the only connected channel';
            return (
              <div className="rounded-2xl border-2 border-indigo-300 bg-indigo-50 p-4">
                <div className="flex items-center gap-3">
                  {sel?.hasLogo ? (
                    <img src={`/api/youtube/channels/${sel.channelId}/logo`} alt=""
                         className="w-11 h-11 rounded-full object-cover bg-white" />
                  ) : (
                    <span className="w-11 h-11 rounded-full bg-white flex items-center justify-center text-base font-bold text-indigo-700">
                      {String(sel?.title || '?').slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wider font-bold text-indigo-700">Publishing to</p>
                    <p className="text-lg font-bold text-indigo-900 truncate">{sel?.title || 'Select a channel'}</p>
                    <p className="text-xs text-indigo-700">{sel ? why : 'no channel selected'}</p>
                  </div>
                </div>
                {status.channels.length > 1 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {status.channels.map((c: any) => (
                      <button
                        key={c.channelId}
                        type="button"
                        disabled={busy}
                        onClick={() => setChannelId(c.channelId)}
                        aria-pressed={c.channelId === channelId}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors disabled:opacity-50 ${
                          c.channelId === channelId
                            ? 'border-indigo-600 bg-indigo-600 text-white'
                            : 'border-indigo-200 bg-white text-indigo-800 hover:border-indigo-400'
                        }`}
                      >
                        {c.title}
                      </button>
                    ))}
                  </div>
                )}
                {project.channel_id && project.channel_id !== channelId && (
                  <p className="mt-3 text-xs font-bold text-amber-800 bg-amber-100 border border-amber-300 rounded-lg px-3 py-2">
                    This project was created for{' '}
                    {status.channels.find((c: any) => c.channelId === project.channel_id)?.title || 'another channel'},
                    and its watermark is that channel&apos;s. You are about to publish it somewhere else.
                  </p>
                )}
              </div>
            );
          })()}

        <div className="flex items-center gap-3">
          <select
            className="px-3 py-2 rounded-xl border border-neutral-300 bg-white text-sm"
            value={privacy}
            onChange={(e) => setPrivacy(e.target.value as any)}
            disabled={busy}
          >
            <option value="unlisted">Unlisted</option>
            <option value="private">Private</option>
            <option value="public">Public</option>
          </select>
          <button
            type="button"
            onClick={() => publish(false)}
            disabled={busy}
            className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? 'Uploading…' : 'Publish'}
          </button>
        </div>
        </div>
      )}

      {blocked && (
        <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm font-bold text-amber-900">Blocked by the quality gate (score {blocked.score}/100)</p>
          <ul className="list-disc list-inside mt-1">
            {blocked.failures.map((f, i) => <li key={i} className="text-sm text-amber-900">{f}</li>)}
          </ul>
          <button
            type="button"
            onClick={() => publish(true)}
            disabled={busy}
            className="mt-2 text-xs underline text-amber-900"
          >
            Publish anyway
          </button>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  );
}
