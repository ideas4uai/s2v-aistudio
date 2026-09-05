import type { Request, Response, NextFunction } from 'express';

/**
 * The two things standing between the open internet and this pipeline.
 *
 * ── What was wrong ─────────────────────────────────────────────────────────────
 * The /api middleware verified a bearer token and then called next() regardless of
 * the answer — including when verification returned null, and including when no
 * Authorization header arrived at all. There was no code path that returned 401. Nine
 * of twelve routers carry no authorization check of their own, so in production the
 * publish endpoint, the channel-disconnect endpoint and every generation trigger were
 * reachable by anyone who could reach the port. The server binds 0.0.0.0.
 *
 * ── Why the fix lives here and not in each router ──────────────────────────────
 * 91 routes across 12 routers. A guard per route is 91 chances to forget one, and the
 * one forgotten is the one that matters. Every request already passes through one
 * middleware; rejecting there covers all 91 and cannot be missed by a new route added
 * later. Routers keep their own ownership checks — those answer "which records may
 * THIS user touch", a different question from "is anyone there at all".
 */

/**
 * Paths under /api that must answer without a bearer token, and why each one must.
 *
 * Kept deliberately tiny and stated as exact paths rather than prefixes: a prefix
 * match is how an allowlist quietly grows to cover something it should not.
 */
export const PUBLIC_API_PATHS: ReadonlySet<string> = new Set([
  // Liveness. Called by deploy tooling that holds no credential.
  '/health',
  // The OAuth consent redirect. A browser follows it; there is no token to send yet.
  '/youtube/auth',
  // Where Google sends the operator back. Google attaches no Authorization header.
  // Not an open door: the callback consumes a single-use `state` value with a TTL,
  // so a request that did not start here cannot complete.
  '/youtube/callback',
]);

/** The path as the /api-mounted middleware sees it, whichever field carries it. */
function apiPath(req: Request): string {
  const raw = req.path || req.originalUrl || '';
  const noQuery = raw.split('?')[0];
  return noQuery.startsWith('/api/') ? noQuery.slice(4) : noQuery;
}

export function isPublicApiPath(req: Request): boolean {
  return PUBLIC_API_PATHS.has(apiPath(req));
}

/**
 * Rejects an unauthenticated request in production.
 *
 * Development is untouched on purpose. The local model this project runs on — one
 * operator, one machine, DISABLE_FIRESTORE, a `dev-user` identity stamped by the
 * caller above — is relied on by the ownership rules in ownership.ts and by every
 * verification script in this repo. Those all speak to a dev-mode server with no
 * credential. Requiring a token there would break the established local workflow
 * without protecting anything: a dev instance has no second user to protect from.
 */
export function requireAuthInProduction(req: Request, res: Response, next: NextFunction): void {
  if (process.env.NODE_ENV !== 'production') return next();
  if (isPublicApiPath(req)) return next();
  if ((req as any).user?.uid) return next();
  res.status(401).json({ error: 'Authentication required' });
}

/**
 * A fixed-window request cap, per identity, for the endpoints that cost money.
 *
 * Fixed window rather than a sliding log: the thing being prevented is a runaway loop
 * or a scripted abuser, and both are stopped just as well by a coarse window. A
 * sliding window would hold a timestamp array per caller to buy precision nobody here
 * needs.
 *
 * ponytail: in-process Map, so the counter is per server instance and resets on
 * restart. Correct for the single-instance deployment this runs as; move to a shared
 * store if this is ever load-balanced.
 */
type Rule = { limit: number; windowMs: number; match: RegExp };

/**
 * Generation is a person clicking a button, and 20 in five minutes is far past what a
 * person does. Topic discovery costs 100 YouTube quota units a call against a
 * 10,000/day allowance, so 15 an hour keeps a stuck UI from spending the day's budget.
 */
export const RATE_RULES: Rule[] = [
  { match: /^\/projects\/[^/]+\/(generate-script|pipeline\/run|render|scenes\/[^/]+\/(image|regenerate))/, limit: 20, windowMs: 5 * 60_000 },
  { match: /^\/projects\/[^/]+\/publish\//, limit: 10, windowMs: 60 * 60_000 },
  { match: /^\/youtube\/channels\/[^/]+\/topics/, limit: 15, windowMs: 60 * 60_000 },
];

const counters = new Map<string, { count: number; resetAt: number }>();

/** Identity to count against: the signed-in user, else the peer address. */
function callerKey(req: Request): string {
  return (req as any).user?.uid || req.ip || 'anonymous';
}

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const path = apiPath(req);
  const rule = RATE_RULES.find((r) => r.match.test(path));
  if (!rule) return next();

  const key = `${callerKey(req)}::${rule.match.source}`;
  const now = Date.now();
  const entry = counters.get(key);

  if (!entry || now >= entry.resetAt) {
    counters.set(key, { count: 1, resetAt: now + rule.windowMs });
    return next();
  }
  if (entry.count >= rule.limit) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      error: `Too many requests. Limit is ${rule.limit} per ${Math.round(rule.windowMs / 60_000)} minutes.`,
      retryAfterSeconds: retryAfter,
    });
    return;
  }
  entry.count++;
  next();
}

/** Test seam: forget every counter. Nothing in production calls this. */
export function resetRateLimits(): void {
  counters.clear();
}

/**
 * Which origins the browser app may call from.
 *
 * `cors()` with no argument reflects any origin and allows credentials, which means
 * any page the operator visits can call this API from their browser. The frontend is
 * one known origin; anything else has no reason to be calling.
 */
export function allowedOrigins(): string[] {
  const configured = (process.env.CORS_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (configured.length) return configured;
  const port = process.env.WEB_PORT || '3000';
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}
