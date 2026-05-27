import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { projectsRouter } from './src/server/routes/projects.js';
import { storyBibleController } from './src/controllers/storyBibleController.js';
import { jobsRouter } from './src/server/routes/jobs.js';
import { assetsRouter } from './src/server/routes/assets.js';
import { visualsRouter } from './src/server/routes/visuals.js';
import { templatesRouter } from './src/server/routes/templates.js';
import { feedbackRouter } from './src/server/routes/feedback.js';
import { quotaRouter } from './src/server/routes/quota.js';
import { voicesRouter } from './src/server/routes/voices.js';
import { v4 as uuidv4 } from 'uuid';
import { verifyIdToken } from './src/server/utils/auth.js';
import { fdb } from './src/server/db/firestore.js';
import { getPoolStatus } from './src/utils/geminiAuth.js';
import { requestContext } from './src/server/utils/context.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function seedTemplates() {
  try {
    const templatesCol = fdb.collection('templates');
    const existingSnapshot = await templatesCol.get();
    if (existingSnapshot.empty) {
      console.log('Seeding default templates...');
      const defaultTemplates = [
        {
          id: uuidv4(),
          name: 'Cinematic Story',
          hookStrategy: 'storytelling',
          pacingIntensity: 'moderate',
          styleProfile: 'cinematic',
          visualStyle: 'cinematic',
          voiceStyle: 'professional',
        },
        {
          id: uuidv4(),
          name: 'Fast-Paced Hook',
          hookStrategy: 'shocking',
          pacingIntensity: 'fast',
          styleProfile: 'high-contrast',
          visualStyle: 'cyberpunk',
          voiceStyle: 'energetic',
        },
        {
          id: uuidv4(),
          name: 'Minimalist Explainer',
          hookStrategy: 'curiosity',
          pacingIntensity: 'slow',
          styleProfile: 'minimal',
          visualStyle: 'watercolor',
          voiceStyle: 'casual',
        }
      ];
      for (const template of defaultTemplates) {
        await templatesCol.doc(template.id).set(template);
      }
      console.log('Seeding completed.');
    }
  } catch (error) {
    console.error('Error seeding templates:', error);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // Request timing middleware
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', async () => {
      const duration = Date.now() - start;
      if (duration > 2000 && req.path.startsWith('/api')) {
        console.warn(`Slow request detected: ${req.method} ${req.path} took ${duration}ms`);
      }
    });
    next();
  });

  // Ensure essential directories exist
  const dirs = ['outputs', 'uploads', 'cache', 'temp', 'outputs/projects'];
  for (const dir of dirs) {
    const dirPath = path.join(process.cwd(), dir);
    if (!fs.existsSync(dirPath)) {
      console.log(`Creating directory: ${dirPath}`);
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  // Init Data on startup
  try {
    await seedTemplates();
  } catch (error) {
    console.error('Error during startup initialization:', error);
  }

  // Optional local TTS initialization (e.g. Piper)
  if (process.env.PIPER_BIN_PATH) {
    const piperBinPath = path.resolve(process.cwd(), process.env.PIPER_BIN_PATH);
    const binExists = fs.existsSync(piperBinPath);
    console.log(`[Piper Health Check] Binary exists: ${binExists} (${piperBinPath})`);
    if (!binExists) {
      console.warn('[Piper Health Check] WARNING: PIPER_BIN_PATH is set but binary not found.');
    }
  }

  // Auth middleware for API routes only
  app.use('/api', async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split('Bearer ')[1];
        // Use a timeout for token verification to prevent hanging the whole request
        const verifyPromise = verifyIdToken(token);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Auth verification timeout')), 5000));
        
        const uid = await Promise.race([verifyPromise, timeoutPromise]) as string | null;
        if (uid) {
          (req as any).user = { uid, token };
        }
        
        requestContext.run({ token }, () => {
          next();
        });
        return;
      }
    } catch (err) {
      console.warn('[Server] Auth verification failed or timed out:', err);
    }
    
    if (process.env.NODE_ENV === 'development') {
      (req as any).user = { uid: 'dev-user', token: '__dev__' };
      requestContext.run({ token: '__dev__' }, () => {
        next();
      });
      return;
    }

    requestContext.run({}, () => {
      next();
    });
  });

  app.use((req, res, next) => {
    if (req.path !== '/api/health') {
      console.log(`[Server] Request: ${req.method} ${req.path}`);
    }
    next();
  });
  app.use('/api/projects', projectsRouter);
  app.use('/v1/projects', projectsRouter);
  app.post('/api/story-bibles', storyBibleController.save);
  app.get('/api/story-bibles', storyBibleController.list);
  app.get('/api/story-bibles/:id', storyBibleController.get);
  app.put('/api/story-bibles/:id', storyBibleController.update);
  app.delete('/api/story-bibles/:id', storyBibleController.remove);
  app.use('/api/jobs', jobsRouter);
  app.use('/api/assets', assetsRouter);
  app.use('/api/visuals', visualsRouter);
  app.use('/api/templates', templatesRouter);
  app.use('/api/feedback', feedbackRouter);
  app.use('/api/quota', quotaRouter);
  app.use('/api/voices', voicesRouter);

  // Serve rendered videos
  app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
  app.use('/outputs', express.static(path.join(process.cwd(), 'outputs')));
  app.use('/cache', express.static(path.join(process.cwd(), 'cache')));
  app.use('/music', express.static(process.env.MUSIC_DIR || path.join(process.cwd(), 'music')));

  app.get('/api/music', (req, res) => {
    const musicDir = process.env.MUSIC_DIR || path.join(process.cwd(), 'music');
    try {
      if (!fs.existsSync(musicDir)) return res.json([]);
      const files = fs.readdirSync(musicDir).filter(f => /\.(mp3|wav|ogg|m4a)$/i.test(f));
      const tracks = files.map(filename => {
        const nameWithoutExt = filename.replace(/\.[^.]+$/, '');
        const name = nameWithoutExt
          .replace(/^\d+[-_]?/, '')
          .replace(/[-_]/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase())
          .trim() || nameWithoutExt;
        const genreMatch = nameWithoutExt.match(/^(\d+)/);
        const genre = genreMatch ? `Track ${genreMatch[1]}` : 'Music';
        return { id: nameWithoutExt, name, filename, genre, url: `/music/${filename}` };
      });
      res.json(tracks);
    } catch (err) {
      res.status(500).json({ error: 'Failed to read music directory' });
    }
  });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', version: '1.0.0' });
  });

  app.get('/api/test-image', async (req, res) => {
    try {
      const { AIService } = await import('./src/services/aiService.js');
      const base64 = await AIService.generateImageBase64(
        'A simple red apple on a white table, photorealistic'
      );
      res.json({
        success: true,
        sizeKB: Math.round(base64.length * 0.75 / 1024)
      });
    } catch (err: any) {
      res.json({
        success: false,
        error: err.message,
        status: err.status
      });
    }
  });


  // Error handling middleware
  app.use(async (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('API Error:', err);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    console.log('Starting Vite in development mode...');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    
    // Masked debug logging for Gemini keys
    const maskKey = (key: string | undefined) => {
      if (!key) return 'exists: no';
      const trimmed = key.trim().replace(/^["']|["']$/g, '');
      if (trimmed.length === 0) return 'exists: yes, but empty';
      return `exists: yes, len: ${trimmed.length}, prefix: ${trimmed.substring(0, 6)}, suffix: ${trimmed.substring(trimmed.length - 4)}`;
    };
    
    console.log(`[STARTUP] GEMINI_API_KEY -> ${maskKey(process.env.GEMINI_API_KEY)}`);
    console.log(`[STARTUP] MY_CUSTOM_GEMINI_API_KEY -> ${maskKey(process.env.MY_CUSTOM_GEMINI_API_KEY)}`);

    const pool = getPoolStatus();
    console.log(`[STARTUP] Key pool: ${pool.available}/${pool.total} keys loaded`);
    if (pool.total === 0) {
      console.error('[STARTUP] WARNING: No Gemini API keys detected — AI generation will fail');
    }

    const piperBin = process.env.PIPER_BIN_PATH;
    if (piperBin) {
      try {
        execSync(`"${piperBin}" --version`, { timeout: 3000 });
        console.log('[STARTUP] Piper TTS: available');
      } catch {
        console.warn('[STARTUP] Piper TTS: binary not working at', piperBin);
      }
    } else {
      console.log('[STARTUP] Piper TTS: not configured, using Google TTS');
    }
  });
}

startServer();
