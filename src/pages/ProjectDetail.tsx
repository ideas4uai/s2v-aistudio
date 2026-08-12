import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Video, ArrowLeft } from 'lucide-react';
import { authenticatedFetch } from '../utils/api';

export function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<any>(null);

  // Bumping this re-runs the load effect — the polling effect uses it to ask for a
  // full refetch without calling the loader directly (which would be a setState
  // reachable synchronously from an effect body).
  const [reloadKey, setReloadKey] = useState(0);

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
  }, [project?.status, id]);

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
        <h1 className="text-3xl font-bold text-neutral-900 mb-2">{project.title}</h1>
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
      </div>
    </div>
  );
}
