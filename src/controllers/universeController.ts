import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { FirestoreService } from '../server/db/firestore.js';

const COLLECTION = 'universes';

export const universeController = {
  async save(req: Request, res: Response) {
    console.log('[Universe] POST /api/universes called');
    console.log('[Universe] body:', JSON.stringify(req.body));
    const userId = (req as any).user?.uid;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const id = uuidv4();
      const universe = { id, ...req.body, userId, createdAt: new Date().toISOString() };
      console.log('[Universe] saving with id:', id);
      await FirestoreService.saveDocument(COLLECTION, id, universe);
      console.log('[Universe] saved successfully');
      res.json(universe);
    } catch (err: any) {
      console.error('[Universe] save error:', err.message);
      res.status(500).json({ error: err.message });
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
    console.log('[Universe] PUT /api/universes/:id called, id:', req.params.id);
    console.log('[Universe] body keys:', Object.keys(req.body));
    const userId = (req as any).user?.uid;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    try {
      await FirestoreService.saveDocument(COLLECTION, req.params.id, req.body);
      console.log('[Universe] updated successfully');
      res.json(req.body);
    } catch (err: any) {
      console.error('[Universe] update error:', err.message);
      res.status(500).json({ error: err.message });
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
