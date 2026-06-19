/**
 * Repro test for "scenes empty on GET immediately after generateScenes" bug.
 *
 * Root cause: saveProjectState with DISABLE_FIRESTORE=true returned early without
 * writing to any persistent store. loadProject / GET route then read stale Firestore
 * data (project from creation, scenes: []).
 *
 * Fix: saveProjectState now writes to a module-level Map<string,Project>.
 *      loadProject checks that Map first before hitting Firestore.
 *      GET /:id route uses loadProject() instead of FirestoreService.getProject().
 *
 * Run: npx tsx scripts/test_memory_store.ts
 */

// Set env BEFORE importing anything that reads it at module load time
process.env.DISABLE_FIRESTORE = 'true';

import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import { loadProject, saveProjectState } from '../src/pipeline/orchestrator.js';
import type { Project } from '../src/models/project.js';

let passed = 0;
let failed = 0;

function ok(label: string) { console.log(`  ✓ ${label}`); passed++; }
function fail(label: string) { console.error(`  ✗ ${label}`); failed++; }

function makeProject(overrides: Partial<Project> = {}): Project {
  const id = uuidv4();
  return {
    project_id: id,
    userId: 'test-user',
    topic: 'Test Video Topic',
    title: 'Test Video Topic',
    script: 'This is the generated script for the test project.',
    status: 'draft',
    mode: 'long',
    style_profile: 'cinematic',
    pacing_intensity: 'moderate',
    hook_strategy: 'default',
    scenes: [],
    settings: {},
    error_log: null,
    ...overrides,
  } as unknown as Project;
}

function makeScenes(projectId: string, count: number): any[] {
  return Array.from({ length: count }, (_, i) => ({
    scene_id: uuidv4(),
    projectId,
    order: i,
    narration_text: `Scene ${i + 1} narration text about the topic.`,
    caption_text: `Scene ${i + 1} caption.`,
    duration_target: 5,
    status: 'pending',
    stage: 'audio',
    visuals: [{ visual_id: uuidv4(), prompt: `visual for scene ${i + 1}`, asset_type: 'ai_image', status: 'pending' }],
  }));
}

// ── Phase 1: prove DISABLE_FIRESTORE write+read cycle ─────────────────────────

async function phase1_WriteReadCycle() {
  console.log('\n══ Phase 1: saveProjectState → loadProject round-trip ══');
  console.log('  (simulates: generateScenes writes → GET reads)');

  const project = makeProject();
  const id = project.project_id!;
  const SCENE_COUNT = 7;

  // Step A: simulate what generateScenes does — add scenes and call saveProjectState
  project.scenes = makeScenes(id, SCENE_COUNT) as any;
  project.status = 'draft';
  project.script = 'Generated script: the topic is interesting and has multiple angles.';

  console.log(`\n  [generateScenes] project.scenes.length = ${project.scenes.length}`);
  await saveProjectState(project);
  // Expected new log: "[DB] DISABLE_FIRESTORE=true — wrote to in-memory store (key: ..., scenes: 7)"

  // Step B: simulate what the GET route does — call loadProject
  console.log(`\n  [GET /:id] calling loadProject('${id}')`);
  let loaded: Project;
  try {
    loaded = await loadProject(id);
    // Expected new log: "[DB] Loaded project ... from in-memory store (scenes: 7)"
  } catch (e: any) {
    fail(`loadProject threw: ${e.message}`);
    return;
  }

  const loadedSceneCount = loaded.scenes?.length ?? 0;
  console.log(`  [GET /:id] loaded.scenes.length = ${loadedSceneCount}`);

  if (loadedSceneCount === SCENE_COUNT) {
    ok(`scenes count matches: ${loadedSceneCount} === ${SCENE_COUNT}`);
  } else {
    fail(`scenes count mismatch: got ${loadedSceneCount}, expected ${SCENE_COUNT}`);
  }

  if (loaded.script && loaded.script.length > 10) {
    ok(`script is non-empty (${loaded.script.length} chars)`);
  } else {
    fail(`script is empty or missing (got: '${loaded.script}')`);
  }

  if (loaded.project_id === id) {
    ok('project_id matches — same in-memory instance retrieved');
  } else {
    fail(`project_id mismatch: got '${loaded.project_id}', expected '${id}'`);
  }
}

