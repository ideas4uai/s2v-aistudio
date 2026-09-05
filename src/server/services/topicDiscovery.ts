import { getChannel, type ChannelRecord } from './channelStore.js';
import { getAccessToken } from './youtubeService.js';

/**
 * Trending-topic discovery, scoped to one channel's own niche.
 *
 * Deliberately NOT YouTube's global "most popular" chart: that list is music videos and
 * film trailers in every region, and nothing on it tells this pipeline what to make. What
 * is useful is what is performing well right now *in the subject this channel already
 * covers*, which is a search question rather than a chart lookup.
 *
 * Two steps, because the niche has to come from somewhere:
 *   1. Seed terms  -- what is this channel about?
 *   2. search.list  -- what is doing well in that subject, recently?
 *
 * The seeds are data, never code. This file must not know that any particular channel
 * exists, in the same way and for the same reason scriptPrompt.ts refuses to name a brand:
 * a channel is configured, not special-cased. A channel whose seeds are unset falls back
 * to reading its own recent uploads, which is the honest default -- but see
 * `seedTerms` for why an explicit override exists and when it is the right answer.
 */

/** Only the readonly scope is needed. search.list and videos.list are both read paths. */
export const DISCOVERY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

/** How far back "trending" reaches. Long enough to have view counts, short enough to be news. */
export const WINDOW_DAYS = 30;

/** Candidates pulled per search before ranking. */
const MAX_RESULTS = 25;

/** Recent uploads read when deriving seeds from a channel's own history. */
const HISTORY_SIZE = 25;

/**
 * Words that carry no subject. Derived seeds are the channel's own titles, and without
 * this every channel's niche comes out as "the", "how" and "your".
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'nor', 'so', 'yet', 'of', 'to', 'in', 'on',
  'at', 'by', 'from', 'with', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'it', 'its', 'you', 'your', 'we', 'our', 'i', 'my',
  'he', 'she', 'they', 'them', 'his', 'her', 'their', 'what', 'why', 'how', 'when',
  'where', 'who', 'which', 'do', 'does', 'did', 'can', 'will', 'just', 'not', 'no',
  'new', 'best', 'top', 'video', 'videos', 'shorts', 'part', 'episode', 'ep', 'full',
  'vs', 'about', 'into', 'out', 'up', 'down', 'more', 'most', 'all', 'get', 'got',
  'make', 'makes', 'made', 'use', 'using', 'if', 'then', 'than', 'now', 'one', 'two',
]);

export interface TopicSuggestion {
  videoId: string;
  title: string;
  channelTitle: string;
  publishedAt: string;
  views: number;
  /** Days since publication, floored at a fraction of a day so velocity cannot divide by zero. */
  ageDays: number;
  /** Views per day since publication. The ranking signal — see rankByVelocity. */
  velocity: number;
  url: string;
}

export interface DiscoveryResult {
  channelId: string;
  /** The terms the search actually ran on, so the UI can show what it scoped to. */
  seeds: string[];
  /** 'configured' when the channel carries explicit keywords, 'history' when derived. */
  seedSource: 'configured' | 'history';
  windowDays: number;
  suggestions: TopicSuggestion[];
}

const ENTITIES: Record<string, string> = {
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', '39': "'", '34': '"',
};

/**
 * YouTube returns titles HTML-escaped, and the escapes tokenise into garbage.
 *
 * Measured on a real channel: "Samsung&#39;s Official Anti-reflecting(AR) Film" produced
 * the seed `#39`, and `&quot;` produces `quot`. Both went into the search query verbatim,
 * and a query carrying them returned zero results — the channel got no suggestions at all
 * because of an ampersand.
 */
export function decodeEntities(s: string): string {
  return String(s || '').replace(/&#?(\w+);/g, (whole, name: string) => {
    const key = String(name).toLowerCase();
    if (ENTITIES[key]) return ENTITIES[key];
    return /^\d+$/.test(key) ? String.fromCharCode(Number(key)) : whole;
  });
}

/**
 * Subject words in a set of titles, most frequent first.
 *
 * Pure and exported so the scoping rule is testable without a network: the thing worth
 * asserting is that two different channels' histories produce two different niches.
 */
