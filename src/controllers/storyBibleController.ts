import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { FirestoreService } from '../server/db/firestore.js';

const COLLECTION = 'story_bibles';

export const storyBibleController = {
  async save(req: Request, res: Response) {
    const userId = (req as any).user?.uid;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const id = req.body.id || uuidv4();
      const bible = {
        ...req.body,
        id,
        userId,
        createdAt: req.body.createdAt || new Date().toISOString(),
      };
      await FirestoreService.saveDocument(COLLECTION, id, bible);
      res.status(201).json(bible);
    } catch (error) {
      console.error('[StoryBible] Save failed:', error);
      res.status(500).json({ error: 'Failed to save story bible' });
    }
  },

  async list(req: Request, res: Response) {
    const userId = (req as any).user?.uid;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const bibles = await FirestoreService.listDocuments(COLLECTION, userId) || [];
      res.json(bibles);
    } catch (error) {
      console.error('[StoryBible] List failed:', error);
      res.status(500).json({ error: 'Failed to list story bibles' });
    }
  },

  async get(req: Request, res: Response) {
    try {
      const bible = await FirestoreService.getDocument(COLLECTION, req.params.id);
      if (!bible) return res.status(404).json({ error: 'Story bible not found' });
      res.json(bible);
    } catch (error) {
      console.error('[StoryBible] Get failed:', error);
      res.status(500).json({ error: 'Failed to get story bible' });
    }
  },

  async update(req: Request, res: Response) {
    const userId = (req as any).user?.uid;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const existing: any = await FirestoreService.getDocument(COLLECTION, req.params.id);
      if (!existing) return res.status(404).json({ error: 'Story bible not found' });

      const updated = { ...existing, ...req.body, id: req.params.id, userId };
      await FirestoreService.saveDocument(COLLECTION, req.params.id, updated);
      res.json(updated);
    } catch (error) {
      console.error('[StoryBible] Update failed:', error);
      res.status(500).json({ error: 'Failed to update story bible' });
    }
  },

  async remove(req: Request, res: Response) {
    const userId = (req as any).user?.uid;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    try {
      await FirestoreService.deleteDocument(COLLECTION, req.params.id);
      res.json({ message: 'Story bible deleted' });
    } catch (error) {
      console.error('[StoryBible] Delete failed:', error);
      res.status(500).json({ error: 'Failed to delete story bible' });
    }
  },
};
