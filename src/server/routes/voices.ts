import { Router } from 'express';
import multer from 'multer';
import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export const voicesRouter = Router();

const upload = multer({ dest: 'uploads/temp-voices/' });

voicesRouter.post('/clone', upload.array('files'), async (req: any, res) => {
  try {
    const { name, description } = req.body;
    const files = req.files as any[];

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No audio files provided for cloning.' });
    }

    const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
    
    if (!elevenLabsKey) {
      return res.status(500).json({ error: 'ELEVENLABS_API_KEY is not configured.' });
    }

    const formData = new FormData();
    const voiceName = name || `Cloned Voice ${uuidv4().substring(0, 5)}`;
    formData.append('name', voiceName);
    if (description) {
      formData.append('description', description);
    }

    // Append each file
    for (const file of files) {
      const fileStream = fs.createReadStream(file.path);
      formData.append('files', fileStream, {
        filename: file.originalname,
        contentType: file.mimetype,
      });
    }

    console.log('[ElevenLabs] Adding new voice...');
    
    const response = await (global as any).fetch('https://api.elevenlabs.io/v1/voices/add', {
      method: 'POST',
      headers: {
        'xi-api-key': elevenLabsKey,
        ...formData.getHeaders(),
      },
      body: formData as any,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[ElevenLabs] Failed to add voice:', errorText);
      return res.status(response.status).json({ error: 'Failed to clone voice via ElevenLabs API.', details: errorText });
    }

    const data = (await response.json()) as any;
    const voiceId = data.voice_id;
    
    console.log(`[ElevenLabs] Successfully cloned voice: ${voiceId}`);

    // Clean up temporary files
    for (const file of files) {
      try { fs.unlinkSync(file.path); } catch (e) {}
    }

    res.json({ success: true, voiceId, name: voiceName });
  } catch (error: any) {
    console.error('[Voice Sync] Error cloning voice:', error);
    res.status(500).json({ error: error.message });
  }
});
