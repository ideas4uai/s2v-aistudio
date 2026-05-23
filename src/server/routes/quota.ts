import { Router } from 'express';

export const quotaRouter = Router();

quotaRouter.get('/', (req, res) => {
  res.json({
    aiImagesUsed: 0,
    aiImagesLimit: 10,
    audioUsed: 0,
    audioLimit: 10,
    resetAt: new Date(Date.now() + 86400000).toISOString()
  });
});
