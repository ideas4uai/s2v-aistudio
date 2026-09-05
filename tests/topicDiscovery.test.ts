import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { storePath } from '../src/server/services/channelStore.js';
import {
  termsFromTitles, seedTerms, rankByVelocity, ageInDays, discoverTopics, decodeEntities,
  isEnglishAudio, DISCOVERY_SCOPE, WINDOW_DAYS,
} from '../src/server/services/topicDiscovery.js';

/**
 * Trending-topic discovery, scoped per channel.
 *
 * The thing worth protecting here is that the scope is real: two channels covering
 * different subjects must search for different things. A discovery feature that returns
 * the same list to every channel is indistinguishable from a global trending chart, which
 * is exactly what this was built instead of.
 */

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

// Two histories standing in for two genuinely different niches.
const AI_EDU_TITLES = [
  'How transformers actually work', 'Fine-tuning an LLM on your own data',
  'What are embeddings? AI explained', 'Prompt engineering for beginners',
  'Build a RAG pipeline from scratch', 'LLM quantization explained',
];
const GENERAL_TECH_TITLES = [
  'My 2026 laptop setup tour', 'This budget phone surprised me',
  'Best mechanical keyboard under 100', 'Laptop cooling pad — worth it?',
  'Phone camera comparison shootout', 'Keyboard switches explained',
];

describe('seed terms describe the channel, not the language', () => {
  it('pulls the subject out of a channel history', () => {
    const t = termsFromTitles(AI_EDU_TITLES);
    expect(t).toContain('llm');
    // "how", "what", "your", "for" and "an" are all in these titles and none is a subject.
    for (const stop of ['how', 'what', 'your', 'for', 'an']) expect(t).not.toContain(stop);
  });

  it('gives two different channels two different niches', () => {
    const a = termsFromTitles(AI_EDU_TITLES);
    const b = termsFromTitles(GENERAL_TECH_TITLES);
    // The whole feature rests on this: no shared subject term between the two.
    expect(a.filter((w) => b.includes(w))).toEqual([]);
    expect(b).toContain('keyboard');
  });

  it('is deterministic, so an assertion about order means something', () => {
    expect(termsFromTitles(AI_EDU_TITLES)).toEqual(termsFromTitles([...AI_EDU_TITLES].reverse()));
  });

  it('ignores bare numbers, which are years and model sizes, not subjects', () => {
    expect(termsFromTitles(['2026 2026 2026 kubernetes'])).toEqual(['kubernetes']);
  });
});

/**
 * Three defects found by running this against real channels rather than fixtures. All
 * three produced a query that returned nothing, so the channel silently got no
 * suggestions at all. The titles below are verbatim from the YouTube API.
 */
describe('what the real API actually returns', () => {
  const REAL_TITLES = [
    'Samsung&#39;s Official Anti-reflecting(AR) Film on S26 Ultra — Watch Till The End 👀 #Shorts',
    'Samsung S26 Ultra Unboxing - A Power User&#39;s First look | BwithTech.',
  ];

  it('decodes the HTML escaping YouTube puts in titles', () => {
    expect(decodeEntities('Samsung&#39;s &quot;best&quot; &amp; fastest')).toBe('Samsung\'s "best" & fastest');
  });

  it('does not turn an apostrophe into the seed "#39"', () => {
    // &#39; tokenised to "#39", which went into the search verbatim.
    const t = termsFromTitles(REAL_TITLES, 6, 'BwithTech');
    expect(t).not.toContain('#39');
    expect(t).not.toContain('39');
    expect(t).toContain('samsung');
  });

  it('drops hashtags, which describe the upload rather than the subject', () => {
    expect(termsFromTitles(REAL_TITLES, 6, 'BwithTech')).not.toContain('#shorts');
    // A trailing # is a subject, not a hashtag, and must survive.
    expect(termsFromTitles(['C# tutorial', 'C# generics', 'C# async'])).toContain('c#');
  });

  it('drops the channel own brand, which no other channel is about', () => {
    // The measured failure: this one token took a six-term query from 10 results to 0,
    // because searching for your own brand finds only you.
    expect(termsFromTitles(REAL_TITLES, 6, 'BwithTech')).not.toContain('bwithtech');
  });

  it('drops only the compact brand, not ordinary words that appear in the name', () => {
    // "Learn AI with B" must keep "ai" and "learn" — they are the subject, not the
    // signature. Stripping every word of the channel title would cost both.
    const t = termsFromTitles(
      ['What is RAG? Stop AI Hallucinations!', '5 Free AI Tools | Learn AI with B'],
      6, 'Learn AI with B');
    expect(t).toContain('ai');
    expect(t).toContain('learn');
  });
});

