import * as fs from 'fs';
import * as path from 'path';
import { getFromCache, saveToCache } from './cacheService.js';
import { detectName } from './overlayTreatments.js';

/**
 * Sources a real brand asset for the entity a script actually names.
 *
 * The gap this closes is a content one, not a technical one: an episode entirely about
 * Playwright contained no Playwright anywhere — only generated abstractions of "testing".
 * The name-card detector already knows when a beat names a specific real tool, so this
 * hangs off that same detection rather than inventing a second one.
 *
 * ── Source
 *
 * Wikimedia Commons, and only Commons. It is the one image source that publishes a
 * machine-readable licence per file (`extmetadata`), which is the difference between
 * "this is probably fine" and a licence this code can actually read, check against a
 * policy, and store. It is free, needs no credentials, and its API is documented.
 *
 * Considered and rejected:
 *
 *   - General web/image search (Google, Bing, DuckDuckGo). Rejected outright: results
 *     carry no licence at all, so every use would be a guess. For a channel that intends
 *     to monetise, that is the one risk not worth taking.
 *   - Scraping company press kits / brand pages. Rejected: press-kit terms are prose on
 *     a page, differ per company, frequently forbid modification or require written
 *     permission, and cannot be checked programmatically. "Discoverable" is not the
 *     problem — "checkable" is.
 *   - GitHub raw assets from a project's own repo (e.g. playwright-logo.svg in
 *     microsoft/playwright). Tempting, because it is genuinely official. Rejected as a
 *     primary source: the repo LICENSE covers the source code, and a logo in a repo is
 *     usually a trademark the code licence deliberately does not grant. Commons carries
 *     the same Playwright file WITH an explicit per-file licence statement, so the
 *     safer route reaches the same asset.
 *   - Stock APIs (Unsplash, Pexels). Free, but they have brand logos only incidentally
 *     and their licences do not cover trademarked marks any better.
 *
 * ── What is NOT decided here
 *
 * Nothing about trademark law. A logo is nearly always trademarked, and Commons says so
 * (`Restrictions: trademarked` on most of them). Using a mark to refer to the actual
 * product it belongs to, in a video about that product, is nominative use and is not
 * what a copyright licence governs — so `trademarked` alone does not block a file here,
 * or the feature would reject every logo in existence and be pointless. Any OTHER
 * restriction does block it. This is a judgement call and it is written down rather than
 * buried.
 */

const API = 'https://commons.wikimedia.org/w/api.php';
/** Commons serves file bytes from upload.wikimedia.org. Nothing else is ever fetched. */
const ALLOWED_HOSTS = new Set(['commons.wikimedia.org', 'upload.wikimedia.org']);
const UA = 's2v-aistudio/1.0 (https://github.com/ideas4uai/s2v-aistudio) entity-image-sourcing';

export interface SourcedImage {
  entity: string;
  /** Commons file title, e.g. "File:Playwright Logo.svg". */
  title: string;
  descriptionUrl: string;
  /** Where the bytes came from — a rendered PNG, so SVG sources work unchanged. */
  fileUrl: string;
  licenseShortName: string;
  licenseUrl: string;
  artist: string;
  /** Read from the API's AttributionRequired field. Never inferred from the name. */
  attributionRequired: boolean;
  /** The exact credit to burn in, or '' when the licence requires none. */
  credit: string;
  localPath: string;
}

/**
 * Whether a sourced file is the kind of picture that can carry a whole frame.
 *
 * What this system searches for is a brand asset, and what Commons returns for a software
 * tool is almost always a logo. That is exactly right for the lower-third name-card it was
 * built to feed, and wrong for a cutaway: rendered on a real frame, "File:Playwright
 * Logo.svg" filled 1920x1080 with a near-black mark on a black field. It was correctly
 * sourced, correctly licensed and correctly credited, and it was a bad shot.
 *
 * So the cutaway asks this first. A name-card is unaffected — a logo is what it wants.
 *
 * ponytail: decided from the file title, which is what Commons reliably gives us and what
 * actually named the failing case. A logo whose title says nothing ("File:Pw-mark-2019.png")
 * would slip through. The upgrade, if a cutaway ever fires on one, is to look at the pixels
 * — a mark on a flat or transparent field has a huge near-uniform fraction where a
 * photograph has none — but that is a subprocess and a decoder for a path that should
 * almost never fire, and the wrong answer here costs one shot, not a licence breach.
 */
