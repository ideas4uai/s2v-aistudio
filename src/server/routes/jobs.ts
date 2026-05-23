import { Router } from 'express';
export const jobsRouter = Router();

jobsRouter.get('/', (req, res) => {
  res.json([]);
});

jobsRouter.get('/:id', (req, res) => {
  res.json({ id: req.params.id, status: 'pending' });
});
