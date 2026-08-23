/**
 * The dashboard's project list: search, status filter, sort.
 *
 * Pure and separate from Dashboard.tsx so it can be tested without a DOM — there is
 * no jsdom or testing-library in this repo, and standing one up to assert a dropdown
 * would cost more than the feature.
 *
 * Everything here operates on the single array GET /api/projects returns, which the
 * route has already merged from local disk and Firestore (local wins on id). So the
 * filter cannot see, and cannot preferentially treat, either source.
 */

export type ProjectSort = 'latest' | 'oldest' | 'name';

/** The sentinel for "don't filter". Not a real status, so it can never collide. */
export const ALL_STATUSES = 'all';

/**
 * True if this project is in Trash.
 *
 * One predicate, used by the server to split the list and by the client to prune a
 * selection, so the two can never disagree about what "deleted" means. Any non-empty
 * `deleted_at` counts — a record that has been through JSON carries a string, and an
 * explicit null (what restore writes) has to read as live.
 */
export const isTrashed = (p: any): boolean => Boolean(p?.deleted_at);

/**
 * Keep only the ids that survive the current view.
 *
 * The selection is held as ids, and the visible list changes under it whenever the
 * status filter, the search box or the Trash toggle changes. Without this, narrowing
 * to "Failed" and hitting Delete would also delete the completed projects ticked a
 * moment earlier and no longer on screen — the user would be acting on a list they
 * cannot see. Applied on every render of the list, so what is ticked is always a
 * subset of what is shown.
 */
export const pruneSelection = (selected: Iterable<string>, visible: any[]): Set<string> => {
  const onScreen = new Set(visible.map((p) => p?.id));
  const kept = new Set<string>();
  for (const id of selected) if (onScreen.has(id)) kept.add(id);
  return kept;
};

const titleOf = (p: any) => String(p?.title || p?.topic || '');
const createdAt = (p: any) => new Date(p?.createdAt || p?.created_at || 0).getTime();
const statusOf = (p: any) => String(p?.status || 'unknown');

/** `generating_assets` -> `Generating assets`. */
export const statusLabel = (status: string): string =>
  status ? status.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Unknown';

/**
 * The statuses actually present in the list, most common first, with counts.
 *
 * Derived from the data rather than hard-coded against the Project['status'] union:
 * that union already ends in `| string`, the pipeline writes a stage name per stage,
 * and a hard-coded list would quietly stop offering any status added later. This way
 * the dropdown also never offers an option that would return nothing.
 */
export const statusOptions = (projects: any[]): { value: string; label: string; count: number }[] => {
  const counts = new Map<string, number>();
  for (const p of projects || []) counts.set(statusOf(p), (counts.get(statusOf(p)) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, count, label: statusLabel(value) }));
};

/**
 * Search and status compose as AND, then sort. `status: 'all'` (the default) is the
 * list unchanged, which is what the dashboard shows on a first visit.
 */
export const filterProjects = (
  projects: any[],
  opts: { query?: string; status?: string; sortBy?: ProjectSort } = {},
): any[] => {
  const query = (opts.query || '').toLowerCase().trim();
  const status = opts.status || ALL_STATUSES;
  const sortBy = opts.sortBy || 'latest';

  return (projects || [])
    .filter((p) => status === ALL_STATUSES || statusOf(p) === status)
    .filter((p) =>
      !query
      || titleOf(p).toLowerCase().includes(query)
      || statusOf(p).toLowerCase().includes(query))
    .sort((a, b) => {
      if (sortBy === 'oldest') return createdAt(a) - createdAt(b);
      if (sortBy === 'name') return titleOf(a).localeCompare(titleOf(b));
      return createdAt(b) - createdAt(a); // latest
    });
};
