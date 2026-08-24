import { describe, it, expect, beforeEach, vi } from 'vitest';

// firestore.ts imports fetch from 'node-fetch', so the global stub does nothing here —
// the module has to be mocked, or the test makes real requests to Firestore.
const { calls, mockFetch } = vi.hoisted(() => {
  const calls: any[] = [];
  return {
    calls,
    mockFetch: (_url: any, init: any = {}) => {
      calls.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true, status: 200, json: async () => ([]) });
    },
  };
});
vi.mock('node-fetch', () => ({ default: mockFetch }));

const { FirestoreService } = await import('../src/server/db/firestore.js');
const { requestContext } = await import('../src/server/utils/context.js');

/**
 * The dashboard must never list a project it will then refuse to modify.
 *
 * dev-user used to be exempt from the owner filter on this query, which made it a
 * superuser for reading and a nobody for writing: the list came back with every cloud
 * project in the database, and the trash/delete routes then answered 403 for the ones
 * it did not own. Selecting a dozen and hitting delete produced a row of 403s while
 * single deletes on local projects kept working — which is exactly how it was reported.
 *
 * Asserted against the query body actually sent, because the filter is the whole
 * mechanism; a test on the returned rows would pass against a fixture that never had
 * another account's data in it.
 */

const sent = calls;

beforeEach(() => { sent.length = 0; });

/** getProjects reads the caller's token from async-local storage, as the route does. */
const listAs = (uid: string, token = 'tok') =>
  requestContext.run({ token }, () => FirestoreService.getProjects(uid));

const filterOf = (body: any) => body?.structuredQuery?.where?.fieldFilter;

describe('the projects query is always scoped to one owner', () => {
  it('filters by userId for a real account', async () => {
    await listAs('sq2LfioDO9V6TNv3cLScVAbAtyD3');
    const f = filterOf(sent[0]);
    expect(f).toBeDefined();
    expect(f.field.fieldPath).toBe('userId');
    expect(f.op).toBe('EQUAL');
    expect(f.value.stringValue).toBe('sq2LfioDO9V6TNv3cLScVAbAtyD3');
  });

  it('filters by userId for dev-user too — the exemption that caused the bug', async () => {
    await listAs('dev-user');
    const f = filterOf(sent[0]);
    expect(f).toBeDefined();
    expect(f.value.stringValue).toBe('dev-user');
  });

  it('never sends an unfiltered query, whatever the uid', async () => {
    for (const uid of ['dev-user', 'sq2Lfio', 'anything']) await listAs(uid);
    expect(sent).toHaveLength(3);
    for (const body of sent) {
      expect(body.structuredQuery.where).toBeDefined();
      expect(filterOf(body).field.fieldPath).toBe('userId');
    }
  });

  it('asks Firestore for nothing at all when there is no token', async () => {
    // No credential means no caller to scope to, so the safe answer is an empty list
    // rather than a query that might not be scoped.
    const out = await requestContext.run({}, () => FirestoreService.getProjects('dev-user'));
    expect(out).toEqual([]);
    expect(sent).toHaveLength(0);
  });
});
