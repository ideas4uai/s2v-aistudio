import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { StudioStore } from '../../content-studio/store.js';
import { createProductionPackage, createStudioEpisode, validateProductionPackage, WORKFLOW_STAGES } from '../../content-studio/domain/productionPackage.js';
import type { KnowledgeDocument, ProductionPackage, StudioEpisode, WorkflowStageName } from '../../content-studio/domain/types.js';
import { contentStudioWorkflowCoordinator } from '../../content-studio/workflow/workflowCoordinator.js';
// Side-effect import: registers the stage agents with the coordinator's registry.
import '../../content-studio/agents/index.js';

const EPISODES_COLLECTION = 'contentStudioEpisodes';
const PACKAGES_COLLECTION = 'contentStudioProductionPackages';
const KNOWLEDGE_COLLECTION = 'contentStudioKnowledge';
const LOGS_COLLECTION = 'contentStudioAgentLogs';
const KNOWLEDGE_VERSIONS_COLLECTION = 'contentStudioKnowledgeVersions';

export const contentStudioRouter = Router();

function currentUserId(req: any): string | null {
  return req.user?.uid ?? null;
}

function ownedBy(document: any, userId: string): boolean {
  return document?.userId === userId || document?.ownerId === userId;
}

async function getOwnedDocument(collection: string, id: string, userId: string) {
  const document = await StudioStore.get(collection, id);
  return ownedBy(document, userId) ? document : null;
}

function requestedStage(value: unknown): WorkflowStageName | null {
  return typeof value === 'string' && (WORKFLOW_STAGES as string[]).includes(value) ? value as WorkflowStageName : null;
}

contentStudioRouter.get('/dashboard', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const [episodes, knowledge, logs] = await Promise.all([
      StudioStore.list(EPISODES_COLLECTION, userId),
      StudioStore.list(KNOWLEDGE_COLLECTION, userId),
      StudioStore.list(LOGS_COLLECTION, userId),
    ]);
    const ownEpisodes = (episodes as StudioEpisode[]).filter((episode) => episode.userId === userId);
    res.json({
      ideasWaiting: ownEpisodes.filter((episode) => episode.status === 'draft').length,
      episodes: ownEpisodes.length,
      inProduction: ownEpisodes.filter((episode) => ['generating', 'review', 'approved', 'rendering'].includes(episode.status)).length,
      recentlyPublished: ownEpisodes.filter((episode) => episode.status === 'published').slice(0, 5),
      knowledgeDocuments: (knowledge as any[]).filter((document) => document.userId === userId).length,
      agentActivity: (logs as any[])
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
        .slice(0, 10)
        .map(({ stage, status, message, error, createdAt, metrics }) => ({ stage, status, message, error, createdAt, executionMs: metrics?.executionMs })),
      publishingQueue: ownEpisodes.filter((episode) => episode.status === 'approved'),
    });
  } catch (error) {
    console.error('[ContentStudio] dashboard failed', error);
    res.status(500).json({ error: 'Failed to load Content Studio dashboard.' });
  }
});

contentStudioRouter.get('/episodes', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const episodes = await StudioStore.list(EPISODES_COLLECTION, userId);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const result = (episodes as StudioEpisode[])
      .filter((episode) => episode.userId === userId)
      .filter((episode) => !status || episode.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.json(result);
  } catch (error) {
    console.error('[ContentStudio] episode list failed', error);
    res.status(500).json({ error: 'Failed to list episodes.' });
  }
});

