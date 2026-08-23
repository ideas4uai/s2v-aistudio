import { describe, it, expect } from 'vitest';
import {
  filterProjects, statusOptions, statusLabel, ALL_STATUSES,
} from '../src/utils/projectFilter';

/**
 * Shaped like the array GET /api/projects actually returns: the route merges local-disk
 * and Firestore records into one list, so both sources arrive here identically and a
 * filter written against this shape cannot favour either. The `source` field is only
 * here so the tests can assert that.
 */
const projects = [
  { id: 'a', project_id: 'a', title: 'Nexus City',   status: 'completed',         createdAt: '2026-08-01', source: 'local' },
  { id: 'b',                  title: 'Freshworks',   status: 'completed',         createdAt: '2026-08-05', source: 'firestore' },
  { id: 'c', project_id: 'c', title: 'Broken run',   status: 'failed',            createdAt: '2026-08-03', source: 'local' },
  { id: 'd',                  title: 'Half a video', status: 'degraded',          createdAt: '2026-08-02', source: 'firestore' },
  { id: 'e', project_id: 'e', title: 'Assets',       status: 'generating_assets', createdAt: '2026-08-04', source: 'local' },
  { id: 'f',                  title: 'Sketch',       status: 'draft',             createdAt: '2026-08-06', source: 'firestore' },
];

describe('statusOptions', () => {
  it('offers exactly the statuses present, most common first', () => {
    expect(statusOptions(projects)).toEqual([
      { value: 'completed',         label: 'Completed',         count: 2 },
      { value: 'degraded',          label: 'Degraded',          count: 1 },
      { value: 'draft',             label: 'Draft',             count: 1 },
      { value: 'failed',            label: 'Failed',            count: 1 },
      { value: 'generating_assets', label: 'Generating assets', count: 1 },
    ]);
  });

  it('never offers an option that would return nothing', () => {
    for (const o of statusOptions(projects)) {
      expect(filterProjects(projects, { status: o.value })).toHaveLength(o.count);
    }
  });

  it('counts a missing status rather than dropping the project', () => {
    expect(statusOptions([{ id: 'x' }])).toEqual([{ value: 'unknown', label: 'Unknown', count: 1 }]);
  });

  it('reads a stage name the union does not list', () => {
    // Project['status'] ends in `| string` and the pipeline writes a name per stage.
    expect(statusOptions([{ status: 'stitching_video' }])[0].label).toBe('Stitching video');
  });
});

describe('filterProjects', () => {
  it('shows everything by default', () => {
    expect(filterProjects(projects)).toHaveLength(projects.length);
    expect(filterProjects(projects, { status: ALL_STATUSES })).toHaveLength(projects.length);
  });

  it('filters local and Firestore records alike', () => {
    const done = filterProjects(projects, { status: 'completed' });
    expect(done.map(p => p.id).sort()).toEqual(['a', 'b']);
    // The bug worth guarding: a filter that only reached one of the two sources.
    expect(new Set(done.map(p => p.source))).toEqual(new Set(['local', 'firestore']));
  });

  it('composes search and status as AND', () => {
    expect(filterProjects(projects, { status: 'completed', query: 'nexus' }).map(p => p.id)).toEqual(['a']);
    expect(filterProjects(projects, { status: 'failed', query: 'nexus' })).toEqual([]);
  });

  it('sorts within the filtered set, not the whole list', () => {
    expect(filterProjects(projects, { status: 'completed', sortBy: 'latest' }).map(p => p.id)).toEqual(['b', 'a']);
    expect(filterProjects(projects, { status: 'completed', sortBy: 'oldest' }).map(p => p.id)).toEqual(['a', 'b']);
    expect(filterProjects(projects, { status: 'completed', sortBy: 'name' }).map(p => p.id)).toEqual(['b', 'a']);
  });

  it('keeps the old search behaviour, including matching on status text', () => {
    expect(filterProjects(projects, { query: 'fail' }).map(p => p.id)).toEqual(['c']);
    expect(filterProjects(projects, { query: '  NEXUS ' }).map(p => p.id)).toEqual(['a']);
  });

  it('does not mutate the array it was given', () => {
    const order = projects.map(p => p.id);
    filterProjects(projects, { sortBy: 'name' });
    expect(projects.map(p => p.id)).toEqual(order);
  });

  it('survives an empty or absent list', () => {
    expect(filterProjects([], { status: 'completed' })).toEqual([]);
    expect(filterProjects(undefined as any)).toEqual([]);
  });
});

describe('statusLabel', () => {
  it('reads as a label, not a key', () => {
    expect(statusLabel('hook_selection')).toBe('Hook selection');
    expect(statusLabel('')).toBe('Unknown');
  });
});
