import { Router } from 'express';
export const feedbackRouter = Router();

feedbackRouter.post('/', (req, res) => {
  res.json({ success: true });
});