contentStudioRouter.post('/episodes', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { title, topic, characterIds } = req.body as { title?: unknown; topic?: unknown; characterIds?: unknown };
  if (typeof title !== 'string' || !title.trim() || typeof topic !== 'string' || !topic.trim()) {
    return res.status(400).json({ error: 'title and topic are required.' });
  }
  if (characterIds !== undefined && (!Array.isArray(characterIds) || characterIds.some((id) => typeof id !== 'string'))) {
    return res.status(400).json({ error: 'characterIds must be an array of strings.' });
  }
  try {
    const episode = createStudioEpisode(userId, title.trim(), topic.trim(), characterIds as string[] | undefined);
    const productionPackage = createProductionPackage(episode.id, userId, episode.title);
    episode.productionPackageId = productionPackage.id;
    await Promise.all([
      StudioStore.save(EPISODES_COLLECTION, episode.id, episode),
      StudioStore.save(PACKAGES_COLLECTION, productionPackage.id, productionPackage),
    ]);
    res.status(201).json({ episode, productionPackage });
  } catch (error) {
    console.error('[ContentStudio] episode creation failed', error);
    res.status(500).json({ error: 'Failed to create episode.' });
  }
});

contentStudioRouter.get('/episodes/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const episode = await getOwnedDocument(EPISODES_COLLECTION, req.params.id, userId) as StudioEpisode | null;
    if (!episode) return res.status(404).json({ error: 'Episode not found.' });
    const productionPackage = await getOwnedDocument(PACKAGES_COLLECTION, episode.productionPackageId, userId);
    res.json({ episode, productionPackage });
  } catch (error) {
    console.error('[ContentStudio] episode fetch failed', error);
    res.status(500).json({ error: 'Failed to load episode.' });
  }
});

contentStudioRouter.patch('/episodes/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const existing = await getOwnedDocument(EPISODES_COLLECTION, req.params.id, userId) as StudioEpisode | null;
    if (!existing) return res.status(404).json({ error: 'Episode not found.' });
    const allowed = ['title', 'topic', 'characterIds', 'status', 'durationSeconds', 'thumbnailUrl', 'videoUrl', 'qualityScores', 'publishedAt'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([key]) => allowed.includes(key)));
    const updated = { ...existing, ...updates, id: existing.id, userId, updatedAt: new Date().toISOString() } as StudioEpisode;
    await StudioStore.save(EPISODES_COLLECTION, updated.id, updated);
    res.json(updated);
  } catch (error) {
    console.error('[ContentStudio] episode update failed', error);
    res.status(500).json({ error: 'Failed to update episode.' });
  }
});

contentStudioRouter.get('/production-packages/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const productionPackage = await getOwnedDocument(PACKAGES_COLLECTION, req.params.id, userId);
  if (!productionPackage) return res.status(404).json({ error: 'Production package not found.' });
  res.json(productionPackage);
});

contentStudioRouter.put('/production-packages/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const existing = await getOwnedDocument(PACKAGES_COLLECTION, req.params.id, userId) as ProductionPackage | null;
    if (!existing) return res.status(404).json({ error: 'Production package not found.' });
    const candidate = { ...req.body, id: existing.id, ownerId: userId, createdAt: existing.createdAt, updatedAt: new Date().toISOString() } as ProductionPackage;
    const validationErrors = validateProductionPackage(candidate);
    if (validationErrors.length) return res.status(422).json({ error: 'Invalid production package.', details: validationErrors });
    await StudioStore.save(PACKAGES_COLLECTION, candidate.id, candidate);
    res.json(candidate);
  } catch (error) {
    console.error('[ContentStudio] package update failed', error);
    res.status(500).json({ error: 'Failed to update production package.' });
  }
});

contentStudioRouter.post('/episodes/:id/workflows', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const episode = await getOwnedDocument(EPISODES_COLLECTION, req.params.id, userId) as StudioEpisode | null;
    if (!episode) return res.status(404).json({ error: 'Episode not found.' });
    const run = await contentStudioWorkflowCoordinator.start(userId, episode);
    // Without this the run id exists only in the response — a page refresh
    // would strand the run with no way to find it again.
    await StudioStore.save(EPISODES_COLLECTION, episode.id, { ...episode, workflowRunId: run.id, status: 'generating' });
    res.status(201).json(run);
  } catch (error) {
    console.error('[ContentStudio] workflow start failed', error);
    res.status(500).json({ error: 'Failed to start workflow.' });
  }
});

