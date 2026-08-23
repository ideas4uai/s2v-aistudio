import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Video, Clock, ChevronRight, Trash2, Search, BookOpen } from 'lucide-react';
import { authenticatedFetch } from '../utils/api';
import { useAuth } from '../contexts/AuthContext';
import { filterProjects, statusOptions, statusLabel, ALL_STATUSES, ProjectSort } from '../utils/projectFilter';

/**
 * The status filter survives leaving the dashboard and coming back, which is the whole
 * point of setting it — the list is long enough that re-picking "failed" every time you
 * open a project and return would defeat it. sessionStorage rather than a URL param or
 * a context: it is one string, it should not outlive the tab, and a throw here (private
 * mode, blocked site data) must not take the dashboard down with it.
 */
const FILTER_KEY = 's2v.dashboard.status';
const rememberedStatus = (): string => {
  try { return sessionStorage.getItem(FILTER_KEY) || ALL_STATUSES; } catch { return ALL_STATUSES; }
};

export function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<ProjectSort>('latest');
  const [statusFilter, setStatusFilter] = useState<string>(rememberedStatus);
  const [universes, setUniverses] = useState<any[]>([]);

  // Delete project state
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchProjects = async () => {
    setLoading(true);
    setError(null);
    try {
      const [projectsRes, universesRes] = await Promise.all([
        authenticatedFetch('/api/projects'),
        authenticatedFetch('/api/universes'),
      ]);
      if (projectsRes.ok) {
        setProjects(await projectsRes.json());
      } else {
        setError(`Server returned ${projectsRes.status}: ${projectsRes.statusText}`);
      }
      if (universesRes.ok) {
        setUniverses(await universesRes.json());
      }
    } catch (error) {
      console.error('Error fetching projects:', error);
      setError('Failed to connect to server. Please try refreshing.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjects();
  }, [user]);

  useEffect(() => {
    try { sessionStorage.setItem(FILTER_KEY, statusFilter); } catch { /* not worth failing over */ }
  }, [statusFilter]);

  const handleDeleteUniverse = async (id: string) => {
    try {
      await authenticatedFetch(`/api/universes/${id}`, { method: 'DELETE' });
      setUniverses(prev => prev.filter(u => u.id !== id));
    } catch (err) {
      alert('Failed to delete universe');
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeletingId(id);
  };

  const confirmDelete = async () => {
    if (!deletingId) return;
    try {
      const res = await authenticatedFetch(`/api/projects/${deletingId}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        setProjects(projects.filter(p => p.id !== deletingId));
      } else {
        console.error('Delete failed', await res.text());
      }
    } catch (e) {
      console.error('Network error during delete:', e);
    } finally {
      setDeletingId(null);
    }
  };

  if (error) {
    return (
      <div className="p-8 max-w-7xl mx-auto">
        <div className="bg-red-50 border border-red-200 rounded-2xl p-6 text-center">
          <h3 className="text-red-900 font-bold mb-2">Connection Issue</h3>
          <p className="text-red-600 mb-4">{error}</p>
          <button 
            onClick={() => window.location.reload()}
            className="bg-red-600 text-white px-4 py-2 rounded-lg font-bold hover:bg-red-700 transition-colors"
          >
            Refresh App
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold text-neutral-900">My Projects</h1>
          <p className="text-neutral-500">Manage and create your video scripts.</p>
        </div>
        <button
          onClick={() => navigate('/projects/new')}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 transition-colors shadow-sm self-start md:self-auto"
        >
          <Plus className="w-5 h-5" /> New Project
        </button>
      </div>

      {/* Universes section */}
      <div className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-neutral-800 flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-indigo-500" /> Your Universes
          </h2>
          <button
            onClick={() => navigate('/universes/new')}
            className="flex items-center gap-1.5 text-sm font-bold text-indigo-600 hover:text-indigo-800 transition-colors"
          >
            <Plus className="w-4 h-4" /> New Universe
          </button>
        </div>
        <div className="flex gap-4 flex-wrap">
          {universes.map(universe => (
            <div
              key={universe.id}
              onClick={() => navigate(`/universes/${universe.id}`)}
              className="relative group bg-white border border-neutral-200 rounded-xl p-4 cursor-pointer hover:shadow-md hover:border-indigo-200 transition-all w-44"
            >
              <button
                onClick={e => {
                  e.stopPropagation();
                  if (window.confirm(`Delete "${universe.title || 'Untitled'}" universe? This cannot be undone.`)) {
                    handleDeleteUniverse(universe.id);
                  }
                }}
                className="absolute top-2 right-2 p-1.5 bg-red-100 hover:bg-red-200 text-red-600 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Trash2 size={14} />
              </button>
              <div className="w-10 h-10 bg-indigo-50 rounded-lg flex items-center justify-center mb-3">
                <BookOpen className="w-5 h-5 text-indigo-600" />
              </div>
              <p className="font-bold text-neutral-900 text-sm truncate">{universe.title || 'Untitled'}</p>
              <p className="text-xs text-neutral-400 mt-1">{(universe.characters || []).length} chars · {(universe.locations || []).length} locations</p>
            </div>
          ))}
          {universes.length === 0 && !loading && (
            <div
              onClick={() => navigate('/universes/new')}
              className="bg-neutral-50 border-2 border-dashed border-neutral-200 rounded-xl p-4 cursor-pointer hover:border-indigo-300 transition-all w-44 flex flex-col items-center justify-center text-center"
            >
              <Plus className="w-6 h-6 text-neutral-300 mb-2" />
              <p className="text-xs font-bold text-neutral-400">Create Universe</p>
            </div>
          )}
        </div>
      </div>

      {!loading && projects.length > 0 && (
        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
            <input
              type="text"
              placeholder="Search projects..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-neutral-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            aria-label="Filter by status"
            className="px-4 py-2.5 rounded-xl border border-neutral-200 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
          >
            <option value={ALL_STATUSES}>All statuses ({projects.length})</option>
            {statusOptions(projects).map(o => (
              <option key={o.value} value={o.value}>{o.label} ({o.count})</option>
            ))}
          </select>
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value as ProjectSort)}
            className="px-4 py-2.5 rounded-xl border border-neutral-200 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
          >
            <option value="latest">Latest First</option>
            <option value="oldest">Oldest First</option>
            <option value="name">Name A-Z</option>
          </select>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-48 bg-neutral-100 rounded-2xl animate-pulse" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="bg-white rounded-2xl border-2 border-dashed border-neutral-200 p-12 text-center">
          <div className="w-16 h-16 bg-neutral-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <Video className="w-8 h-8 text-neutral-300" />
          </div>
          <h3 className="text-lg font-bold text-neutral-900 mb-2">No projects yet</h3>
          <p className="text-neutral-500 mb-6 max-w-xs mx-auto">Create your first project to start turning scripts into videos.</p>
          <button
            onClick={() => navigate('/projects/new')}
            className="text-indigo-600 font-bold hover:text-indigo-700 transition-colors"
          >
            Get started &rarr;
          </button>
        </div>
      ) : (() => {
        const filteredProjects = filterProjects(projects, { query: searchQuery, status: statusFilter, sortBy });
        return (
        <>
          <p className="text-xs text-neutral-400 mb-4">
            Showing {filteredProjects.length} of {projects.length} project{projects.length !== 1 ? 's' : ''}
          </p>
          {filteredProjects.length === 0 ? (
            <div className="bg-white rounded-2xl border border-neutral-200 p-12 text-center">
              <p className="text-neutral-500">
                No {statusFilter === ALL_STATUSES ? '' : `${statusLabel(statusFilter).toLowerCase()} `}projects
                {searchQuery ? ` match "${searchQuery}"` : ''}.
              </p>
            </div>
          ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredProjects.map((project) => (
            <div
              key={project.id}
              onClick={() => {
                if (project.status === 'completed') {
                  navigate(`/projects/${project.id}`);
                } else {
                  navigate(`/projects/${project.id}/edit`);
                }
              }}
              className="bg-white rounded-2xl border border-neutral-200 overflow-hidden hover:shadow-lg hover:border-indigo-200 transition-all cursor-pointer group"
            >
              {project.thumbnail_path ? (
                <img src={project.thumbnail_path} alt={project.title} className="w-full h-32 object-cover" />
              ) : (
                <div className="w-full h-32 bg-neutral-100 flex items-center justify-center">
                  <Video className="w-8 h-8 text-neutral-300" />
                </div>
              )}
              <div className="p-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="w-10 h-10 bg-indigo-50 rounded-lg flex items-center justify-center">
                    <Video className="w-5 h-5 text-indigo-600" />
                  </div>
                  <span className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                    project.status === 'completed' ? 'bg-green-50 text-green-600' :
                    project.status === 'failed' ? 'bg-red-50 text-red-600' :
                    'bg-amber-50 text-amber-600'
                  }`}>
                    {project.status}
                  </span>
                </div>

                <div className="flex justify-between items-start mb-2 mt-4">
                  <h3 className="font-bold text-neutral-900 group-hover:text-indigo-600 transition-colors mr-2">{project.title}</h3>
                  <button
                    onClick={(e) => handleDelete(project.id, e)}
                    className="p-2 text-neutral-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-red-200"
                    aria-label="Delete project"
                    title="Delete project"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                <p className="text-sm text-neutral-500 mb-6 line-clamp-2">{project.description || 'No description provided.'}</p>
                <div className="flex items-center justify-between pt-4 border-t border-neutral-50">
                  <div className="flex items-center gap-1 text-xs text-neutral-400">
                    <Clock className="w-3 h-3" />
                    {new Date(project.createdAt).toLocaleDateString()}
                  </div>
                  <ChevronRight className="w-4 h-4 text-neutral-300 group-hover:text-indigo-400 transition-colors" />
                </div>
              </div>
            </div>
          ))}
        </div>
          )}
        </>
        );
      })()}

      {/* Delete Confirmation Modal */}
      {deletingId && (
        <div className="fixed inset-0 bg-neutral-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 animate-in fade-in zoom-in-95 duration-200">
            <h3 className="text-xl font-bold text-neutral-900 mb-2">Delete Project?</h3>
            <p className="text-neutral-500 mb-6">
              This action cannot be undone. All generated videos, audio, and scripts will be permanently removed.
              Any running generation processes will be immediately stopped.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeletingId(null)}
                className="px-4 py-2 font-medium text-neutral-600 hover:bg-neutral-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="px-4 py-2 font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
              >
                Yes, Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
