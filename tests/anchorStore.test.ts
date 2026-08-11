import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { anchorKey, seedAnchorsFromProject, recordAnchor, anchorSummary } from '../src/pipeline/anchorStore.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('recordAnchor', () => {
  it('writes to both the in-run map and the persisted project record', () => {
    const project: any = { project_id: 'proj1' };
    const anchors = new Map<string, string>();
    recordAnchor(project, anchors, 'VEER', 'https://supabase.example/anchors/veer.png');
    expect(anchors.get(anchorKey('VEER', 'proj1'))).toBe('https://supabase.example/anchors/veer.png');
    expect(project.character_anchors.VEER).toBe('https://supabase.example/anchors/veer.png');
  });
});

describe('seedAnchorsFromProject', () => {
  it('restores http anchors from a previous run (cross-request consistency)', () => {
    const project: any = {
      project_id: 'proj1',
      character_anchors: { VEER: 'https://supabase.example/anchors/veer.png' },
    };
    const anchors = new Map<string, string>();
    seedAnchorsFromProject(project, anchors);
    expect(anchors.get(anchorKey('VEER', 'proj1'))).toBe('https://supabase.example/anchors/veer.png');
  });

  it('keeps local anchors whose file still exists, drops ones whose file is gone', () => {
    const liveFile = path.join(dir, 'nova_anchor.png');
    fs.writeFileSync(liveFile, 'x');
    const project: any = {
      project_id: 'proj1',
      character_anchors: {
        NOVA: liveFile,
        BYTE: path.join(dir, 'wiped_anchor.png'),
      },
    };
    const anchors = new Map<string, string>();
    seedAnchorsFromProject(project, anchors);
    expect(anchors.get(anchorKey('NOVA', 'proj1'))).toBe(liveFile);
    expect(anchors.has(anchorKey('BYTE', 'proj1'))).toBe(false);
    // Stale entry removed from the persisted record too
    expect(project.character_anchors.BYTE).toBeUndefined();
  });

  it('is a no-op when the project has no saved anchors', () => {
    const anchors = new Map<string, string>();
    seedAnchorsFromProject({ project_id: 'proj1' }, anchors);
    expect(anchors.size).toBe(0);
  });
});

describe('anchorSummary', () => {
  it('reports none established for an empty map', () => {
    expect(anchorSummary(new Map())).toBe('none established');
  });

  it('lists character names with anchor tails', () => {
    const anchors = new Map([[anchorKey('VEER', 'p1'), 'https://x.example/a/veer.png']]);
    expect(anchorSummary(anchors)).toContain('VEER');
    expect(anchorSummary(anchors)).toContain('veer.png');
  });
});
