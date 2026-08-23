import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Video, Clock, ChevronRight, Trash2, Search, BookOpen, CheckSquare, Square, Undo2, X } from 'lucide-react';
import { authenticatedFetch } from '../utils/api';
import { useAuth } from '../contexts/AuthContext';
import { filterProjects, statusOptions, statusLabel, pruneSelection, ALL_STATUSES, ProjectSort } from '../utils/projectFilter';

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

  // Trash is a view of the same list, fetched with ?deleted=true. Not persisted the
  // way the status filter is: landing in Trash on a fresh visit because of something
  // you did yesterday would be alarming, and it is one click to get back to.
  const [showTrash, setShowTrash] = useState(false);
  const [trashCount, setTrashCount] = useState(0);

  // Selection lives as ids rather than indices — the list re-sorts under it.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkConfirm, setBulkConfirm] = useState<null | 'trash' | 'purge' | 'restore'>(null);
  const [busy, setBusy] = useState(false);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The trash count is fetched even when looking at the live list, because the
      // Trash tab has to show how much is in it before you go there.
      const [projectsRes, universesRes, trashRes] = await Promise.all([
        authenticatedFetch(`/api/projects${showTrash ? '?deleted=true' : ''}`),
        authenticatedFetch('/api/universes'),
        authenticatedFetch('/api/projects?deleted=true'),
      ]);
      if (projectsRes.ok) {
        setProjects(await projectsRes.json());
      } else {
        setError(`Server returned ${projectsRes.status}: ${projectsRes.statusText}`);
      }
      if (universesRes.ok) {
        setUniverses(await universesRes.json());
      }
      if (trashRes.ok) {
        setTrashCount((await trashRes.json()).length);
      }
    } catch (error) {
      console.error('Error fetching projects:', error);
      setError('Failed to connect to server. Please try refreshing.');
    } finally {
      setLoading(false);
    }
    // Rebuilt when the view changes, because which list it asks for depends on it.
  }, [showTrash]);

  useEffect(() => {
    fetchProjects();
  }, [user, fetchProjects]);

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

  /**
   * One project, one action. `act` is the endpoint verb — see runOnIds for why the
   * bulk path reuses exactly this call rather than a batch endpoint of its own.
   */
  const applyTo = async (id: string, act: 'trash' | 'restore' | 'purge') => {
    const res = act === 'purge'
      ? await authenticatedFetch(`/api/projects/${id}`, { method: 'DELETE' })
      : await authenticatedFetch(`/api/projects/${id}/${act}`, { method: 'POST' });
    if (res.ok) return;
    const err: any = new Error(`${act} ${id} failed: ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  };

  /**
   * Run one action across a set of ids and report honestly.
   *
   * allSettled rather than all: with twenty projects selected, one 403 must not
   * abandon the other nineteen in an unknown state. Whatever the outcome the list is
   * refetched, so what is on screen is what the server actually holds rather than what
   * the client hoped it did.
   *
   * No bulk endpoint on purpose. These are independent records and the per-project
   * routes already carry the ownership check, the process abort and the write-race
   * retry; a batch route would have to repeat all three and invent its own partial
   * failure shape.
   */
  const runOnIds = async (ids: string[], act: 'trash' | 'restore' | 'purge') => {
    setBusy(true);
    try {
      const results = await Promise.allSettled(ids.map(id => applyTo(id, act)));
      const failed = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
      if (failed.length) {
        console.error(`[Dashboard] ${failed.length} of ${ids.length} failed`, failed);
        // Say WHY, not just how many. Every project this dashboard lists belongs to
        // somebody, and the routes refuse to touch one owned by another account — so
        // "5 failed" on a shared machine is a permissions answer, not a broken button,
        // and a user who cannot tell the two apart will retry forever.
        const denied = failed.filter(f => (f.reason as any)?.status === 403).length;
        const verb = { trash: 'moved to Trash', restore: 'restored', purge: 'deleted' }[act];
        alert(
          `${ids.length - failed.length} of ${ids.length} ${verb}.`
          + (denied ? `

${denied} belong to a different account and cannot be changed from this session.` : '')
          + (failed.length - denied ? `

${failed.length - denied} failed for another reason — see the console.` : ''),
        );
      }
      setSelected(new Set());
      setSelectMode(false);
      await fetchProjects();
    } finally {
      setBusy(false);
    }
  };

  // Deleting from the dashboard is always soft. The only call that removes anything is
  // Trash's "Delete permanently", which is the 'purge' branch of applyTo.
  const confirmDelete = async () => {
    if (!deletingId) return;
    try {
      await runOnIds([deletingId], showTrash ? 'purge' : 'trash');
    } catch (e) {
      console.error('Network error during delete:', e);
    } finally {
      setDeletingId(null);
    }
  };

  const toggleSelected = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const leaveSelectMode = () => { setSelectMode(false); setSelected(new Set()); };

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

      {/* Projects / Trash. A view of the same list, not a separate page: the cards, the
          status filter, the search and the sort all work identically on both sides. */}
      <div className="flex items-center gap-1 mb-4 border-b border-neutral-200">
        {[
          { key: false, label: 'Projects', count: showTrash ? null : projects.length },
          { key: true, label: 'Trash', count: trashCount },
        ].map(tab => (
          <button
            key={String(tab.key)}
            onClick={() => { if (showTrash !== tab.key) { leaveSelectMode(); setShowTrash(tab.key as boolean); } }}
            className={`px-4 py-2.5 text-sm font-bold border-b-2 -mb-px transition-colors ${
              showTrash === tab.key
                ? 'border-indigo-600 text-indigo-700'
                : 'border-transparent text-neutral-500 hover:text-neutral-800'
            }`}
          >
            {tab.label}{tab.count != null && tab.count > 0 ? ` (${tab.count})` : ''}
          </button>
        ))}
      </div>

      {showTrash && projects.length > 0 && (
        <p className="text-xs text-neutral-500 mb-4 bg-neutral-50 border border-neutral-200 rounded-xl px-4 py-2.5">
          Projects here are kept until you act on them — nothing is removed on a timer.
          Restore puts one back exactly as it was; Delete permanently cannot be undone.
        </p>
      )}

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
          <button
            type="button"
            onClick={() => (selectMode ? leaveSelectMode() : setSelectMode(true))}
            className={`px-4 py-2.5 rounded-xl border text-sm font-bold transition-colors whitespace-nowrap ${
              selectMode
                ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                : 'border-neutral-200 bg-white text-neutral-600 hover:text-neutral-900'
            }`}
          >
            {selectMode ? 'Cancel' : 'Select'}
          </button>
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
            {showTrash ? <Trash2 className="w-8 h-8 text-neutral-300" /> : <Video className="w-8 h-8 text-neutral-300" />}
          </div>
          <h3 className="text-lg font-bold text-neutral-900 mb-2">
            {showTrash ? 'Trash is empty' : 'No projects yet'}
          </h3>
          <p className="text-neutral-500 mb-6 max-w-xs mx-auto">
            {showTrash
              ? 'Projects you delete from the dashboard land here, and stay until you restore or permanently delete them.'
              : 'Create your first project to start turning scripts into videos.'}
          </p>
          {!showTrash && (
            <button
              onClick={() => navigate('/projects/new')}
              className="text-indigo-600 font-bold hover:text-indigo-700 transition-colors"
            >
              Get started &rarr;
            </button>
          )}
        </div>
      ) : (() => {
        const filteredProjects = filterProjects(projects, { query: searchQuery, status: statusFilter, sortBy });
        // What is ticked is always a subset of what is on screen. Narrowing the filter
        // with items already selected must not leave them queued for deletion off-view.
        const visibleSelected = pruneSelection(selected, filteredProjects);
        const allVisibleSelected = filteredProjects.length > 0 && visibleSelected.size === filteredProjects.length;
        return (
        <>
          {selectMode && (
            <div className="sticky top-2 z-30 mb-4 flex flex-col sm:flex-row sm:items-center gap-3 rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3 shadow-sm">
              <button
                type="button"
                onClick={() => setSelected(allVisibleSelected ? new Set() : new Set(filteredProjects.map(p => p.id)))}
                className="flex items-center gap-2 text-sm font-bold text-indigo-800 hover:text-indigo-900"
              >
                {allVisibleSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                {allVisibleSelected ? 'Clear' : 'Select all'} ({filteredProjects.length} shown)
              </button>
              <span className="text-sm text-indigo-900 font-medium sm:ml-2">
                {visibleSelected.size} selected
              </span>
              <div className="flex items-center gap-2 sm:ml-auto">
                {showTrash && (
                  <button
                    type="button"
                    disabled={!visibleSelected.size || busy}
                    onClick={() => setBulkConfirm('restore')}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border border-neutral-300 text-sm font-bold text-neutral-700 hover:bg-neutral-50 disabled:opacity-40"
                  >
                    <Undo2 className="w-4 h-4" /> Restore
                  </button>
                )}
                <button
                  type="button"
                  disabled={!visibleSelected.size || busy}
                  onClick={() => setBulkConfirm(showTrash ? 'purge' : 'trash')}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-red-600 text-white text-sm font-bold hover:bg-red-700 disabled:opacity-40"
                >
                  <Trash2 className="w-4 h-4" />
                  {showTrash ? 'Delete permanently' : 'Delete selected'}
                </button>
                <button
                  type="button"
                  onClick={leaveSelectMode}
                  aria-label="Leave selection mode"
                  className="p-2 rounded-xl text-indigo-700 hover:bg-indigo-100"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
          <p className="text-xs text-neutral-400 mb-4">
            Showing {filteredProjects.length} of {projects.length} {showTrash ? 'deleted ' : ''}project{projects.length !== 1 ? 's' : ''}
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
                // In selection mode the whole card is the checkbox — clicking through
                // to a project while ticking a dozen of them is never what was meant.
                if (selectMode) { toggleSelected(project.id); return; }
                if (project.status === 'completed') {
                  navigate(`/projects/${project.id}`);
                } else {
                  navigate(`/projects/${project.id}/edit`);
                }
              }}
              className={`relative bg-white rounded-2xl border overflow-hidden transition-all cursor-pointer group ${
                visibleSelected.has(project.id)
                  ? 'border-indigo-500 ring-2 ring-indigo-200 shadow-md'
                  : 'border-neutral-200 hover:shadow-lg hover:border-indigo-200'
              }`}
            >
              {selectMode && (
                <div className="absolute top-3 left-3 z-10">
                  <input
                    type="checkbox"
                    checked={visibleSelected.has(project.id)}
                    onChange={() => toggleSelected(project.id)}
                    onClick={e => e.stopPropagation()}
                    aria-label={`Select ${project.title || 'project'}`}
                    className="w-5 h-5 accent-indigo-600 rounded cursor-pointer"
                  />
                </div>
              )}
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
                  <div className="flex items-center shrink-0">
                    {showTrash && (
                      <button
                        onClick={(e) => { e.stopPropagation(); runOnIds([project.id], 'restore'); }}
                        disabled={busy}
                        className="p-2 text-neutral-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-40"
                        aria-label="Restore project"
                        title="Restore project"
                      >
                        <Undo2 className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={(e) => handleDelete(project.id, e)}
                      className="p-2 text-neutral-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-red-200"
                      aria-label={showTrash ? 'Delete permanently' : 'Move to Trash'}
                      title={showTrash ? 'Delete permanently' : 'Move to Trash'}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
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
      {/* Single project. The wording is not shared between the two views on purpose:
          from the dashboard this is recoverable and should not read like a warning,
          and from Trash it is final and must. */}
      {deletingId && (
        <div className="fixed inset-0 bg-neutral-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 animate-in fade-in zoom-in-95 duration-200">
            <h3 className="text-xl font-bold text-neutral-900 mb-2">
              {showTrash ? 'Delete permanently?' : 'Move to Trash?'}
            </h3>
            <p className="text-neutral-500 mb-6">
              {showTrash
                ? 'This cannot be undone. The project record, its generated video, audio and scripts are removed for good.'
                : 'The project moves to Trash and leaves the dashboard. Nothing is deleted — you can restore it with everything intact. Any running generation is stopped.'}
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeletingId(null)}
                disabled={busy}
                className="px-4 py-2 font-medium text-neutral-600 hover:bg-neutral-100 rounded-lg transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={busy}
                className="px-4 py-2 font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:opacity-50"
              >
                {busy ? 'Working…' : showTrash ? 'Delete permanently' : 'Move to Trash'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk. Always confirmed, including the recoverable case: the count is the whole
          point — it is what tells you the filter selected more than you thought. */}
      {bulkConfirm && (() => {
        const ids = [...pruneSelection(selected, filterProjects(projects, { query: searchQuery, status: statusFilter, sortBy }))];
        const noun = `${ids.length} project${ids.length === 1 ? '' : 's'}`;
        const copy = {
          trash: { title: `Move ${noun} to Trash?`, body: 'They leave the dashboard but nothing is deleted — restore them from Trash with everything intact.', cta: 'Move to Trash' },
          restore: { title: `Restore ${noun}?`, body: 'They return to the dashboard exactly as they were, with their status, scenes and renders unchanged.', cta: 'Restore' },
          purge: { title: `Permanently delete ${noun}?`, body: 'This cannot be undone. Every selected project record, and its generated video, audio and scripts, are removed for good.', cta: 'Delete permanently' },
        }[bulkConfirm];
        return (
          <div className="fixed inset-0 bg-neutral-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 animate-in fade-in zoom-in-95 duration-200">
              <h3 className="text-xl font-bold text-neutral-900 mb-2">{copy.title}</h3>
              <p className="text-neutral-500 mb-6">{copy.body}</p>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setBulkConfirm(null)}
                  disabled={busy}
                  className="px-4 py-2 font-medium text-neutral-600 hover:bg-neutral-100 rounded-lg transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => { const act = bulkConfirm; setBulkConfirm(null); await runOnIds(ids, act); }}
                  disabled={busy || !ids.length}
                  className={`px-4 py-2 font-medium text-white rounded-lg transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 ${
                    bulkConfirm === 'restore'
                      ? 'bg-indigo-600 hover:bg-indigo-700 focus:ring-indigo-500'
                      : 'bg-red-600 hover:bg-red-700 focus:ring-red-500'
                  }`}
                >
                  {busy ? 'Working…' : copy.cta}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
