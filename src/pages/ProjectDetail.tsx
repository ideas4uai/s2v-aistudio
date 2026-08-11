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
    if (project.status === 'completed' || project.status === 'failed' || project.status === 'cancelled') return;

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

        if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
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
      </div>
    </div>
  );
}
