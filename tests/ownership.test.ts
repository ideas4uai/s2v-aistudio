import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mayModifyProject, isLocalDiskProject, isSingleOperatorInstall } from '../src/server/utils/ownership.js';

/**
 * The rule that decides whether a trash, restore or delete is allowed.
 *
 * Run against a real temp outputs/ directory rather than a mock, because the whole
 * point of the third condition is that a file either is or is not in this machine's
 * own outputs/ — a mocked existence check would prove nothing about the property the
 * relaxation is scoped by.
 */

const MINE = 'sq2LfioDO9V6TNv3cLScVAbAtyD3';
const THEIRS = 'dev-user';

let dir: string;
let prevNode: string | undefined;
let prevFs: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-'));
  prevNode = process.env.NODE_ENV;
  prevFs = process.env.DISABLE_FIRESTORE;
  process.env.NODE_ENV = 'development';
  process.env.DISABLE_FIRESTORE = 'true';
});

afterEach(() => {
  if (prevNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNode;
  if (prevFs === undefined) delete process.env.DISABLE_FIRESTORE; else process.env.DISABLE_FIRESTORE = prevFs;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A project that really has a record in the local outputs/ directory. */
const onDisk = (id: string, userId?: string) => {
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ project_id: id, userId }));
  return { project_id: id, userId };
};

describe('the rules that did not change', () => {
  it('lets the owner modify their own project', () => {
    expect(mayModifyProject(onDisk('p1', MINE), MINE, 'p1', dir)).toBe(true);
  });

  it('treats an unowned record as the caller’s, as it always has', () => {
    expect(mayModifyProject({ project_id: 'p1' }, MINE, 'p1', dir)).toBe(true);
    expect(mayModifyProject({ project_id: 'p1', userId: null }, MINE, 'p1', dir)).toBe(true);
    expect(mayModifyProject({ project_id: 'p1', userId: '' }, undefined, 'p1', dir)).toBe(true);
  });
});

describe('a local-disk record in a single-operator install', () => {
  it('is modifiable from the other identity the same human gets', () => {
    // The reported bug: the browser signs as a real Firebase uid, curl and a
    // session-less profile sign as dev-user, and each half could not delete the other.
    expect(mayModifyProject(onDisk('p1', THEIRS), MINE, 'p1', dir)).toBe(true);
    expect(mayModifyProject(onDisk('p2', MINE), THEIRS, 'p2', dir)).toBe(true);
  });

  it('is modifiable even by a session carrying no uid at all', () => {
    expect(mayModifyProject(onDisk('p1', THEIRS), undefined, 'p1', dir)).toBe(true);
  });
});

describe('what the relaxation must never reach', () => {
  it('refuses a project with no file in this machine’s outputs/', () => {
    // A Firestore-backed project: loadProject() resolves it, but it is not ours.
    expect(mayModifyProject({ project_id: 'p1', userId: THEIRS }, MINE, 'p1', dir)).toBe(false);
  });

  it('stays strict in production', () => {
    const p = onDisk('p1', THEIRS);
    process.env.NODE_ENV = 'production';
    expect(mayModifyProject(p, MINE, 'p1', dir)).toBe(false);
    // Still strict for the project's real owner? No — ownership always wins.
    expect(mayModifyProject(p, THEIRS, 'p1', dir)).toBe(true);
  });

  it('stays strict when a shared database is authoritative', () => {
    const p = onDisk('p1', THEIRS);
    process.env.DISABLE_FIRESTORE = 'false';
    expect(mayModifyProject(p, MINE, 'p1', dir)).toBe(false);
  });

  it('stays strict for `npm run render`, which is local AND production', () => {
    // The reason both flags are required rather than either: this script sets
    // DISABLE_FIRESTORE=true with NODE_ENV=production.
    const p = onDisk('p1', THEIRS);
    process.env.NODE_ENV = 'production';
    process.env.DISABLE_FIRESTORE = 'true';
    expect(isSingleOperatorInstall()).toBe(false);
    expect(mayModifyProject(p, MINE, 'p1', dir)).toBe(false);
  });

  it('cannot be talked into it by a traversing id', () => {
    fs.writeFileSync(path.join(dir, 'real.json'), '{}');
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    for (const id of ['../real', '..\\real', 'sub/../real', '']) {
      expect(isLocalDiskProject(id, sub)).toBe(false);
      expect(mayModifyProject({ userId: THEIRS }, MINE, id, sub)).toBe(false);
    }
  });

  it('is not fooled by a directory named like a project', () => {
    fs.mkdirSync(path.join(dir, 'p1.json'));
    expect(isLocalDiskProject('p1', dir)).toBe(false);
  });
});
