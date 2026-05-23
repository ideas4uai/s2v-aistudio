import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';

export const templatesRouter = Router();

const DEFAULT_TEMPLATES = [
  {
    id: 'default-1',
    name: 'TikTok Viral Hook',
    hookStrategy: 'contrarian',
    pacingIntensity: 'fast',
    styleProfile: 'gen_z',
    visualStyle: 'cinematic',
    voiceStyle: 'energetic'
  },
  {
    id: 'default-2',
    name: 'Educational Deep Dive',
    hookStrategy: 'question',
    pacingIntensity: 'medium',
    styleProfile: 'professional',
    visualStyle: 'minimalist',
    voiceStyle: 'calm'
  }
];

let memoryTemplates = [...DEFAULT_TEMPLATES];

// Get all templates
templatesRouter.get('/', async (req, res) => {
  res.json(memoryTemplates);
});

// Create a new template
templatesRouter.post('/', async (req, res) => {
  const { name, hookStrategy, pacingIntensity, styleProfile, visualStyle, voiceStyle } = req.body;
  if (!name || !hookStrategy || !pacingIntensity || !styleProfile || !visualStyle || !voiceStyle) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const id = uuidv4();
  const newTemplate = {
      id,
      name,
      hookStrategy,
      pacingIntensity,
      styleProfile,
      visualStyle,
      voiceStyle,
      updatedAt: new Date().toISOString()
  };
  memoryTemplates.push(newTemplate);
  res.status(201).json(newTemplate);
});

// Delete a template
templatesRouter.delete('/:id', async (req, res) => {
  const { id } = req.params;
  memoryTemplates = memoryTemplates.filter(t => t.id !== id);
  res.json({ success: true });
});
