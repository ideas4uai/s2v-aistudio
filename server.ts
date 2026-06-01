import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { projectsRouter } from './src/server/routes/projects.js';
import { universeController } from './src/controllers/universeController.js';
import { jobsRouter } from './src/server/routes/jobs.js';
import { assetsRouter } from './src/server/routes/assets.js';
import { visualsRouter } from './src/server/routes/visuals.js';
import { templatesRouter } from './src/server/routes/templates.js';
import { feedbackRouter } from './src/server/routes/feedback.js';
import { quotaRouter } from './src/server/routes/quota.js';
import { voicesRouter } from './src/server/routes/voices.js';
import { v4 as uuidv4 } from 'uuid';
import { verifyIdToken } from './src/server/utils/auth.js';
import { fdb, FirestoreService } from './src/server/db/firestore.js';
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
  app.post('/api/universes', universeController.save);
  app.get('/api/universes', universeController.list);
  app.get('/api/universes/:id', universeController.get);
  app.put('/api/universes/:id', universeController.update);
  app.delete('/api/universes/:id', universeController.remove);

  app.post('/api/universes/:id/characters/:charId/image', async (req, res) => {
    const { prompt } = req.body;
    try {
      const { AIService } = await import('./src/services/aiService.js');
      const base64 = await AIService.generateImageBase64(
        prompt + ', ultra high quality, 4K, highly detailed',
        { aspectRatio: '9:16', quality: '4k' }
      );
      const buffer = Buffer.from(base64, 'base64');
      const url = await FirestoreService.uploadAsset(
        req.params.id,
        `characters/${req.params.charId}_${Date.now()}.jpg`,
        buffer,
        'image/jpeg'
      );
      res.json({ imageUrl: url });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post('/api/universes/:id/characters/:charId/train-lora', async (req, res) => {
    const { charId } = req.params;
    const replicateToken = process.env.REPLICATE_API_TOKEN;
    const replicateUsername = process.env.REPLICATE_USERNAME;
    if (!replicateToken) return res.status(500).json({ error: 'REPLICATE_API_TOKEN not configured' });
    if (!replicateUsername) return res.status(500).json({ error: 'REPLICATE_USERNAME not configured' });
    try {
      const universe = await FirestoreService.getDocument('universes', req.params.id);
      if (!universe) return res.status(404).json({ error: 'Universe not found' });
      const character = (universe as any).characters?.find((c: any) => c.id === charId);
      if (!character) return res.status(404).json({ error: 'Character not found' });

      const charName = character.name.toUpperCase();
      const characterPoses = (universe as any).characterPoses?.[charName] || {};
      const trainingImages: string[] = [
        character.referenceImageUrl,
        ...Object.values(characterPoses) as string[],
      ].filter(Boolean);

      console.log('[LoRA] Training images:', trainingImages.length, trainingImages.map((u: string) => u.slice(-30)));
      if (trainingImages.length < 1) {
        return res.status(400).json({ error: 'Need at least 1 training image. Upload a reference image first.' });
      }

      const triggerWord = character.name.toUpperCase().replace(/\s+/g, '_') + '_CHARACTER';
      const modelSlug = character.name.toLowerCase().replace(/\s+/g, '-') + '-lora';
      const destination = `${replicateUsername}/${modelSlug}` as `${string}/${string}`;

      // Version: ostris/flux-dev-lora-trainer — check https://replicate.com/ostris/flux-dev-lora-trainer for latest
      const trainerVersion = process.env.REPLICATE_LORA_TRAINER_VERSION || 'e440909d3512c31646ee2e0c7d6f6f4923224863a6a10c494606e79fb5844497';

      const { default: Replicate } = await import('replicate');
      const replicate = new Replicate({ auth: replicateToken });
      const training = await (replicate.trainings as any).create(
        'ostris',
        'flux-dev-lora-trainer',
        trainerVersion,
        {
          destination,
          input: {
            input_images: trainingImages,
            trigger_word: triggerWord,
            steps: 1000,
            lora_rank: 16,
            learning_rate: 0.0004,
          },
        }
      );

      const updatedChars = (universe as any).characters.map((c: any) =>
        c.id === charId
          ? { ...c, loraTrainingId: training.id, loraStatus: 'training', loraTriggerWord: triggerWord, loraDestination: destination }
          : c
      );
      await FirestoreService.saveDocument('universes', req.params.id, { ...(universe as any), characters: updatedChars });
      console.log(`[LoRA] Training started for ${character.name}: ${training.id}`);
      res.json({ trainingId: training.id, status: 'training', triggerWord });
    } catch (err: any) {
      console.error('[LoRA] Training error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/universes/:id/characters/:charId/lora-status', async (req, res) => {
    const { charId } = req.params;
    const replicateToken = process.env.REPLICATE_API_TOKEN;
    if (!replicateToken) return res.status(500).json({ error: 'REPLICATE_API_TOKEN not configured' });
    try {
      const universe = await FirestoreService.getDocument('universes', req.params.id);
      if (!universe) return res.status(404).json({ error: 'Universe not found' });
      const character = (universe as any).characters?.find((c: any) => c.id === charId);
      if (!character?.loraTrainingId) return res.json({ status: 'none' });

      const { default: Replicate } = await import('replicate');
      const replicate = new Replicate({ auth: replicateToken });
      const training = await replicate.trainings.get(character.loraTrainingId);

      if (training.status === 'succeeded') {
        const loraModelUrl = (training.output as any)?.weights || character.loraDestination;
        const updatedChars = (universe as any).characters.map((c: any) =>
          c.id === charId ? { ...c, loraModelUrl, loraStatus: 'ready' } : c
        );
        await FirestoreService.saveDocument('universes', req.params.id, { ...(universe as any), characters: updatedChars });
        return res.json({ status: 'ready', loraModelUrl });
      }
      if (training.status === 'failed' || training.status === 'canceled') {
        const updatedChars = (universe as any).characters.map((c: any) =>
          c.id === charId ? { ...c, loraStatus: 'failed' } : c
        );
        await FirestoreService.saveDocument('universes', req.params.id, { ...(universe as any), characters: updatedChars });
        return res.json({ status: 'failed' });
      }
      res.json({ status: 'training', trainingId: character.loraTrainingId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/universes/:id/characters/:charId/poses', async (req, res) => {
    const { charId } = req.params;
    try {
      const universe = await FirestoreService.getDocument('universes', req.params.id);
      if (!universe) return res.status(404).json({ error: 'Universe not found' });
      const character = (universe as any).characters?.find((c: any) => c.id === charId);
      if (!character) return res.status(404).json({ error: 'Character not found' });

      const posePrompts: Record<string, string> = {
        talking:  `EXACT same character as reference image. Same face, same outfit, same character design. Pose: mid-sentence, one hand raised palm-up, mouth open speaking, engaged expression. IMPORTANT: Do not change face, outfit, or character design. Only change the pose and expression. transparent or plain background, full body shot, 9:16 vertical`,
        thinking: `EXACT same character as reference image. Same face, same outfit, same character design. Pose: right hand on chin, eyes looking up-left, thoughtful expression, slight smile. IMPORTANT: Do not change face, outfit, or character design. transparent or plain background, full body shot, 9:16 vertical`,
        excited:  `EXACT same character as reference image. Same face, same outfit, same character design. Pose: both hands raised, big genuine smile, eyes wide open, leaning slightly forward. IMPORTANT: Do not change face, outfit, or character design. transparent or plain background, full body shot, 9:16 vertical`,
        confused: `EXACT same character as reference image. Same face, same outfit, same character design. Pose: head tilted right, one eyebrow raised, arms slightly out to sides in shrug. IMPORTANT: Do not change face, outfit, or character design. transparent or plain background, full body shot, 9:16 vertical`,
        sad:      `EXACT same character as reference image. Same face, same outfit, same character design. Pose: shoulders slumped, looking down, hands in pockets, quiet defeated expression. IMPORTANT: Do not change face, outfit, or character design. transparent or plain background, full body shot, 9:16 vertical`,
      };

      const { poseNames } = req.body as { poseNames?: string[] };
      const entriesToGenerate = poseNames?.length
        ? Object.entries(posePrompts).filter(([name]) => poseNames.includes(name))
        : Object.entries(posePrompts);

      const { AIService } = await import('./src/services/aiService.js');
      const results: Record<string, string> = {};

      // idle — use reference image directly, no Imagen call
      const generateIdle = !poseNames?.length || poseNames.includes('idle');
      if (generateIdle && character.referenceImageUrl) {
        results['idle'] = character.referenceImageUrl;
        console.log('[Poses] Using reference image for idle pose');
      }

      for (const [poseName, posePrompt] of entriesToGenerate) {
        console.log('[Poses] Generating:', poseName, 'referenceImageUrl:', character.referenceImageUrl ? character.referenceImageUrl.slice(-30) : 'MISSING');
        if (!character.referenceImageUrl) {
          console.error('[Poses] Skipping pose — no referenceImageUrl on character:', character.name, '— upload a reference image first');
          continue;
        }
        // Gemini Native first — multimodal reference gives better character identity
        let base64 = await AIService.generateImageWithNative(posePrompt, character.referenceImageUrl);
        if (!base64) {
          console.log('[Poses] Gemini Native failed, falling back to Imagen 4 for:', poseName);
          base64 = await AIService.generateImageBase64(posePrompt, {
            aspectRatio: '9:16',
            isStoryEpisode: true,
            referenceImageUrl: character.referenceImageUrl,
          });
        }
        const buffer = Buffer.from(base64, 'base64');
        const url = await FirestoreService.uploadAsset(
          req.params.id,
          `characters/${charId}_pose_${poseName}.jpg`,
          buffer,
          'image/jpeg'
        );
        results[poseName] = url;
      }
      res.json({ poses: results });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/universes/:id/characters/:charId/image/upload', async (req, res) => {
    const { base64, mimeType } = req.body;
    try {
      const buffer = Buffer.from(base64, 'base64');
      const ext = mimeType === 'image/png' ? 'png' : 'jpg';
      const url = await FirestoreService.uploadAsset(
        req.params.id,
        `characters/${req.params.charId}.${ext}`,
        buffer,
        mimeType
      );
      res.json({ imageUrl: url });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/universes/:id/locations/:locationId/image', async (req, res) => {
    const { prompt } = req.body;
    try {
      const { AIService } = await import('./src/services/aiService.js');
      const base64 = await AIService.generateImageBase64(
        prompt + ', ultra high quality, 4K, cinematic establishing shot, wide angle',
        { aspectRatio: '16:9', quality: '4k' }
      );
      const buffer = Buffer.from(base64, 'base64');
      const url = await FirestoreService.uploadAsset(
        req.params.id,
        `locations/${req.params.locationId}_${Date.now()}.jpg`,
        buffer,
        'image/jpeg'
      );
      res.json({ imageUrl: url });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/universes/:id/locations/:locationId/image/upload', async (req, res) => {
    const { base64, mimeType } = req.body;
    try {
      const buffer = Buffer.from(base64, 'base64');
      const ext = mimeType === 'image/png' ? 'png' : 'jpg';
      const url = await FirestoreService.uploadAsset(
        req.params.id,
        `locations/${req.params.locationId}_${Date.now()}.${ext}`,
        buffer,
        mimeType
      );
      res.json({ imageUrl: url });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

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
    
    console.log('[STARTUP] GEMINI_KEY_SCRIPT:', process.env.GEMINI_KEY_SCRIPT ? 'loaded' : 'MISSING');
    console.log('[STARTUP] GEMINI_KEY_SCENES:', process.env.GEMINI_KEY_SCENES ? 'loaded' : 'MISSING');
    console.log('[STARTUP] GEMINI_KEY_VISUAL:', process.env.GEMINI_KEY_VISUAL ? 'loaded' : 'MISSING');
    console.log('[STARTUP] GEMINI_KEY_IMAGE:', process.env.GEMINI_KEY_IMAGE  ? 'loaded' : 'MISSING');

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