// ── Phase 2: second saveProjectState updates the same store entry ─────────────

async function phase2_UpdateInStore() {
  console.log('\n══ Phase 2: second save overwrites — orchestrator mid-run updates visible ══');

  const project = makeProject();
  const id = project.project_id!;

  // Initial save with 3 scenes (partial write during pipeline)
  project.scenes = makeScenes(id, 3) as any;
  project.status = 'processing';
  await saveProjectState(project);

  let loaded = await loadProject(id);
  if ((loaded.scenes?.length ?? 0) === 3) {
    ok('interim state: 3 scenes visible in store');
  } else {
    fail(`interim state: expected 3 scenes, got ${loaded.scenes?.length ?? 0}`);
  }

  // Second save with 7 scenes (pipeline completion)
  project.scenes = makeScenes(id, 7) as any;
  project.status = 'draft';
  await saveProjectState(project);

  loaded = await loadProject(id);
  if ((loaded.scenes?.length ?? 0) === 7) {
    ok('final state: 7 scenes visible after second save');
  } else {
    fail(`final state: expected 7 scenes, got ${loaded.scenes?.length ?? 0}`);
  }
}

// ── Phase 3: different project IDs don't collide ──────────────────────────────

async function phase3_Isolation() {
  console.log('\n══ Phase 3: two different projects stored and read independently ══');

  const projA = makeProject();
  const projB = makeProject();

  projA.scenes = makeScenes(projA.project_id!, 3) as any;
  projB.scenes = makeScenes(projB.project_id!, 9) as any;

  await saveProjectState(projA);
  await saveProjectState(projB);

  const loadedA = await loadProject(projA.project_id!);
  const loadedB = await loadProject(projB.project_id!);

  if ((loadedA.scenes?.length ?? 0) === 3 && (loadedB.scenes?.length ?? 0) === 9) {
    ok('projects A (3 scenes) and B (9 scenes) stored and retrieved independently');
  } else {
    fail(`isolation failure: A=${loadedA.scenes?.length}, B=${loadedB.scenes?.length}`);
  }
}

// ── Phase 4: module-level Map is a true singleton ─────────────────────────────

async function phase4_Singleton() {
  console.log('\n══ Phase 4: Map is a true singleton (module-level, not per-request) ══');
  console.log('  (re-importing orchestrator should return the same module instance)');

  // Dynamic import returns the cached module — same Map reference as above
  const { saveProjectState: save2, loadProject: load2 } = await import('../src/pipeline/orchestrator.js');

  const project = makeProject();
  const id = project.project_id!;
  project.scenes = makeScenes(id, 5) as any;

  // Write via second import reference
  await save2(project);
  // Read via original import reference
  const loaded = await loadProject(id);

  if ((loaded.scenes?.length ?? 0) === 5) {
    ok('same Map instance used across import references — true singleton confirmed');
  } else {
    fail(`singleton test failed: expected 5 scenes, got ${loaded.scenes?.length ?? 0}`);
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('In-Memory Store Repro Test (DISABLE_FIRESTORE=true)');
  console.log('═'.repeat(55));
  console.log(`DISABLE_FIRESTORE: ${process.env.DISABLE_FIRESTORE}`);

  await phase1_WriteReadCycle();
  await phase2_UpdateInStore();
  await phase3_Isolation();
  await phase4_Singleton();

  console.log('\n' + '═'.repeat(55));
  console.log(`PASSED: ${passed}   FAILED: ${failed}`);

  if (failed > 0) {
    console.error('\n❌ TESTS FAILED');
    process.exit(1);
  } else {
    console.log('\n✅ ALL TESTS PASSED');
    console.log('\nProven: saveProjectState → in-memory Map → loadProject round-trip is correct.');
    console.log('GET /:id (via loadProject) now returns scenes: [7] immediately after generateScenes.');
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
