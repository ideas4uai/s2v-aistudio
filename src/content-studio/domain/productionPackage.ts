import { v4 as uuidv4 } from 'uuid';
import {
  PRODUCTION_PACKAGE_SCHEMA_VERSION,
  type ProductionPackage,
  type StudioEpisode,
  type WorkflowStageName,
  type WorkflowStageState,
} from './types.js';

export const WORKFLOW_STAGES: WorkflowStageName[] = ['idea', 'story', 'package', 'handoff'];

export function createWorkflowState(): WorkflowStageState[] {
  return WORKFLOW_STAGES.map((stage) => ({ stage, status: 'pending', attempts: 0 }));
}

export function createProductionPackage(episodeId: string, ownerId: string, title: string): ProductionPackage {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    schemaVersion: PRODUCTION_PACKAGE_SCHEMA_VERSION,
    episodeId,
    ownerId,
    status: 'draft',
    story: { title, hook: '', hookVariations: [] },
    scenes: [],
    voice: {}, subtitles: {}, music: {}, thumbnail: {},
    captions: { hashtags: [], keywords: [] },
    assets: [], qualityScores: {}, render: {}, extension: {},
    createdAt: now, updatedAt: now,
  };
}

export function createStudioEpisode(userId: string, title: string, topic: string, characterIds: string[] = []): StudioEpisode {
  const now = new Date().toISOString();
  const id = uuidv4();
  return {
    id, userId, title, topic, characterIds,
    status: 'draft',
    // The caller replaces this with the package id before persistence.
    productionPackageId: '',
    workflow: createWorkflowState(),
    createdAt: now, updatedAt: now,
  };
}

export function validateProductionPackage(value: unknown): string[] {
  if (!value || typeof value !== 'object') return ['A production package object is required.'];
  const packageValue = value as Partial<ProductionPackage>;
  const errors: string[] = [];
  if (packageValue.schemaVersion !== PRODUCTION_PACKAGE_SCHEMA_VERSION) errors.push('Unsupported production package schema version.');
  if (!packageValue.id || !packageValue.episodeId || !packageValue.ownerId) errors.push('Package id, episode id, and owner id are required.');
  if (!packageValue.story?.title) errors.push('A story title is required.');
  if (!Array.isArray(packageValue.scenes)) errors.push('Scenes must be an array.');
  if (!Array.isArray(packageValue.captions?.hashtags) || !Array.isArray(packageValue.captions?.keywords)) errors.push('Captions must include hashtags and keywords arrays.');
  if (Array.isArray(packageValue.scenes)) {
    const ids = new Set<string>();
    for (const scene of packageValue.scenes) {
      if (!scene.id || ids.has(scene.id)) errors.push('Every scene needs a unique id.');
      ids.add(scene.id);
      if (!Array.isArray(scene.dialogue)) errors.push(`Scene ${scene.id || 'unknown'} must include dialogue as an array.`);
    }
  }
  return errors;
}