export function usableAsCutaway(image: { title?: string } | null | undefined): boolean {
  const title = String(image?.title || '');
  if (!title) return false;
  return !/\b(logo|logotype|wordmark|icon|favicon|emblem|symbol|badge|banner|seal|crest)\b|\.svg\b/i.test(title);
}

export interface RejectedImage {
  title: string;
  license: string;
  reason: string;
}

export interface SourcingOutcome {
  entity: string;
  image: SourcedImage | null;
  rejected: RejectedImage[];
  /** Why there is no image, when there is none. Always set in that case. */
  reason: string;
}

/**
 * Licences whose terms a burned-in credit line can genuinely satisfy.
 *
 * Permissive software licences are here because their obligation is to carry the notice,
 * and a visible credit naming the licensor and licence is that notice in a medium with
 * no other place to put one. Public domain and CC0 are here with no obligation at all.
 */
const SATISFIABLE: RegExp[] = [
  /^public domain/i, /^pd(-|$)/i, /^cc0/i,
  /^cc by[- ]?\d/i, /^cc by$/i,
  /apache/i, /^mit$/i, /^bsd/i, /^mpl/i, /mozilla public/i, /^isc$/i,
  /^unlicense$/i, /^zlib/i, /^wtfpl$/i, /^ofl/i, /open font/i,
];

/**
 * Licences that cannot be honoured by a credit line, with the actual reason. Checked
 * first, so a licence that is both permissive-looking and copyleft resolves as copyleft.
 *
 * ShareAlike is the important one and the reason this list exists at all: burning a
 * CC BY-SA image into a video is a strong argument that the video is a derivative, and
 * the licence would then require the whole video be released under CC BY-SA. That is a
 * real, ordinary licence term, and it is simply incompatible with a proprietary
 * monetised upload. No credit line fixes it, so the file is not used.
 */
const UNSATISFIABLE: { re: RegExp; reason: string }[] = [
  { re: /share[- ]?alike|by[- ]sa\b|(^|\s)sa[- ]\d/i,
    reason: 'ShareAlike: burning it in would require the whole video be released under the same licence' },
  { re: /no[- ]?deriv|by[- ]nd\b/i,
    reason: 'NoDerivatives: the image is scaled and composited, which is a derivative work' },
  { re: /\ba?gpl|lgpl|copyleft/i,
    reason: 'copyleft: the licence reaches the work it is combined into, which a credit line cannot satisfy' },
  { re: /non[- ]?commercial|by[- ]nc\b/i,
    reason: 'NonCommercial: the channel is monetised' },
  { re: /fair use|non[- ]?free|with permission|all rights reserved|copyrighted free use/i,
    reason: 'not a free licence — needs case-by-case permission this code cannot obtain' },
];

/**
 * Commons restriction tags. `trademarked` is expected on almost every logo and is not a
 * copyright licence term (see the header note); anything else is a real extra condition
 * on top of the licence and is treated as a rejection rather than guessed at.
 */
const ALLOWED_RESTRICTIONS = new Set(['', 'trademarked']);

/** extmetadata values are HTML fragments. Only the text is ever used. */
export function plainText(html: string): string {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, ' ').trim()
    // Commons markup often renders the same author twice (a link and a plain span),
    // which reaches a burned-in credit as "Unknown author Unknown author".
    .replace(/^(.+?)\s+\1$/, '$1');
}

/**
 * Whether a licence can be honoured with a burned-in credit, and why not when it cannot.
 *
 * An unrecognised licence is a rejection, not a pass. The instruction not to guess at a
 * licence has to mean something when the licence is one this table has never seen.
 */
export function licenceVerdict(shortName: string): { ok: boolean; reason: string } {
  const name = plainText(shortName);
  if (!name) return { ok: false, reason: 'no licence stated on the file' };
  for (const { re, reason } of UNSATISFIABLE) {
    if (re.test(name)) return { ok: false, reason };
  }
  if (SATISFIABLE.some((re) => re.test(name))) return { ok: true, reason: '' };
  return { ok: false, reason: `unrecognised licence "${name}" — not assumed to be usable` };
}

/**
 * The credit to burn in, or '' when none is required.
 *
 * `required` comes from the API's own AttributionRequired field, so a public-domain or
 * CC0 file adds no overlay and no clutter. When a credit IS required it names the file,
 * the author, the licence and the source — the four things CC BY asks for, which is the
 * strictest of the licences this accepts.
 */
export function creditLine(
  required: boolean, objectName: string, artist: string, license: string,
): string {
  if (!required) return '';
  const name = plainText(objectName);
  const who = plainText(artist);
  return [name && `"${name}"`, who, plainText(license), 'via Wikimedia Commons']
    .filter(Boolean).join(' · ');
}

