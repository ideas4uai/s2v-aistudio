import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * A scheduled publish must go to the channel the project was tagged for.
 *
 * This is the one upload path with nobody watching, so it is also the one where
 * resolving to "whatever was published last" does the most damage: an AI QA Engineer
 * episode lands on a personal channel overnight and is public before anyone looks.
 * The interactive route already resolves tag-before-last-used; this pins that the
 * scheduler does the same, which it did not when uploadVideo grew a channel argument.
 *
 * The runner's heavy neighbours (the projects route, the orchestrator) are mocked away
 * rather than imported — nothing here needs them, and loading them pulls in the
 * Python-spawning half of the pipeline.
 */

const uploadVideo = vi.fn(async () => ({
  videoId: 'vid1', url: 'https://youtu.be/vid1', privacyStatus: 'unlisted', title: 't',
}));

vi.mock('../src/server/services/youtubeService.js', () => ({
  uploadVideo,
  buildMetadata: () => ({ title: 't', description: 'd', tags: [] }),
}));
const loadProject = vi.fn(async () => ({}) as any);

vi.mock('../src/server/routes/projects.js', () => ({ resolveOutputFile: (p: string) => p }));
vi.mock('../src/pipeline/orchestrator.js', () => ({
  loadProject,
  patchProject: async () => true,
  runPipeline: async () => ({}),
}));

const { runJob } = await import('../src/server/services/scheduleRunner.js');
const { addChannel, setLastUsed } = await import('../src/server/services/channelStore.js');

let dir: string;
let video: string;
const ORIGINAL = { token: process.env.YOUTUBE_TOKEN_PATH, analytics: process.env.ANALYTICS_PATH };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-chan-'));
  process.env.YOUTUBE_TOKEN_PATH = path.join(dir, 'youtube-tokens.json');
  process.env.ANALYTICS_PATH = path.join(dir, 'events.jsonl');
  video = path.join(dir, 'v.mp4');
  fs.writeFileSync(video, 'mp4');
  uploadVideo.mockClear();
  loadProject.mockReset();

  addChannel({ channelId: 'UC-aiqa', title: 'AIQAEngineer', refreshToken: 'rt1' });
  addChannel({ channelId: 'UC-learn', title: 'Learn AI with B', refreshToken: 'rt2' });
  setLastUsed('UC-learn'); // the channel the operator published to by hand most recently
});

afterEach(() => {
  for (const [k, v] of [['YOUTUBE_TOKEN_PATH', ORIGINAL.token], ['ANALYTICS_PATH', ORIGINAL.analytics]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const job = (over: any = {}) => ({
  id: 'j1', projectId: 'p1', action: 'publish', status: 'pending',
  runAt: new Date().toISOString(), privacyStatus: 'unlisted',
  approvedAt: new Date().toISOString(), ...over,
}) as any;

const project = (over: any = {}) => ({
  project_id: 'p1', status: 'completed', output_path: video,
  quality_gate: { passed: true, score: 100, failures: [] }, ...over,
});

/** The channel id handed to uploadVideo, or undefined if it was never called. */
const targeted = () => uploadVideo.mock.calls[0]?.[3];

describe('which channel a scheduled publish targets', () => {
  it('honours the project tag over the channel published to last', async () => {
    loadProject.mockResolvedValue(project({ channel_id: 'UC-aiqa' }));

    await runJob(job());
    expect(uploadVideo).toHaveBeenCalledTimes(1);
    expect(targeted()).toBe('UC-aiqa');
    expect(targeted()).not.toBe('UC-learn');
  });

  it('falls back to last-used only when the project carries no tag', async () => {
    loadProject.mockResolvedValue(project());

    await runJob(job());
    expect(targeted()).toBe('UC-learn');
  });

  it('never resolves to nothing — an explicit channel id always reaches the upload', async () => {
    loadProject.mockResolvedValue(project({ channel_id: 'UC-aiqa' }));

    await runJob(job());
    // The regression this file exists for: the argument was simply absent, and
    // uploadVideo quietly fell back to last-used on its own.
    expect(targeted()).toBeTruthy();
  });
});
