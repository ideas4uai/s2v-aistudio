import { Project } from '../models/project.js';

export const calculateQualityScore = (project?: Project) => {
  if (!project || !project.scenes) return 0;
  let score = 50;
  if (project.scenes.length >= 3) score += 20;
  if (!project.scenes.some(s => s.status === 'failed')) score += 30;
  return score;
};