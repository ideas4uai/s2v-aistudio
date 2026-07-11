import * as fs from 'fs';
import * as path from 'path';
import { FirestoreService } from '../server/db/firestore.js';

// STORAGE_MODE=local    → scene images are written under outputs/scene-images/
//                         and the scene record holds the absolute local path
//                         (same convention as segment_path etc.; the GET project
//                         route maps it through toUrl() for the UI, and /outputs
//                         is served statically).
// STORAGE_MODE=supabase → existing Supabase Storage upload (default).
export const storageMode = (env: NodeJS.ProcessEnv = process.env): 'local' | 'supabase' =>
  env.STORAGE_MODE === 'local' ? 'local' : 'supabase';

export async function storeSceneImage(
  projectId: string,
  fileName: string,
  buffer: Buffer,
  contentType: string = 'image/jpeg',
  baseDir: string = process.cwd()
): Promise<string> {
  if (storageMode() === 'local') {
    const dir = path.join(baseDir, 'outputs', 'scene-images', projectId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, buffer);
    console.log(`[Storage] Scene image saved locally (STORAGE_MODE=local): ${filePath}`);
    return filePath;
  }
  return FirestoreService.uploadAsset(projectId, fileName, buffer, contentType);
}
