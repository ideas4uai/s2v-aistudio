import { Router } from 'express';
export const visualsRouter = Router();

visualsRouter.post('/generate', (req, res) => {
  res.json({ status: 'queued' });
});
