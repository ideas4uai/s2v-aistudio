import { Router } from 'express';
export const assetsRouter = Router();

assetsRouter.get('/', (req, res) => {
  res.json([]);
});
