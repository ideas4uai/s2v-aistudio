import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logEvent, readEvents, queryEvents, summarise, estimateCostUsd } from '../src/services/logService.js';

// logService was a stub: logUserEvent was an empty function body, so the two orchestrator
// call sites had been reporting into nothing since they were written. These tests pin the
// parts that are easy to get quietly wrong — a summary that divides by zero, a torn line
// from a crash taking the whole file down, and cost being billed for reused work.

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-test-'));
  file = path.join(dir, 'events.jsonl');
  process.env.ANALYTICS_PATH = file;
});

afterEach(() => {
  delete process.env.ANALYTICS_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('logEvent', () => {
  it('appends one JSON object per line', () => {
    logEvent('render_started', 'p1');
    logEvent('render_completed', 'p1', { durationSec: 12 });
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).durationSec).toBe(12);
  });

  it('stamps a parseable time and keeps the project id', () => {
    logEvent('render_started', 'p1');
    const [e] = readEvents(file);
    expect(Number.isNaN(Date.parse(e.at))).toBe(false);
    expect(e.projectId).toBe('p1');
  });

  it('never throws when the log cannot be written', () => {
    // Analytics is an observer. A render must not fail because a disk is full or a
    // path is bad — recording that something happened cannot be able to stop it.
    process.env.ANALYTICS_PATH = path.join(dir, 'events.jsonl', 'nested', 'impossible.jsonl');
    expect(() => logEvent('render_started', 'p1')).not.toThrow();
  });

  it('survives a torn final line from a crash mid-append', () => {
    logEvent('render_started', 'p1');
    fs.appendFileSync(file, '{"at":"2026-01-01T00:00:00Z","type":"render_comp');
    // One unreadable line must not cost the whole history.
    expect(readEvents(file)).toHaveLength(1);
  });

  it('returns nothing rather than throwing before anything is logged', () => {
    expect(readEvents(path.join(dir, 'absent.jsonl'))).toEqual([]);
  });
});

describe('queryEvents', () => {
  beforeEach(() => {
    logEvent('render_started', 'p1');
    logEvent('render_completed', 'p1', { durationSec: 10 });
    logEvent('render_started', 'p2');
    logEvent('render_failed', 'p2', { error: 'boom' });
  });

  it('returns newest first', () => {
    expect(queryEvents({}, file)[0].type).toBe('render_failed');
  });

  it('filters by type and by project independently', () => {
    expect(queryEvents({ type: 'render_started' }, file)).toHaveLength(2);
    expect(queryEvents({ projectId: 'p2' }, file)).toHaveLength(2);
    expect(queryEvents({ type: 'render_started', projectId: 'p2' }, file)).toHaveLength(1);
  });

  it('honours limit', () => {
    expect(queryEvents({ limit: 2 }, file)).toHaveLength(2);
  });

  it('ignores an unparseable since rather than returning nothing', () => {
    expect(queryEvents({ since: 'not-a-date' }, file)).toHaveLength(4);
  });
});

describe('summarise', () => {
  it('reports nulls, not NaN, when nothing has happened yet', () => {
    // successRate as 0/0 is the classic empty-dashboard bug.
    const s = summarise(file);
    expect(s.totalEvents).toBe(0);
    expect(s.renders.successRate).toBeNull();
    expect(s.renders.medianDurationSec).toBeNull();
    expect(s.qualityGate.averageScore).toBeNull();
  });

  it('computes the success rate over finished renders only', () => {
    logEvent('render_started', 'p1');
    logEvent('render_started', 'p2');
    logEvent('render_started', 'p3');
    logEvent('render_completed', 'p1', { durationSec: 10 });
    logEvent('render_completed', 'p2', { durationSec: 20 });
    logEvent('render_failed', 'p3', { error: 'boom' });
    const s = summarise(file);
    // A render still in flight must not count as a failure.
    expect(s.renders.successRate).toBeCloseTo(2 / 3, 3);
  });

  it('uses the median duration, so one cold render does not define "typical"', () => {
    for (const d of [8, 9, 10, 11, 900]) logEvent('render_completed', 'p', { durationSec: d });
    const s = summarise(file);
    expect(s.renders.medianDurationSec).toBe(10);   // mean would be 187.6
    expect(s.renders.totalDurationSec).toBe(938);
  });

  it('averages quality scores and counts pass/fail separately', () => {
    logEvent('quality_gate', 'p1', { passed: true, score: 100 });
    logEvent('quality_gate', 'p2', { passed: false, score: 40 });
    const s = summarise(file);
    expect(s.qualityGate).toMatchObject({ passed: 1, failed: 1, averageScore: 70 });
  });

  it('bills only images this render actually generated', () => {
    // The whole point of the before/after delta: a fully cached re-render is free, and
    // a cost report that charged for reused work would be confidently wrong.
    logEvent('render_completed', 'p1', { durationSec: 5, imagesGenerated: 0 });
    logEvent('render_completed', 'p2', { durationSec: 900, imagesGenerated: 5 });
    const s = summarise(file);
    expect(s.cost.imagesGenerated).toBe(5);
    expect(s.cost.estimatedUsd).toBeCloseTo(estimateCostUsd(5), 4);
  });

  it('counts cloud backup and publish outcomes', () => {
    logEvent('cloud_backup_uploaded', 'p1', { sizeBytes: 1 });
    logEvent('cloud_backup_failed', 'p2', { error: 'no bucket' });
    logEvent('publish_uploaded', 'p1', { videoId: 'abc' });
    const s = summarise(file);
    expect(s.cloudBackup).toEqual({ uploaded: 1, failed: 1 });
    expect(s.publish).toEqual({ uploaded: 1, failed: 0 });
  });
});