contentStudioRouter.get('/workflows/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const run = await contentStudioWorkflowCoordinator.get(userId, req.params.id);
    if (!run) return res.status(404).json({ error: 'Workflow run not found.' });
    const logs = await StudioStore.list(LOGS_COLLECTION, userId);
    res.json({ run, logs: (logs as any[]).filter((log) => log.userId === userId && log.workflowRunId === run.id) });
  } catch (error) {
    console.error('[ContentStudio] workflow fetch failed', error);
    res.status(500).json({ error: 'Failed to load workflow.' });
  }
});

contentStudioRouter.post('/workflows/:id/run-next', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const run = await contentStudioWorkflowCoordinator.runNext(userId, req.params.id);
    res.json(run);
  } catch (error) {
    res.status(422).json({ error: error instanceof Error ? error.message : 'Unable to run workflow stage.' });
  }
});

contentStudioRouter.post('/workflows/:id/:action', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const stage = requestedStage(req.body?.stage);
  if (!stage) return res.status(400).json({ error: 'A valid stage is required.' });
  try {
    const { action } = req.params;
    const run = action === 'retry'
      ? await contentStudioWorkflowCoordinator.retry(userId, req.params.id, stage)
      : action === 'skip'
        ? await contentStudioWorkflowCoordinator.skip(userId, req.params.id, stage)
        : action === 'approve'
          ? await contentStudioWorkflowCoordinator.approve(userId, req.params.id, stage)
          : null;
    if (!run) return res.status(404).json({ error: 'Unknown workflow action.' });
    res.json(run);
  } catch (error) {
    res.status(422).json({ error: error instanceof Error ? error.message : 'Unable to update workflow.' });
  }
});

const KNOWLEDGE_CATEGORIES: KnowledgeDocument['category'][] = [
  'character_bible', 'production_bible', 'brand_bible', 'visual_style', 'office_guide',
  'episode_history', 'running_jokes', 'relationships', 'lessons_learned', 'prompt_template', 'general',
];

function isKnowledgeCategory(value: unknown): value is KnowledgeDocument['category'] {
  return typeof value === 'string' && (KNOWLEDGE_CATEGORIES as string[]).includes(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

async function saveKnowledgeVersion(document: KnowledgeDocument): Promise<void> {
  const id = uuidv4();
  await StudioStore.save(KNOWLEDGE_VERSIONS_COLLECTION, id, {
    id, knowledgeId: document.id, userId: document.userId, version: document.version,
    title: document.title, content: document.content, tags: document.tags, createdAt: new Date().toISOString(),
  });
}

contentStudioRouter.get('/knowledge/export', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const documents = await StudioStore.list(KNOWLEDGE_COLLECTION, userId);
    res.json({ schemaVersion: '1.0.0', exportedAt: new Date().toISOString(), documents: (documents as KnowledgeDocument[]).filter((document) => document.userId === userId) });
  } catch (error) {
    console.error('[ContentStudio] knowledge export failed', error);
    res.status(500).json({ error: 'Failed to export knowledge.' });
  }
});

contentStudioRouter.post('/knowledge/import', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const input = req.body?.documents;
  if (!Array.isArray(input)) return res.status(400).json({ error: 'documents must be an array.' });
  try {
    const now = new Date().toISOString();
    const documents: KnowledgeDocument[] = input
      .filter((document) => document && typeof document.title === 'string' && typeof document.content === 'string')
      .map((document) => ({
        id: uuidv4(), userId, title: document.title.trim(), content: document.content,
        category: isKnowledgeCategory(document.category) ? document.category : 'general',
        tags: stringArray(document.tags), relatedDocumentIds: [], version: 1, createdAt: now, updatedAt: now,
      }));
    await Promise.all(documents.map((document) => StudioStore.save(KNOWLEDGE_COLLECTION, document.id, document)));
    res.status(201).json({ imported: documents.length, documents });
  } catch (error) {
    console.error('[ContentStudio] knowledge import failed', error);
    res.status(500).json({ error: 'Failed to import knowledge.' });
  }
});