/**
 * Normalised file title for matching, e.g. "File:Docker (container engine) logo.svg"
 * → "docker".
 *
 * This is the disambiguator, and it is doing real work: a plain search for "Playwright
 * logo" returns theatre organisations above the browser-automation tool, because the
 * word means something else entirely to most of the world. Ranking cannot be trusted;
 * an exact title match can. Parenthetical qualifiers and years are Commons' own
 * disambiguation habits and are stripped rather than treated as part of the name.
 */
export function normaliseTitle(title: string): string {
  return String(title || '')
    .replace(/^File:/i, '')
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/\b(?:logo|logotype|icon|wordmark|symbol|mark|emblem)\b/gi, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim().toLowerCase();
}

async function api(params: Record<string, string>, signal?: AbortSignal): Promise<any> {
  const url = `${API}?${new URLSearchParams({ ...params, action: 'query', format: 'json', origin: '*' })}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: signal ?? AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Commons API ${res.status}`);
  return res.json();
}

export interface Candidate {
  title: string;
  rank: number;
  license: string;
  licenseUrl: string;
  artist: string;
  objectName: string;
  restrictions: string;
  attributionRequired: boolean;
  thumbUrl: string;
  descriptionUrl: string;
  relevance: number;
}

/** Topic words worth matching on — the short ones match everything. */
const topicWords = (topic: string): string[] =>
  String(topic || '').toLowerCase().match(/[a-z]{4,}/g)?.slice(0, 12) ?? [];

async function searchCommons(entity: string, topic: string, signal?: AbortSignal): Promise<Candidate[]> {
  const d = await api({
    generator: 'search', gsrnamespace: '6', gsrsearch: `${entity} logo`, gsrlimit: '20',
    prop: 'imageinfo', iiprop: 'url|extmetadata|mime|size', iiurlwidth: '512',
  }, signal);
  const pages: any[] = Object.values(d?.query?.pages ?? {});
  const want = topicWords(topic);
  return pages.map((p) => {
    const ii = (p.imageinfo || [{}])[0];
    const em = ii.extmetadata || {};
    const get = (k: string) => String(em[k]?.value ?? '');
    const haystack = `${get('Categories')} ${get('ImageDescription')}`.toLowerCase();
    return {
      title: String(p.title || ''),
      rank: Number(p.index ?? 99),
      license: plainText(get('LicenseShortName')),
      licenseUrl: plainText(get('LicenseUrl')),
      artist: plainText(get('Artist')),
      objectName: plainText(get('ObjectName')) || normaliseTitle(String(p.title || '')),
      restrictions: plainText(get('Restrictions')).toLowerCase(),
      // The API states this outright. It is read, never inferred from the licence name.
      attributionRequired: get('AttributionRequired').toLowerCase() === 'true',
      thumbUrl: String(ii.thumburl || ''),
      descriptionUrl: String(ii.descriptionurl || ''),
      relevance: want.filter((w) => haystack.includes(w)).length,
      mime: String(ii.mime || ''),
    } as Candidate;
  });
}

/**
 * Candidates whose title says they really are this entity's mark, best first.
 *
 * Relevance is the tie-break, not the filter: the file's Commons categories and
 * description are matched against the project topic, so "Playwright" in a video about
 * testing prefers the file categorised under "Software testing" over one categorised
 * under theatre. It orders; the title match decides.
 */
export function rankCandidates(candidates: Candidate[], entity: string): Candidate[] {
  const want = normaliseTitle(entity);
  return candidates
    .filter((c) => normaliseTitle(c.title) === want)
    .sort((a, b) => (b.relevance - a.relevance) || (a.rank - b.rank));
}

