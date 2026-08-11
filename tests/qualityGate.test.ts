import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runQualityGate } from '../src/services/qualityService.js';

// The gate replaced a score of `50 + 20 + 30` that checked almost nothing. These
// cover each check's failure mode, because a gate that only ever passes is worse
// than no gate: it launders a broken video as verified.

let dir: string;

/** A 16-bit PCM WAV with real (non-silent) samples. */
function audibleWav(name: string): string {
  const samples = 8000;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples * 2, 4);
  header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(samples * 2, 40);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(8000 * Math.sin(i / 8)), i * 2);
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.concat([header, data]));
  return p;
}

/** Same shape, all-zero samples — the failure that ships a mute video. */
function silentWav(name: string): string {
  const p = audibleWav(name);
  const buf = fs.readFileSync(p);
  buf.fill(0, 44);
  fs.writeFileSync(p, buf);
  return p;
}

function blob(name: string, bytes = 5000): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

/** A project where every check passes. */
function goodProject(n = 2): any {
  return {
    project_id: 'p1',
    scenes: Array.from({ length: n }, (_, i) => ({
      scene_id: `scene-${i}`,
      order: i,
      status: 'completed',
      character: 'NARRATOR',
      segment_path: blob(`seg${i}.mp4`),
      narration_path: audibleWav(`narr${i}.wav`),
      visuals: [{ visual_id: `v${i}`, rendered_path: blob(`vis${i}.mp4`) }],
    })),
  };
}

const check = (r: any, id: string) => r.checks.find((c: any) => c.id === id);

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('quality gate — passing case', () => {
  it('passes a fully rendered project', async () => {
    const r = await runQualityGate(goodProject());
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.score).toBe(100);
  });

  it('reports character consistency as NOT CHECKED for a narrator project', async () => {
    const r = await runQualityGate(goodProject());
    // Skipped, never silently counted as a pass.
    expect(check(r, 'character_consistency').status).toBe('skipped');
  });

  it('does not let a skipped check drag the score down', async () => {
    const r = await runQualityGate(goodProject());
    expect(r.score).toBe(100);
  });
});

describe('quality gate — failure cases', () => {
  it('catches a scene that produced no video segment', async () => {
    const p = goodProject();
    p.scenes[1].segment_path = path.join(dir, 'missing.mp4');
    const r = await runQualityGate(p);
    expect(r.passed).toBe(false);
    expect(check(r, 'scene_count').status).toBe('fail');
    expect(check(r, 'scene_count').detail).toContain('Scene 2');
  });

  it('catches a failed scene and names it with its reason', async () => {
    const p = goodProject();
    p.scenes[0].status = 'failed';
    p.scenes[0].error_log = 'No image was generated for this scene';
    const r = await runQualityGate(p);
    expect(r.passed).toBe(false);
    const c = check(r, 'no_failed_scenes');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('Scene 1');
    expect(c.detail).toContain('No image was generated');
  });

  it('catches a degraded scene', async () => {
    const p = goodProject();
    p.scenes[1].status = 'degraded';
    const r = await runQualityGate(p);
    expect(check(r, 'no_failed_scenes').status).toBe('fail');
  });

  it('catches missing narration audio', async () => {
    const p = goodProject();
    p.scenes[0].narration_path = undefined;
    const r = await runQualityGate(p);
    expect(r.passed).toBe(false);
    expect(check(r, 'audio_present').detail).toContain('Scene 1 has no narration audio');
  });

  it('catches narration that exists but is silent', async () => {
    const p = goodProject();
    p.scenes[1].narration_path = silentWav('mute.wav');
    const r = await runQualityGate(p);
    expect(r.passed).toBe(false);
    expect(check(r, 'audio_present').detail).toContain('Scene 2 narration is silent');
  });

  it('catches a scene with no visual', async () => {
    const p = goodProject();
    p.scenes[0].visuals = [{ visual_id: 'v0' }];
    const r = await runQualityGate(p);
    expect(r.passed).toBe(false);
    expect(check(r, 'visual_present').detail).toContain('Scene 1');
  });

  it('fails a project with no scenes at all', async () => {
    const r = await runQualityGate({ project_id: 'x', scenes: [] } as any);
    expect(r.passed).toBe(false);
  });

  it('fails when there is no project', async () => {
    const r = await runQualityGate(undefined);
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
  });

  it('reports every failure, not just the first', async () => {
    const p = goodProject();
    p.scenes[0].status = 'failed';
    p.scenes[1].narration_path = silentWav('mute2.wav');
    const r = await runQualityGate(p);
    expect(r.failures.length).toBeGreaterThanOrEqual(2);
    expect(r.score).toBeLessThan(100);
  });
});