export function termsFromTitles(titles: string[], limit = 6, brand = ''): string[] {
  // The channel's own name, as one token: "BwithTech" -> "bwithtech". Channels sign their
  // titles, so the brand is often the most frequent word in the history and goes straight
  // into the search — where it matches nothing, because no OTHER channel is about this
  // channel. Measured: dropping "bwithtech" from an otherwise identical six-term query
  // took it from 0 results to 10.
  //
  // Matched as the compact form only, deliberately. Stripping every word of the title
  // would cost "ai" and "learn" from a channel called "Learn AI with B", and those are
  // the subject, not the signature.
  const brandToken = brand.toLowerCase().replace(/[^a-z0-9]/g, '');
  const counts = new Map<string, number>();
  for (const t of titles) {
    // Split on anything that is not a word character, so "AI/ML" and "test-automation"
    // both break into their parts rather than becoming one unsearchable token.
    const words = decodeEntities(String(t || '')).toLowerCase().match(/[a-z0-9+#]{2,}/g) || [];
    for (const w of words) {
      if (STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
      // A leading # is a hashtag — "#shorts" is metadata about the upload, not what it is
      // about. Trailing # is kept, because "c#" and "f#" are subjects.
      if (w.startsWith('#')) continue;
      if (brandToken && w === brandToken) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  return [...counts.entries()]
    // Frequency first; alphabetical only to break ties, so the result is deterministic
    // and a test asserting an order is asserting something real.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([w]) => w);
}

/**
 * The terms this channel's discovery should search on.
 *
 * `topicKeywords` wins when set, and that is the whole reason the field exists: a channel
 * adding a NEW content type has a history that describes the old one. Deriving seeds from
 * past uploads would keep pulling discovery back toward the format being moved away from,
 * so a channel in that position states its subject explicitly instead.
 */
export function seedTerms(
  rec: Pick<ChannelRecord, 'topicKeywords' | 'title'>,
  recentTitles: string[] = [],
): { seeds: string[]; seedSource: 'configured' | 'history' } {
  const configured = (rec.topicKeywords || []).map((s) => String(s).trim()).filter(Boolean);
  if (configured.length) return { seeds: configured, seedSource: 'configured' };
  return { seeds: termsFromTitles(recentTitles, 6, rec.title || ''), seedSource: 'history' };
}

/**
 * Views per day since publication.
 *
 * Raw view count would rank a three-year-old video above everything published this month,
 * which is the opposite of trending. Dividing by age answers "how fast is this being
 * watched", and the publishedAfter window keeps the pool recent in the first place.
 */
export function rankByVelocity(items: TopicSuggestion[]): TopicSuggestion[] {
  return [...items].sort((a, b) => b.velocity - a.velocity);
}

/**
 * Whether a video is spoken in English.
 *
 * `relevanceLanguage: 'en'` on search.list is a ranking hint, not a filter. Measured on a
 * real channel, 9 of 25 suggestions came back in Hindi, Telugu or Tamil. The field that
 * says what is actually spoken is snippet.defaultAudioLanguage, and it arrives free in the
 * videos.list response already fetched for view counts -- no extra quota.
 *
 * NOT defaultLanguage, which describes the title and description rather than the audio:
 * every Telugu and Hindi video in that measured set declared defaultLanguage 'en'.
 *
 * Absent means keep. Roughly one video in 25 never sets the field, and discarding a video
 * for having incomplete metadata would drop English results to enforce an English filter.
 */
export function isEnglishAudio(defaultAudioLanguage?: string): boolean {
  const lang = String(defaultAudioLanguage || '').trim().toLowerCase();
  return !lang || lang === 'en' || lang.startsWith('en-');
}

/** Age in days, floored so a video published minutes ago cannot produce an infinite rate. */
export function ageInDays(publishedAt: string, now = Date.now()): number {
  const ms = now - new Date(publishedAt).getTime();
  return Math.max(ms / 86_400_000, 0.25);
}

async function api(path: string, params: Record<string, string>, token: string): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `${path} ${res.status}`);
  return json;
}

/** Titles of a channel's own recent uploads, used only when no seeds are configured. */
async function recentUploadTitles(channelId: string, token: string): Promise<string[]> {
  const json = await api('search', {
    part: 'snippet', channelId, order: 'date', type: 'video', maxResults: String(HISTORY_SIZE),
  }, token);
  return (json.items || []).map((i: any) => String(i?.snippet?.title || '')).filter(Boolean);
}

/**
 * What is performing well right now in this channel's subject.
 *
 * search.list gives titles but not statistics, so the view counts that make the ranking
 * meaningful come from a second videos.list call over the ids it returned. That is one
 * extra unit of quota against search.list's hundred, which is a trade worth making — a
 * list ordered by YouTube's own relevance with no numbers on it gives the user nothing
 * to judge by.
 */
export async function discoverTopics(
  channelId: string,
  opts: { now?: number } = {},
): Promise<DiscoveryResult> {
  const rec = getChannel(channelId);
  if (!rec) throw new Error(`Channel ${channelId} is not connected`);
  const token = await getAccessToken(channelId);

  let seeds: string[];
  let seedSource: 'configured' | 'history';
  const configured = seedTerms(rec);
  if (configured.seedSource === 'configured') {
    ({ seeds, seedSource } = configured);
  } else {
    ({ seeds, seedSource } = seedTerms(rec, await recentUploadTitles(channelId, token)));
  }
  if (!seeds.length) {
    return { channelId, seeds: [], seedSource, windowDays: WINDOW_DAYS, suggestions: [] };
  }

  const now = opts.now ?? Date.now();
  const publishedAfter = new Date(now - WINDOW_DAYS * 86_400_000).toISOString();
  const found = await api('search', {
    part: 'snippet', q: seeds.join(' '), type: 'video', order: 'viewCount',
    publishedAfter, maxResults: String(MAX_RESULTS), relevanceLanguage: 'en',
  }, token);

  const ids = (found.items || []).map((i: any) => i?.id?.videoId).filter(Boolean);
  if (!ids.length) {
    return { channelId, seeds, seedSource, windowDays: WINDOW_DAYS, suggestions: [] };
  }

  const stats = await api('videos', {
    part: 'snippet,statistics', id: ids.join(','), maxResults: String(MAX_RESULTS),
  }, token);

  const suggestions: TopicSuggestion[] = (stats.items || [])
    .filter((v: any) => isEnglishAudio(v?.snippet?.defaultAudioLanguage))
    .map((v: any) => {
      const publishedAt = String(v?.snippet?.publishedAt || new Date(now).toISOString());
      const views = Number(v?.statistics?.viewCount || 0);
      const ageDays = ageInDays(publishedAt, now);
      return {
        videoId: String(v?.id || ''),
        title: String(v?.snippet?.title || ''),
        channelTitle: String(v?.snippet?.channelTitle || ''),
        publishedAt,
        views,
        ageDays: Number(ageDays.toFixed(2)),
        velocity: Math.round(views / ageDays),
        url: `https://www.youtube.com/watch?v=${v?.id}`,
      };
    })
    .filter((s: TopicSuggestion) => s.videoId && s.title);

  return { channelId, seeds, seedSource, windowDays: WINDOW_DAYS, suggestions: rankByVelocity(suggestions) };
}
