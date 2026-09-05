import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import {
  requireAuthInProduction, rateLimit, resetRateLimits, isPublicApiPath,
  PUBLIC_API_PATHS, RATE_RULES, allowedOrigins,
} from '../src/server/utils/apiGuard.js';

/**
 * The gate that was missing.
 *
 * The /api middleware verified a bearer token and called next() whatever the answer —
 * including on a null uid and on no header at all. Nine of twelve routers carry no
 * check of their own, so publish, channel-disconnect and every generation trigger were
 * reachable unauthenticated in production.
 *
 * Both halves are load-bearing and both are asserted here: production rejects, and
 * development is completely unaffected. The local single-operator model this project
 * runs on has no credential to send, and every verification script in this repo talks
 * to a dev-mode server.
 */

/** One representative path per router, as the /api-mounted middleware sees it. */
const ROUTER_PATHS: Record<string, string> = {
  projects: '/projects',
  contentStudio: '/content-studio/workflows',
  analytics: '/analytics/events',
  youtube: '/youtube/channels',
  schedule: '/schedule',
  jobs: '/jobs/abc',
  assets: '/assets/abc',
  visuals: '/visuals/abc',
  templates: '/templates',
  feedback: '/feedback',
  quota: '/quota',
  voices: '/voices',
};

/** A server running only the two guards, so the assertion is about them and nothing else. */
async function serve(withUser?: { uid: string }) {
  const app = express();
  if (withUser) app.use('/api', (req, _res, next) => { (req as any).user = withUser; next(); });
  app.use('/api', requireAuthInProduction);
  app.use('/api', rateLimit);
  app.use('/api', (_req, res) => res.json({ reached: true }));

  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    get: (path: string) => fetch(`http://127.0.0.1:${port}/api${path}`),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

beforeEach(() => resetRateLimits());
afterEach(() => vi.unstubAllEnvs());

describe('production rejects unauthenticated requests', () => {
  beforeEach(() => vi.stubEnv('NODE_ENV', 'production'));

  it('returns 401 for every router when nobody is signed in', async () => {
    const s = await serve();
    try {
      for (const [router, path] of Object.entries(ROUTER_PATHS)) {
        const res = await s.get(path);
        expect(res.status, `${router} (${path}) must not be reachable unauthenticated`).toBe(401);
      }
    } finally { await s.close(); }
  });

  it('lets a signed-in caller through to every router', async () => {
    const s = await serve({ uid: 'real-user' });
    try {
      for (const path of Object.values(ROUTER_PATHS)) {
        expect((await s.get(path)).status).toBe(200);
      }
    } finally { await s.close(); }
  });

  it('keeps the OAuth flow and health check open', async () => {
    // Google attaches no Authorization header to the callback, and a browser following
    // the consent redirect has no token yet. Locking these breaks connecting a channel.
    const s = await serve();
    try {
      for (const path of PUBLIC_API_PATHS) {
        expect((await s.get(path)).status, `${path} must stay public`).toBe(200);
      }
    } finally { await s.close(); }
  });

  it('does not let a near-miss path inherit the allowlist', () => {
    // Exact paths, not prefixes: '/youtube/authorize' is not '/youtube/auth'.
    const fake = (path: string) => ({ path, originalUrl: path } as any);
    expect(isPublicApiPath(fake('/youtube/auth'))).toBe(true);
    expect(isPublicApiPath(fake('/youtube/authorize'))).toBe(false);
    expect(isPublicApiPath(fake('/health/../projects'))).toBe(false);
    expect(isPublicApiPath(fake('/youtube/disconnect'))).toBe(false);
  });
});

describe('development is unaffected', () => {
  beforeEach(() => vi.stubEnv('NODE_ENV', 'development'));

  it('serves every router with no credential at all', async () => {
    // The established local model: one operator, one machine, no token. ownership.ts
    // and every verification script in this repo depend on this staying true.
    const s = await serve();
    try {
      for (const [router, path] of Object.entries(ROUTER_PATHS)) {
        expect((await s.get(path)).status, `${router} must stay open in dev`).toBe(200);
      }
    } finally { await s.close(); }
  });
});

describe('rate limiting the endpoints that cost money', () => {
  beforeEach(() => vi.stubEnv('NODE_ENV', 'development'));

  it('caps generation and reports when to retry', async () => {
    const rule = RATE_RULES[0];
    const s = await serve();
    try {
      const path = '/projects/p1/generate-script';
      for (let i = 0; i < rule.limit; i++) expect((await s.get(path)).status).toBe(200);

      const blocked = await s.get(path);
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally { await s.close(); }
  });

  it('counts each rule separately, so publishing does not spend the generation budget', async () => {
    const s = await serve();
    try {
      for (let i = 0; i < RATE_RULES[0].limit; i++) await s.get('/projects/p1/generate-script');
      expect((await s.get('/projects/p1/generate-script')).status).toBe(429);
      // A different rule, untouched.
      expect((await s.get('/projects/p1/publish/youtube')).status).toBe(200);
    } finally { await s.close(); }
  });

  it('leaves ordinary reads uncapped', async () => {
    const s = await serve();
    try {
      for (let i = 0; i < 40; i++) expect((await s.get('/projects')).status).toBe(200);
    } finally { await s.close(); }
  });

  it('counts per caller, not globally', async () => {
    const a = await serve({ uid: 'user-a' });
    const b = await serve({ uid: 'user-b' });
    try {
      for (let i = 0; i < RATE_RULES[0].limit; i++) await a.get('/projects/p1/generate-script');
      expect((await a.get('/projects/p1/generate-script')).status).toBe(429);
      expect((await b.get('/projects/p1/generate-script')).status).toBe(200);
    } finally { await a.close(); await b.close(); }
  });
});

describe('CORS is scoped', () => {
  it('defaults to the local frontend rather than reflecting any origin', () => {
    const origins = allowedOrigins();
    expect(origins.length).toBeGreaterThan(0);
    expect(origins.every((o) => /^https?:\/\//.test(o))).toBe(true);
    expect(origins).not.toContain('*');
  });

  it('honours an explicit deployment origin list', () => {
    vi.stubEnv('CORS_ORIGINS', 'https://studio.example.com, https://admin.example.com');
    expect(allowedOrigins()).toEqual(['https://studio.example.com', 'https://admin.example.com']);
  });
});
