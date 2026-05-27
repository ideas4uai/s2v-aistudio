import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { FirestoreService } from '../server/db/firestore.js';

const COLLECTION = 'universes';

export const universeController = {
  async save(req: Request, res: Response) {
    const userId = (req as any).user?.uid;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const id = req.body.id || uuidv4();
      const universe = {
        ...req.body,
        id,
        userId,
        createdAt: req.body.createdAt || new Date().toISOString(),
      };
      await FirestoreService.saveDocument(COLLECTION, id, universe);
      res.status(201).json(universe);
    } catch (error) {
      console.error('[Universe] Save failed:', error);
      res.status(500).json({ error: 'Failed to save universe' });
    }
  },

  async list(req: Request, res: Response) {
    const userId = (req as any).user?.uid;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const universes = await FirestoreService.listDocuments(COLLECTION, userId) || [];
      res.json(universes);
    } catch (error) {
      console.error('[Universe] List failed:', error);
      res.status(500).json({ error: 'Failed to list universes' });
    }
  },

  async get(req: Request, res: Response) {
    try {
      const universe = await FirestoreService.getDocument(COLLECTION, req.params.id);
      if (!universe) return res.status(404).json({ error: 'Universe not found' });
      res.json(universe);
    } catch (error) {
      console.error('[Universe] Get failed:', error);
      res.status(500).json({ error: 'Failed to get universe' });
    }
  },

  async update(req: Request, res: Response) {
    const userId = (req as any).user?.uid;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const existing: any = await FirestoreService.getDocument(COLLECTION, req.params.id);
      if (!existing) return res.status(404).json({ error: 'Universe not found' });

      const updated = { ...existing, ...req.body, id: req.params.id, userId };
      await FirestoreService.saveDocument(COLLECTION, req.params.id, updated);
      res.json(updated);
    } catch (error) {
      console.error('[Universe] Update failed:', error);
      res.status(500).json({ error: 'Failed to update universe' });
    }
  },

  async remove(req: Request, res: Response) {
    const userId = (req as any).user?.uid;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    try {
      await FirestoreService.deleteDocument(COLLECTION, req.params.id);
      res.json({ message: 'Universe deleted' });
    } catch (error) {
      console.error('[Universe] Delete failed:', error);
      res.status(500).json({ error: 'Failed to delete universe' });
    }
  },
};