contentStudioRouter.get('/knowledge', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const category = isKnowledgeCategory(req.query.category) ? req.query.category : undefined;
    const search = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const documents = (await StudioStore.list(KNOWLEDGE_COLLECTION, userId) as KnowledgeDocument[])
      .filter((document) => document.userId === userId)
      .filter((document) => !category || document.category === category)
      .filter((document) => !search || `${document.title} ${document.content} ${document.tags.join(' ')}`.toLowerCase().includes(search))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.json(documents);
  } catch (error) {
    console.error('[ContentStudio] knowledge list failed', error);
    res.status(500).json({ error: 'Failed to list knowledge.' });
  }
});

contentStudioRouter.post('/knowledge', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { title, content, category = 'general' } = req.body ?? {};
  if (typeof title !== 'string' || !title.trim() || typeof content !== 'string' || !isKnowledgeCategory(category)) {
    return res.status(400).json({ error: 'title, content, and a valid category are required.' });
  }
  try {
    const now = new Date().toISOString();
    const document: KnowledgeDocument = { id: uuidv4(), userId, title: title.trim(), content, category, tags: stringArray(req.body.tags), relatedDocumentIds: stringArray(req.body.relatedDocumentIds), version: 1, createdAt: now, updatedAt: now };
    await StudioStore.save(KNOWLEDGE_COLLECTION, document.id, document);
    res.status(201).json(document);
  } catch (error) {
    console.error('[ContentStudio] knowledge creation failed', error);
    res.status(500).json({ error: 'Failed to create knowledge document.' });
  }
});

contentStudioRouter.get('/knowledge/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const document = await getOwnedDocument(KNOWLEDGE_COLLECTION, req.params.id, userId) as KnowledgeDocument | null;
  if (!document) return res.status(404).json({ error: 'Knowledge document not found.' });
  const versions = await StudioStore.list(KNOWLEDGE_VERSIONS_COLLECTION, userId);
  res.json({ document, versions: (versions as any[]).filter((version) => version.userId === userId && version.knowledgeId === document.id).sort((a, b) => b.version - a.version) });
});

contentStudioRouter.patch('/knowledge/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const existing = await getOwnedDocument(KNOWLEDGE_COLLECTION, req.params.id, userId) as KnowledgeDocument | null;
    if (!existing) return res.status(404).json({ error: 'Knowledge document not found.' });
    if (req.body.category !== undefined && !isKnowledgeCategory(req.body.category)) return res.status(400).json({ error: 'Invalid knowledge category.' });
    await saveKnowledgeVersion(existing);
    const updated: KnowledgeDocument = {
      ...existing,
      ...(typeof req.body.title === 'string' ? { title: req.body.title.trim() } : {}),
      ...(typeof req.body.content === 'string' ? { content: req.body.content } : {}),
      ...(isKnowledgeCategory(req.body.category) ? { category: req.body.category } : {}),
      ...(req.body.tags !== undefined ? { tags: stringArray(req.body.tags) } : {}),
      ...(req.body.relatedDocumentIds !== undefined ? { relatedDocumentIds: stringArray(req.body.relatedDocumentIds) } : {}),
      version: existing.version + 1, updatedAt: new Date().toISOString(),
    };
    await StudioStore.save(KNOWLEDGE_COLLECTION, updated.id, updated);
    res.json(updated);
  } catch (error) {
    console.error('[ContentStudio] knowledge update failed', error);
    res.status(500).json({ error: 'Failed to update knowledge document.' });
  }
});

contentStudioRouter.delete('/knowledge/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const existing = await getOwnedDocument(KNOWLEDGE_COLLECTION, req.params.id, userId);
    if (!existing) return res.status(404).json({ error: 'Knowledge document not found.' });
    await StudioStore.remove(KNOWLEDGE_COLLECTION, req.params.id);
    res.status(204).send();
  } catch (error) {
    console.error('[ContentStudio] knowledge deletion failed', error);
    res.status(500).json({ error: 'Failed to delete knowledge document.' });
  }
});