describe('an explicit scope overrides the channel history', () => {
  // The case this exists for: a channel adding a content type its back catalogue does
  // not represent. Derived seeds would keep pulling discovery back to the old format.
  const sitcomHistory = [
    'The QA bot files its first bug — episode 4',
    'Episode 5: the standup goes wrong',
    'Episode 6: the intern ships on Friday',
  ];

  it('uses the configured terms and says so', () => {
    const out = seedTerms({ topicKeywords: ['test automation', 'qa engineering'] }, sitcomHistory);
    expect(out).toEqual({ seeds: ['test automation', 'qa engineering'], seedSource: 'configured' });
  });

  it('falls back to history when nothing is configured', () => {
    const out = seedTerms({}, sitcomHistory);
    expect(out.seedSource).toBe('history');
    expect(out.seeds).toContain('bug');
  });

  it('treats an empty or blank list as unset rather than as an empty search', () => {
    expect(seedTerms({ topicKeywords: [] }, sitcomHistory).seedSource).toBe('history');
    expect(seedTerms({ topicKeywords: ['   '] }, sitcomHistory).seedSource).toBe('history');
  });
});

describe('ranking is velocity, not raw views', () => {
  it('puts a fast recent video above a bigger older one', () => {
    const old = { videoId: 'a', title: 'old', channelTitle: '', publishedAt: '', views: 900_000, ageDays: 300, velocity: 3000, url: '' };
    const fresh = { videoId: 'b', title: 'fresh', channelTitle: '', publishedAt: '', views: 60_000, ageDays: 2, velocity: 30_000, url: '' };
    expect(rankByVelocity([old, fresh]).map((s) => s.videoId)).toEqual(['b', 'a']);
  });

  it('never divides by zero on a video published moments ago', () => {
    const now = Date.now();
    expect(ageInDays(new Date(now).toISOString(), now)).toBeGreaterThan(0);
    expect(Number.isFinite(1000 / ageInDays(new Date(now).toISOString(), now))).toBe(true);
  });
});

/** A request URL as prose: URLSearchParams writes a space as '+', which decode leaves. */
const readable = (url: string) => decodeURIComponent(url).replace(/\+/g, ' ');

/** Minimal stand-ins for the two API shapes discoverTopics reads. */
const searchPage = (ids: string[]) => ({ items: ids.map((id) => ({ id: { videoId: id } })) });
const videoPage = (rows: Array<[string, string, number, string, string?]>) => ({
  items: rows.map(([id, title, views, publishedAt, defaultAudioLanguage]) => ({
    id,
    snippet: { title, publishedAt, channelTitle: 'Someone', defaultAudioLanguage },
    statistics: { viewCount: String(views) },
  })),
});

/** Records every YouTube URL called, and answers each endpoint with canned data. */
function stubYouTube(history: string[], found: any, stats: any) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('oauth2.googleapis.com') || u.includes('/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) } as any;
    }
    if (u.includes('/search?') && u.includes('channelId=')) {
      return { ok: true, status: 200, json: async () => ({ items: history.map((t) => ({ snippet: { title: t } })) }) } as any;
    }
    if (u.includes('/search?')) return { ok: true, status: 200, json: async () => found } as any;
    if (u.includes('/videos?')) return { ok: true, status: 200, json: async () => stats } as any;
    return { ok: true, status: 200, json: async () => ({}) } as any;
  }));
  return calls;
}

