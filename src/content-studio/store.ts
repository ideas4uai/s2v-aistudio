import * as fs from 'fs';
import * as path from 'path';
import { FirestoreService } from '../server/db/firestore.js';
import { getOutputsDir } from '../pipeline/projectDiskStore.js';

// Persistence seam for Content Studio, mirroring src/pipeline/projectDiskStore.ts.
//
// FirestoreService silently returns without writing when there is no auth token,
// and dev/render modes supply either a fake '__dev__' token or none at all. The
// project pipeline already has an escape hatch for this (projectMemoryStore +
// projectDiskStore); without the same hatch every studio write is a no-op that
// still returns 200.

const isLocal = (): boolean => process.env.DISABLE_FIRESTORE === 'true';

// Document ids reach here straight from req.params, and they become path
// segments in local mode. Anything that is not a plain id is rejected rather
// than escaped — studio ids are uuids, so there is nothing legitimate to escape.
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function docPath(collection: string, id: string): string {
  if (!SAFE_ID.test(collection) || !SAFE_ID.test(id) || id === '.' || id === '..') {
    throw new Error(`Unsafe Content Studio document path: ${collection}/${id}`);
  }
  return path.join(getOutputsDir(), 'content-studio', collection, `${id}.json`);
}

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    // Missing, unreadable, or partially written — treat as absent.
    return null;
  }
}

export const StudioStore = {
  async save(collection: string, id: string, data: any): Promise<void> {
    // Production packages key ownership off `ownerId`, but Firestore's
    // listDocuments filters server-side on `userId`. Mirroring the field here
    // makes packages listable without touching the shared FirestoreService.
    const record = { ...data, userId: data.userId ?? data.ownerId, updatedAt: new Date().toISOString() };
    if (!isLocal()) {
      await FirestoreService.saveDocument(collection, id, record);
      return;
    }
    const finalPath = docPath(collection, id);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    const tmpPath = `${finalPath}.tmp`;
    // Write-then-rename: a crash mid-write must not corrupt the last good copy.
    fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2));
    fs.renameSync(tmpPath, finalPath);
  },

  async get(collection: string, id: string): Promise<any | null> {
    if (!isLocal()) return FirestoreService.getDocument(collection, id);
    return readJson(docPath(collection, id));
  },

  async list(collection: string, userId: string): Promise<any[]> {
    if (!isLocal()) return FirestoreService.listDocuments(collection, userId);
    const dir = path.join(getOutputsDir(), 'content-studio', collection);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => readJson(path.join(dir, file)))
      .filter((doc) => doc && (doc.userId === userId || doc.ownerId === userId));
  },

  async remove(collection: string, id: string): Promise<void> {
    if (!isLocal()) {
      await FirestoreService.deleteDocument(collection, id);
      return;
    }
    fs.rmSync(docPath(collection, id), { force: true });
  },
};
