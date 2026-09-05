import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  logEvent, logTextUsage, projectUsage, withProjectScope, currentProjectId, queryEvents,
} from '../src/services/logService.js';

/**
 * What a video actually consumed.
 *
 * quotaService was a stub — checkQuota returned true, consumeQuota did nothing, and its
 * one caller incremented a counter written nowhere. Text generation reported nothing at
 * all. So "what did this video cost" had no answer, which is the question a price has to
 * be built on.
 *
 * Measurement only. Enforcement needs a policy that does not exist yet, and setting
 * limits before measuring is how you pick the wrong ones.
 */

let file: string;

beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-')), 'events.jsonl');
  process.env.ANALYTICS_PATH = file;
});
afterEach(() => {
  delete process.env.ANALYTICS_PATH;
  try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch { /* gone */ }
});

describe('attributing work to a project', () => {
  it('tags nested calls without threading a projectId through the agents', () => {
    // Text generation happens four levels below the orchestrator, inside agents that
    // take a brief. The async scope is what keeps analytics out of the craft code.
    expect(currentProjectId()).toBeUndefined();
    withProjectScope('proj-1', () => {
      expect(currentProjectId()).toBe('proj-1');
      logTextUsage({ task: 'script', model: 'm', promptChars: 10, responseChars: 20, usage: { totalTokenCount: 99 } });
    });
    expect(currentProjectId()).toBeUndefined();

    const [event] = queryEvents({ type: 'ai_text' }, file);
    expect(event.projectId).toBe('proj-1');
    expect(event.totalTokens).toBe(99);
  });

  it('records characters even when the provider reports no tokens', () => {
    // usageMetadata is absent on some responses. A proxy that is always there beats a
    // precise number with holes in the series.
    withProjectScope('proj-2', () => {
      logTextUsage({ task: 'scenes', model: 'm', promptChars: 500, responseChars: 900, usage: null });
    });
    const usage = projectUsage('proj-2', file);
    expect(usage.textCalls).toBe(1);
    expect(usage.promptChars).toBe(500);
    // Null, not zero: zero would read as "this call was free".
    expect(usage.totalTokens).toBeNull();
  });
});

describe('per-project rollup', () => {
  it('adds up renders, images, audio and tokens for one project only', () => {
    withProjectScope('mine', () => {
      logTextUsage({ task: 'script', model: 'm', promptChars: 100, responseChars: 200, usage: { totalTokenCount: 40 } });
      logTextUsage({ task: 'scenes', model: 'm', promptChars: 50, responseChars: 80, usage: { totalTokenCount: 60 } });
      logEvent('tts_generated', 'mine', { count: 1 });
    });
    logEvent('render_completed', 'mine', { durationSec: 120.5, imagesGenerated: 6 });
    // Another project's spend must not land in this one's bill.
    logEvent('render_completed', 'theirs', { durationSec: 900, imagesGenerated: 40 });

    const usage = projectUsage('mine', file);
    expect(usage.renders).toBe(1);
    expect(usage.durationSec).toBe(120.5);
    expect(usage.imagesGenerated).toBe(6);
    expect(usage.audioClips).toBe(1);
    expect(usage.textCalls).toBe(2);
    expect(usage.totalTokens).toBe(100);
    // 6 images at the configured rate; text is free on this tier and says so.
    expect(usage.estimatedUsd.images).toBeGreaterThan(0);
    expect(usage.estimatedUsd.text).toBe(0);
    expect(usage.note).toContain('free tier');
  });

  it('reports an untouched project as zero rather than throwing', () => {
    const usage = projectUsage('never-rendered', file);
    expect(usage.renders).toBe(0);
    expect(usage.estimatedUsd.total).toBe(0);
    expect(usage.totalTokens).toBeNull();
  });

  it('counts a cached re-render as costing nothing', () => {
    // A re-run that regenerates no images spent no money, and the figure must say so.
    logEvent('render_completed', 'cached', { durationSec: 6.3, imagesGenerated: 0 });
    expect(projectUsage('cached', file).estimatedUsd.total).toBe(0);
  });
});
