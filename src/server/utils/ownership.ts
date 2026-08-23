import fs from 'fs';
import path from 'path';
import { getOutputsDir } from '../../pipeline/projectDiskStore.js';

/**
 * Who is allowed to change a project.
 *
 * ── The problem this exists for ────────────────────────────────────────────────
 * One human running this locally gets TWO identities, depending on something they
 * cannot see. `src/utils/api.ts` attaches a bearer token whenever `auth.currentUser`
 * is set, so a browser with a persisted Firebase session signs every request as that
 * real uid. Anything without a session — a fresh browser profile, curl, a
 * verification script — arrives with no header at all and the dev auth middleware in
 * server.ts stamps it `dev-user`. Meanwhile AuthContext short-circuits dev mode to a
 * fake `dev-user` and never subscribes to Firebase, so the UI cheerfully says "Dev
 * User" while the API is being called as somebody else entirely.
 *
 * The result on disk is one operator's outputs/ directory split between two owners,
 * and a strict `project.userId !== userId` check makes each half permanently
 * unmodifiable from the other half's session — including undeletable.
 *
 * ── Why relaxing this is not a hole ───────────────────────────────────────────
 * The list route already treats local disk as single-operator: `listLocalProjects()`
 * is returned unfiltered, so every local project is visible to every session, while
 * the Firestore half goes through `getProjects(uid)` and IS filtered by owner. The
 * mutation check was the odd one out — applying a multi-tenant rule to a store the
 * read path had already declared single-tenant. You could see all 81 and delete 27.
 *
 * So the relaxation is scoped to exactly that store, and every condition below is
 * load-bearing:
 *
 *   1. development only — a deployed instance is never relaxed.
 *   2. DISABLE_FIRESTORE=true — no shared database is authoritative for projects.
 *      `npm run render` sets this with NODE_ENV=production, which is why (1) alone
 *      is not enough and both are required.
 *   3. the record is a file in THIS machine's outputs/ — a Firestore-backed project
 *      is still protected even in dev mode, because loadProject() falls through to
 *      Firestore for anything absent from the local store.
 *
 * A real second user's project cannot satisfy all three: it does not live in this
 * operator's outputs/ directory.
 */

/** One person, one machine, no shared database — rather than a multi-tenant deployment. */
export function isSingleOperatorInstall(): boolean {
  return process.env.NODE_ENV === 'development' && process.env.DISABLE_FIRESTORE === 'true';
}

/** Does `id` name a project file in this machine's own outputs/ directory? */
export function isLocalDiskProject(id: string, dir: string = getOutputsDir()): boolean {
  // The id arrives as a URL parameter and is about to be pasted into a filesystem
  // path. Without this, a `..` segment would let a Firestore-only project borrow the
  // existence of an unrelated file and be waved through as local.
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) return false;
  try {
    return fs.statSync(path.join(dir, `${id}.json`)).isFile();
  } catch {
    return false;
  }
}

/**
 * May this caller trash, restore or delete this project?
 *
 * Unowned records stay the caller's, which is the long-standing rule for projects
 * created before per-user ownership existed.
 */
export function mayModifyProject(
  project: any,
  userId: string | undefined,
  id: string,
  dir?: string,
): boolean {
  if (!project?.userId) return true;
  if (project.userId === userId) return true;
  return isSingleOperatorInstall() && isLocalDiskProject(id, dir);
}