async function download(url: string, dest: string, signal?: AbortSignal): Promise<void> {
  const host = new URL(url).hostname;
  if (!ALLOWED_HOSTS.has(host)) throw new Error(`refusing to fetch from ${host}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': UA }, signal: signal ?? AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) throw new Error(`file is ${buf.length} bytes — not an image`);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, buf);
}

/**
 * Find a safely-licensed image for one entity, or explain why there is none.
 *
 * Never throws. Every failure — no match, no acceptable licence, network down, Commons
 * rate-limiting the search — comes back as `image: null` with a reason, because the
 * caller's correct response to all of them is identical: render the AI imagery that
 * would have been rendered anyway.
 */
export async function sourceEntityImage(
  entity: string, topic = '', signal?: AbortSignal,
): Promise<SourcingOutcome> {
  const out: SourcingOutcome = { entity, image: null, rejected: [], reason: '' };
  if (!entity.trim()) { out.reason = 'no entity'; return out; }

  const cacheKey = `entity-${normaliseTitle(entity).replace(/\s+/g, '-') || 'x'}`;
  let candidates: Candidate[];
  try {
    candidates = rankCandidates(await searchCommons(entity, topic, signal), entity);
  } catch (err) {
    out.reason = `Commons lookup failed (${err instanceof Error ? err.message : err})`;
    return out;
  }
  if (!candidates.length) {
    out.reason = `no Commons file is titled as ${entity}'s logo`;
    return out;
  }

  for (const c of candidates) {
    const verdict = licenceVerdict(c.license);
    if (!verdict.ok) {
      out.rejected.push({ title: c.title, license: c.license, reason: verdict.reason });
      continue;
    }
    const bad = c.restrictions.split('|').map((r) => r.trim())
      .filter((r) => !ALLOWED_RESTRICTIONS.has(r));
    if (bad.length) {
      out.rejected.push({
        title: c.title, license: c.license,
        reason: `Commons restriction "${bad.join(', ')}" is a condition beyond the licence`,
      });
      continue;
    }
    if (!c.thumbUrl) {
      out.rejected.push({ title: c.title, license: c.license, reason: 'no rendered image available' });
      continue;
    }

    const cached = await getFromCache(cacheKey);
    let localPath = cached && fs.existsSync(cached) ? cached : '';
    if (!localPath) {
      const tmp = path.join(process.cwd(), 'temp', `${cacheKey}.png`);
      try {
        await download(c.thumbUrl, tmp, signal);
      } catch (err) {
        out.rejected.push({
          title: c.title, license: c.license,
          reason: `download failed (${err instanceof Error ? err.message : err})`,
        });
        continue;
      }
      await saveToCache(cacheKey, tmp);
      localPath = (await getFromCache(cacheKey)) || tmp;
    }

    out.image = {
      entity, title: c.title, descriptionUrl: c.descriptionUrl, fileUrl: c.thumbUrl,
      licenseShortName: c.license, licenseUrl: c.licenseUrl, artist: c.artist,
      attributionRequired: c.attributionRequired,
      credit: creditLine(c.attributionRequired, c.objectName, c.artist, c.license),
      localPath,
    };
    return out;
  }

  out.reason = `every candidate for ${entity} was rejected on licence grounds`;
  return out;
}

/**
 * The entity this project's script names, if any — asked of the same detector the
 * name-card treatment uses, over the same scenes, so the two can never disagree about
 * what the episode is about.
 */
export function projectEntity(project: any): string {
  const topic = String(project?.topic || '');
  for (const scene of (project?.scenes || [])) {
    const hit = detectName(String(scene?.narration_text || ''), topic);
    if (hit) return hit.name;
  }
  return '';
}

/** One lookup per project, even when three scenes start at once. */
const inFlight = new Map<string, Promise<SourcingOutcome | null>>();

/**
 * Resolve and attach this project's entity image. Idempotent, safe to call from every
 * scene, and it never blocks a render: on any failure the project simply has no entity
 * image and every treatment behaves exactly as it did before this file existed.
 */
export async function resolveEntityImage(project: any, signal?: AbortSignal): Promise<SourcingOutcome | null> {
  if (!project || project.entity_image !== undefined) return project?.entity_image ?? null;
  const id = String(project.project_id || project.id || '');
  let pending = inFlight.get(id);
  if (!pending) {
    pending = (async () => {
      const entity = projectEntity(project);
      if (!entity) return null;
      const outcome = await sourceEntityImage(entity, String(project.topic || ''), signal);
      if (outcome.image) {
        console.log(`[EntityImage] ${entity} → ${outcome.image.title} (${outcome.image.licenseShortName}, `
          + `attribution ${outcome.image.attributionRequired ? 'required' : 'not required'})`);
      } else {
        console.log(`[EntityImage] ${entity}: ${outcome.reason} — falling back to generated imagery`);
      }
      for (const r of outcome.rejected) console.log(`[EntityImage] rejected ${r.title} (${r.license}): ${r.reason}`);
      return outcome;
    })().catch((err) => {
      console.warn(`[EntityImage] lookup failed, using generated imagery: ${err?.message || err}`);
      return null;
    }).finally(() => inFlight.delete(id));
    inFlight.set(id, pending);
  }
  const result = await pending;
  // `null` is a resolved answer too — it stops every later scene retrying the lookup.
  project.entity_image = result;
  return result;
}