describe('discoverTopics against a stubbed YouTube', () => {
  const CH = 'UC_test_channel_0000000';

  // getAccessToken refuses to run without OAuth config, and these tests are about the
  // discovery logic rather than the connection. The token exchange itself is stubbed.
  beforeEach(() => {
    vi.stubEnv('YOUTUBE_CLIENT_ID', 'test-client-id');
    vi.stubEnv('YOUTUBE_CLIENT_SECRET', 'test-client-secret');
  });

  /** A connected channel on disk, since discoverTopics resolves through the real store. */
  const connect = (topicKeywords?: string[]) => {
    const store = {
      version: 2,
      channels: {
        [CH]: {
          channelId: CH, title: 'Test', refreshToken: 'r',
          connectedAt: 'now', updatedAt: 'now', ...(topicKeywords ? { topicKeywords } : {}),
        },
      },
    };
    const p = storePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const prior = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    fs.writeFileSync(p, JSON.stringify(store));
    return () => { if (prior === null) fs.unlinkSync(p); else fs.writeFileSync(p, prior); };
  };

  it('searches the configured subject, inside the recency window, and ranks by velocity', async () => {
    const restore = connect(['test automation', 'qa engineering']);
    try {
      const now = Date.parse('2026-09-04T00:00:00Z');
      const calls = stubYouTube([], searchPage(['v1', 'v2']), videoPage([
        ['v1', 'Big but old', 1_000_000, '2026-08-06T00:00:00Z'],   // ~29d
        ['v2', 'Fast and new', 100_000, '2026-09-03T00:00:00Z'],    // ~1d
      ]));
      const out = await discoverTopics(CH, { now });

      expect(out.seedSource).toBe('configured');
      const search = readable(calls.find((c) => c.includes('/search?') && c.includes('order=viewCount'))!);
      expect(search).toContain('test automation qa engineering');
      // The window is what keeps this "trending" rather than "all time".
      expect(search).toContain(new Date(now - WINDOW_DAYS * 86_400_000).toISOString());
      // Statistics come from videos.list; search.list does not carry view counts.
      expect(calls.some((c) => c.includes('/videos?') && c.includes('statistics'))).toBe(true);
      expect(out.suggestions.map((s) => s.videoId)).toEqual(['v2', 'v1']);
      expect(out.suggestions[0].velocity).toBeGreaterThan(out.suggestions[1].velocity);
    } finally { restore(); }
  });

  it('derives the search from the channel own uploads when nothing is configured', async () => {
    const restore = connect();
    try {
      const calls = stubYouTube(AI_EDU_TITLES, searchPage(['v1']), videoPage([
        ['v1', 'Something', 10, '2026-09-01T00:00:00Z'],
      ]));
      const out = await discoverTopics(CH, { now: Date.parse('2026-09-04T00:00:00Z') });

      expect(out.seedSource).toBe('history');
      // It asked the channel for its own uploads before searching anything.
      expect(calls.some((c) => c.includes('channelId=') && c.includes('order=date'))).toBe(true);
      const search = readable(calls.find((c) => c.includes('order=viewCount'))!);
      expect(search).toContain('llm');
      expect(search).not.toContain('how');
    } finally { restore(); }
  });

  it('excludes non-English videos from discovery output', async () => {
    const restore = connect(['rag']);
    try {
      stubYouTube([], searchPage(['en1', 'hi1', 'te1', 'none1']), videoPage([
        ['en1', 'RAG explained', 100, '2026-09-01T00:00:00Z', 'en-US'],
        // Hindi audio under an English title and defaultLanguage 'en' -- the real shape
        // of the highest-velocity result this filter removes.
        ['hi1', 'Generative AI Full Course', 900, '2026-09-01T00:00:00Z', 'hi'],
        ['te1', 'RAG in Telugu', 800, '2026-09-01T00:00:00Z', 'te'],
        ['none1', 'AI Basics', 50, '2026-09-01T00:00:00Z', undefined],
      ]));
      const out = await discoverTopics(CH, { now: Date.parse('2026-09-04T00:00:00Z') });
      expect(out.suggestions.map((s) => s.videoId)).toEqual(['en1', 'none1']);
    } finally { restore(); }
  });

  it('returns nothing rather than searching for the empty string', async () => {
    const restore = connect();
    try {
      const calls = stubYouTube([], searchPage([]), videoPage([]));
      const out = await discoverTopics(CH, { now: Date.now() });
      expect(out.suggestions).toEqual([]);
      // A channel with no history and no configured scope must not run a bare search --
      // that returns global noise, which is the failure mode this feature exists to avoid.
      expect(calls.some((c) => c.includes('order=viewCount'))).toBe(false);
    } finally { restore(); }
  });
});

describe('English-only results', () => {
  // relevanceLanguage on search.list only nudges the ranking, so the language filter has
  // to happen here. These are the exact tags seen on real results.
  it('keeps English and its regional variants', () => {
    for (const tag of ['en', 'en-US', 'en-GB', 'en-IN', 'EN']) {
      expect(isEnglishAudio(tag)).toBe(true);
    }
  });

  it('drops the languages that were actually leaking in', () => {
    for (const tag of ['hi', 'te', 'ta']) expect(isEnglishAudio(tag)).toBe(false);
  });

  it('keeps a video that declares no audio language at all', () => {
    // About one in 25 leaves the field unset. Dropping those would remove English
    // results in the name of an English filter.
    expect(isEnglishAudio(undefined)).toBe(true);
    expect(isEnglishAudio('')).toBe(true);
  });
});

describe('scope', () => {
  it('needs only the readonly scope already granted for publishing', () => {
    expect(DISCOVERY_SCOPE).toBe('https://www.googleapis.com/auth/youtube.readonly');
    // The connection asks for this at consent time, so discovery adds no new consent.
    const src = fs.readFileSync('src/server/services/youtubeService.ts', 'utf8');
    expect(src).toContain(DISCOVERY_SCOPE);
  });
});
