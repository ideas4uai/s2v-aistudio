import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  licenceVerdict, creditLine, normaliseTitle, plainText, rankCandidates,
  sourceEntityImage, projectEntity, resolveEntityImage, Candidate,
} from '../src/services/entityImage.js';
import { planOverlay, overlayKey, sceneVisualKey } from '../src/services/overlayPlan.js';

// ── licence policy ─────────────────────────────────────────────────────────
describe('licence verdicts', () => {
  it('accepts what a burned-in credit can actually satisfy', () => {
    for (const l of ['Public domain', 'CC0', 'CC BY 4.0', 'Apache License 2.0', 'MIT',
                     'BSD', 'MPL 2', 'ISC', 'OFL 1.1']) {
      expect(licenceVerdict(l), l).toEqual({ ok: true, reason: '' });
    }
  });

  it('rejects ShareAlike, NoDerivatives, copyleft and NonCommercial with the real reason', () => {
    // These are the licences a credit line cannot honour, and each rejection names why.
    const cases: [string, RegExp][] = [
      ['CC BY-SA 4.0', /ShareAlike/],
      ['CC BY-SA 3.0', /ShareAlike/],
      ['CC BY-ND 4.0', /NoDerivatives/],
      ['GPL', /copyleft/],
      ['AGPL', /copyleft/],
      ['LGPL', /copyleft/],
      ['CC BY-NC 4.0', /NonCommercial/],
      ['Fair use', /not a free licence/],
      ['All rights reserved', /not a free licence/],
    ];
    for (const [l, why] of cases) {
      const v = licenceVerdict(l);
      expect(v.ok, l).toBe(false);
      expect(v.reason, l).toMatch(why);
    }
  });

  it('refuses to guess at a licence it has never seen', () => {
    // The instruction not to guess has to bind hardest exactly here.
    expect(licenceVerdict('Bespoke Museum Licence 1.4').ok).toBe(false);
    expect(licenceVerdict('Bespoke Museum Licence 1.4').reason).toMatch(/unrecognised/);
    expect(licenceVerdict('').ok).toBe(false);
  });

  it('reads licence text out of the API HTML, not around it', () => {
    expect(plainText('<a href="x" rel="nofollow">Microsoft</a>')).toBe('Microsoft');
    expect(plainText('Unknown author Unknown author')).toBe('Unknown author');
    expect(plainText('Tom &amp; Jerry&#39;s')).toBe("Tom & Jerry's");
    // A ShareAlike licence wrapped in markup is still ShareAlike.
    expect(licenceVerdict('<span>CC BY-SA 4.0</span>').ok).toBe(false);
  });
});

// ── attribution branching ──────────────────────────────────────────────────
describe('credit line', () => {
  it('is empty when the file says attribution is not required', () => {
    expect(creditLine(false, 'Selenium logo', 'Selenium', 'Public domain')).toBe('');
    expect(creditLine(false, 'X', 'Y', 'CC0')).toBe('');
  });

  it('names file, author, licence and source when it is required', () => {
    const c = creditLine(true, 'Playwright Logo', '<a>Microsoft</a>', 'Apache License 2.0');
    expect(c).toBe('"Playwright Logo" · Microsoft · Apache License 2.0 · via Wikimedia Commons');
  });

  it('drops the parts the file does not state rather than printing blanks', () => {
    expect(creditLine(true, '', '', 'CC BY 4.0')).toBe('CC BY 4.0 · via Wikimedia Commons');
  });
});

// ── disambiguation ─────────────────────────────────────────────────────────
describe('title matching', () => {
  it('strips the things Commons uses to disambiguate, not the name', () => {
    expect(normaliseTitle('File:Playwright Logo.svg')).toBe('playwright');
    expect(normaliseTitle('File:Docker (container engine) logo.svg')).toBe('docker');
    expect(normaliseTitle('File:OpenAI logo 2025 (wordmark).svg')).toBe('openai');
    expect(normaliseTitle("File:Playwrights' Center Logo 2015.jpg")).toBe('playwrights center');
  });

  it('keeps only files that really are this entity, best first', () => {
    // The real hazard: "Playwright" means theatre to most of the world, and a plain
    // Commons search ranks theatre organisations above the browser-automation tool.
    const c = (title: string, rank: number, relevance = 0) =>
      ({ title, rank, relevance } as Candidate);
    const ranked = rankCandidates([
      c('File:Logo ARGENTORES.jpg', 0),
      c("File:Playwrights' Center Logo 2015.jpg", 1),
      c('File:Playwright Logo.svg', 2, 2),
      c('File:WanderingPlaywright.png', 3),
      c('File:Playwright icon.png', 4, 0),
    ], 'Playwright');
    expect(ranked.map((r) => r.title)).toEqual(['File:Playwright Logo.svg', 'File:Playwright icon.png']);
  });
});

// ── sourcing outcomes, with the network stubbed ────────────────────────────
type Page = Record<string, any>;
const page = (title: string, license: string, attrib: boolean, over: Page = {}): Page => ({
  title, index: 0,
  imageinfo: [{
    thumburl: `https://upload.wikimedia.org/wikipedia/commons/thumb/x/${encodeURIComponent(title)}.png`,
    descriptionurl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`,
    mime: 'image/png',
    extmetadata: {
      LicenseShortName: { value: license },
      LicenseUrl: { value: 'https://example.invalid/licence' },
      AttributionRequired: { value: attrib ? 'true' : 'false' },
      Artist: { value: 'Someone' },
      ObjectName: { value: title.replace(/^File:|\.\w+$/g, '') },
      Categories: { value: 'Software testing' },
      ...over,
    },
  }],
});

/** A real 1x1 PNG, so the download path's size and decode checks run for real. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmM'
  + 'IQAAAABJRU5ErkJggg==', 'base64');
const bigPng = Buffer.concat([PNG, Buffer.alloc(2048)]);

const created: string[] = [];
const stubCommons = (pages: Page[]) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/w/api.php')) {
      return { ok: true, status: 200, json: async () => ({ query: { pages } }) } as any;
    }
    return { ok: true, status: 200, arrayBuffer: async () => bigPng } as any;
  }));
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const f of created.splice(0)) { try { fs.unlinkSync(f); } catch { /* gone */ } }
});

describe('sourcing outcomes', () => {
  it('stores the licence the API actually reported, and builds its credit', async () => {
    stubCommons([page('File:Zeta Logo.png', 'Apache License 2.0', true)]);
    const out = await sourceEntityImage('Zeta', 'Zeta software testing');
    expect(out.image).toBeTruthy();
    created.push(out.image!.localPath);
    expect(out.image!.licenseShortName).toBe('Apache License 2.0');
    expect(out.image!.attributionRequired).toBe(true);
    expect(out.image!.credit).toBe('"Zeta Logo" · Someone · Apache License 2.0 · via Wikimedia Commons');
    expect(fs.existsSync(out.image!.localPath)).toBe(true);
  });

  it('adds no credit when the file states attribution is not required', async () => {
    stubCommons([page('File:Eta Logo.png', 'Public domain', false)]);
    const out = await sourceEntityImage('Eta', 'Eta software testing');
    created.push(out.image!.localPath);
    expect(out.image!.attributionRequired).toBe(false);
    expect(out.image!.credit).toBe('');
  });

  it('declines a ShareAlike file and falls through to a usable one', async () => {
    // The rejection case that really happens: on Commons today, Grafana's logo files
    // are AGPL and CC BY-SA, and every one of them is refused.
    stubCommons([
      page('File:Theta Logo.svg', 'AGPL', true),
      page('File:Theta Logo.png', 'CC BY-SA 4.0', true),
      page('File:Theta logo.jpg', 'Public domain', false),
    ]);
    const out = await sourceEntityImage('Theta', 'Theta dashboards');
    created.push(out.image!.localPath);
    expect(out.rejected.map((r) => r.license)).toEqual(['AGPL', 'CC BY-SA 4.0']);
    expect(out.rejected[1].reason).toMatch(/ShareAlike/);
    expect(out.image!.licenseShortName).toBe('Public domain');
  });

  it('uses nothing at all when every candidate is licence-incompatible', async () => {
    stubCommons([
      page('File:Iota Logo.svg', 'AGPL', true),
      page('File:Iota logo.png', 'CC BY-SA 4.0', true),
    ]);
    const out = await sourceEntityImage('Iota', 'Iota dashboards');
    expect(out.image).toBeNull();
    expect(out.rejected).toHaveLength(2);
    expect(out.reason).toMatch(/rejected on licence grounds/);
  });

  it('refuses a Commons restriction beyond the licence, but not a plain trademark', async () => {
    stubCommons([page('File:Kappa logo.png', 'Public domain', false,
      { Restrictions: { value: 'insignia' } })]);
    const blocked = await sourceEntityImage('Kappa', 'Kappa');
    expect(blocked.image).toBeNull();
    expect(blocked.rejected[0].reason).toMatch(/insignia/);

    // Nearly every logo on Commons is tagged trademarked; refusing those would refuse
    // the entire feature, and a trademark is not what a copyright licence governs.
    stubCommons([page('File:Lambda logo.png', 'Public domain', false,
      { Restrictions: { value: 'trademarked' } })]);
    const ok = await sourceEntityImage('Lambda', 'Lambda');
    created.push(ok.image!.localPath);
    expect(ok.image).toBeTruthy();
  });

  it('falls back with a reason when nothing on Commons is this entity', async () => {
    stubCommons([page('File:Something Else.png', 'Public domain', false)]);
    const out = await sourceEntityImage('Zylthrax', 'Zylthrax the imaginary framework');
    expect(out.image).toBeNull();
    expect(out.reason).toMatch(/no Commons file is titled/);
  });

  it('never throws when Commons is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND'); }));
    const out = await sourceEntityImage('Playwright', 'Playwright testing');
    expect(out.image).toBeNull();
    expect(out.reason).toMatch(/lookup failed/);
  });

  it('refuses to fetch bytes from anywhere but Wikimedia', async () => {
    const evil = page('File:Mu logo.png', 'Public domain', false);
    evil.imageinfo[0].thumburl = 'https://images.example.invalid/mu.png';
    stubCommons([evil]);
    const out = await sourceEntityImage('Mu', 'Mu');
    expect(out.image).toBeNull();
    expect(out.rejected[0].reason).toMatch(/refusing to fetch/);
  });
});

// ── the detection hook ─────────────────────────────────────────────────────
const proj = (over: any = {}): any => ({
  project_id: 'p1', topic: 'Playwright AI agents for testing',
  scenes: [
    { scene_id: 's0', narration_text: 'Your tests break every release and someone fixes them by hand.',
      speech_start: 0.4, speech_end: 6.4, duration_actual: 7 },
    { scene_id: 's1', narration_text: 'The agents in Playwright watch a run and proposeated repair you review.',
      speech_start: 0.4, speech_end: 6.4, duration_actual: 7 },
    { scene_id: 's2', narration_text: 'Would you let an agent touch your suite?',
      speech_start: 0.4, speech_end: 6.4, duration_actual: 7 },
  ],
  ...over,
});

const sourced = (over: any = {}) => ({
  image: {
    entity: 'Playwright', title: 'File:Playwright Logo.svg', localPath: 'C:/cache/pw.png',
    licenseShortName: 'Apache License 2.0', attributionRequired: true,
    credit: '"Playwright Logo" · Microsoft · Apache License 2.0 · via Wikimedia Commons',
    ...over,
  },
  rejected: [], reason: '', entity: 'Playwright',
});

describe('entity detection reuses the name-card detector', () => {
  it('asks the same question the name card asks, over the same scenes', () => {
    expect(projectEntity(proj())).toBe('Playwright');
    expect(projectEntity({ topic: 'generic testing advice', scenes: proj().scenes })).toBe('');
    expect(projectEntity({ topic: 'x', scenes: [] })).toBe('');
  });

  it('does not look anything up for a project that names nothing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const p = { project_id: 'p9', topic: 'generic testing advice', scenes: proj().scenes };
    expect(await resolveEntityImage(p)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('looks up once however many scenes ask', async () => {
    stubCommons([page('File:Nu Logo.png', 'Public domain', false)]);
    const p: any = { project_id: 'p8', topic: 'Nu testing', scenes: [
      { scene_id: 's0', narration_text: 'a b c', speech_start: 0, speech_end: 1, duration_actual: 2 },
      { scene_id: 's1', narration_text: 'The team adopted Nu last year for testing.',
        speech_start: 0, speech_end: 3, duration_actual: 4 },
    ] };
    const [a, b, c] = await Promise.all([
      resolveEntityImage(p), resolveEntityImage(p), resolveEntityImage(p),
    ]);
    if (a?.image) created.push(a.image.localPath);
    expect(a).toBe(b);
    expect(b).toBe(c);
    // One search, one download — not three of each.
    expect((globalThis.fetch as any).mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe('the name card carries the sourced asset', () => {
  it('takes the logo and its credit when one was found', () => {
    const p = proj({ entity_image: sourced() });
    const spec = planOverlay(p.scenes[1], p, 7);
    expect(spec?.kind).toBe('namecard');
    expect(spec?.logoPath).toBe('C:/cache/pw.png');
    expect(spec?.credit).toMatch(/Apache License 2.0/);
  });

  it('carries no credit when the licence requires none', () => {
    const p = proj({ entity_image: sourced({ attributionRequired: false, credit: '' }) });
    const spec = planOverlay(p.scenes[1], p, 7);
    expect(spec?.logoPath).toBe('C:/cache/pw.png');
    expect(spec?.credit).toBeUndefined();
  });

  it('renders exactly as before when nothing was sourced', () => {
    for (const ei of [undefined, null, { image: null, rejected: [], reason: 'x', entity: 'Playwright' }]) {
      const p = proj({ entity_image: ei });
      const spec = planOverlay(p.scenes[1], p, 7);
      expect(spec?.kind).toBe('namecard');
      expect(spec?.logoPath).toBeUndefined();
      expect(spec?.credit).toBeUndefined();
    }
  });

  it('ignores an image sourced for a different entity', () => {
    const p = proj({ entity_image: sourced({ entity: 'Selenium' }) });
    expect(planOverlay(p.scenes[1], p, 7)?.logoPath).toBeUndefined();
  });
});

describe('staleness', () => {
  it('gives a scene with a sourced image a different clip key', () => {
    const bare = proj();
    const withLogo = proj({ entity_image: sourced() });
    const noCredit = proj({ entity_image: sourced({ attributionRequired: false, credit: '' }) });
    const other = proj({ entity_image: sourced({ localPath: 'C:/cache/other.png' }) });

    const key = (p: any) => sceneVisualKey(p.scenes[1], p, 7);
    // Four genuinely different frames, four different keys — a clip rendered before the
    // logo existed is not this scene's clip, and neither is one crediting another file.
    expect(new Set([key(bare), key(withLogo), key(noCredit), key(other)]).size).toBe(4);
  });

  it('keys on the credit text as well as the file', () => {
    const a = overlayKey(planOverlay(proj({ entity_image: sourced() }).scenes[1], proj({ entity_image: sourced() }), 7));
    const p2 = proj({ entity_image: sourced({ credit: '"X" · Y · CC BY 4.0 · via Wikimedia Commons' }) });
    expect(overlayKey(planOverlay(p2.scenes[1], p2, 7))).not.toBe(a);
  });
});

// ── Python side ────────────────────────────────────────────────────────────
const py = (snippet: string): string =>
  execFileSync('py', ['-c', snippet], { encoding: 'utf-8', timeout: 120_000 }).trim();

const HEAD = [
  'import sys; sys.path.insert(0, "src/scripts")',
  'import numpy as np, cv2, json, motion_overlay as mo',
  // A wide dark wordmark, the shape of the real sourced Playwright asset.
  'logo = np.zeros((80, 400, 4), np.uint8); logo[:, :, 3] = 255; logo[:, :, :3] = 40',
  'cv2.imwrite("temp/_t_logo.png", logo)',
].join('\n');

const spec = (over: string) =>
  `json.loads(r'''{"kind":"namecard","start":0.2,"end":3.4,"words":[],`
  + `"name":"Playwright","descriptor":"AIQA Engineer",${over}}''')`;

describe('attribution overlay', () => {
  it('draws nothing extra when no credit is required', () => {
    const out = py([HEAD,
      `a = mo.OverlayLayer(${spec('"logoPath":"temp/_t_logo.png"')}, 540, 960)`,
      `b = mo.OverlayLayer(${spec('"logoPath":"temp/_t_logo.png","credit":""')}, 540, 960)`,
      'print(len(a.credit_lines), len(b.credit_lines))',
    ].join('\n'));
    expect(out.trim().endsWith('0 0')).toBe(true);
  });

  it('draws the credit, bottom-right, small and quiet', () => {
    const out = py([HEAD,
      `lay = mo.OverlayLayer(${spec('"logoPath":"temp/_t_logo.png","credit":"\\"P\\" · Microsoft · Apache License 2.0 · via Wikimedia Commons"')}, 540, 960)`,
      'assert lay.ok',
      'bg = np.full((960, 540, 3), 90, np.uint8)',
      'f = lay.draw(bg.copy(), 1.6)',
      // In the bottom-right eighth of the frame, and nowhere near the top.
      'ys = [cy for _, _, cy in lay.credit_lines]; xs = [cx for _, cx, _ in lay.credit_lines]',
      'print(int(all(y > 960 * 0.9 for y in ys)), int(all(x > 540 * 0.5 for x in xs)),',
      '      int(len(lay.credit_lines) == 2),',
      // Quiet: the loudest credit pixel moves the frame far less than the card does.
      '      int(cv2.absdiff(f, bg)[int(960*0.92):, :].max() < cv2.absdiff(f, bg)[:int(960*0.9), :].max()))',
    ].join('\n'));
    expect(out.trim().endsWith('1 1 1 1')).toBe(true);
  });

  it('is a pure function of t, like every other overlay', () => {
    const out = py([HEAD,
      `s = ${spec('"logoPath":"temp/_t_logo.png","credit":"X · CC BY 4.0 · via Wikimedia Commons"')}`,
      'bg = lambda: np.full((960, 540, 3), 90, dtype=np.uint8)',
      'a = mo.OverlayLayer(s, 540, 960); cold = a.draw(bg(), 2.0)',
      'b = mo.OverlayLayer(s, 540, 960); [b.draw(bg(), i / 24.0) for i in range(48)]',
      'print(int(np.array_equal(cold, b.draw(bg(), 2.0))))',
    ].join('\n'));
    expect(out.trim().endsWith('1')).toBe(true);
  });

  it('appears only while the image it credits is on screen', () => {
    const out = py([HEAD,
      `lay = mo.OverlayLayer(${spec('"logoPath":"temp/_t_logo.png","credit":"X · CC BY 4.0"')}, 540, 960)`,
      'bg = lambda: np.full((960, 540, 3), 90, dtype=np.uint8)',
      'print(int(np.array_equal(lay.draw(bg(), 0.05), bg())),',
      '      int(np.array_equal(lay.draw(bg(), 3.9), bg())),',
      '      int(not np.array_equal(lay.draw(bg(), 1.6), bg())))',
    ].join('\n'));
    expect(out.trim().endsWith('1 1 1')).toBe(true);
  });

  it('survives a logo file that is missing or not an image', () => {
    // The card must still render — a broken asset is never allowed to cost the frame.
    const out = py([HEAD,
      'open("temp/_t_junk.png", "wb").write(b"not a png")',
      `a = mo.OverlayLayer(${spec('"logoPath":"temp/_does_not_exist.png"')}, 540, 960)`,
      `b = mo.OverlayLayer(${spec('"logoPath":"temp/_t_junk.png"')}, 540, 960)`,
      'bg = np.full((960, 540, 3), 90, np.uint8)',
      'print(int(a.ok), int(b.ok), int(not np.array_equal(a.draw(bg.copy(), 1.6), bg)))',
    ].join('\n'));
    expect(out.trim().endsWith('1 1 1')).toBe(true);
  });

  it('lifts a dark wordmark off the dark card instead of losing it', () => {
    const out = py([HEAD,
      `dark = mo.OverlayLayer(${spec('"logoPath":"temp/_t_logo.png"')}, 540, 960)`,
      'light = np.full((80, 400, 4), 240, np.uint8); light[:, :, 3] = 255',
      'cv2.imwrite("temp/_t_light.png", light)',
      `pale = mo.OverlayLayer(${spec('"logoPath":"temp/_t_light.png"')}, 540, 960)`,
      'print(int(mo._is_dark(mo._load_logo("temp/_t_logo.png", 40, 300))),',
      '      int(mo._is_dark(mo._load_logo("temp/_t_light.png", 40, 300))),',
      // The dark logo gets a light plate; the light one is left alone.
      '      int(dark.card[:, :, :3].max() > 230), int(pale.card[:, :, :3].mean() < 200))',
    ].join('\n'));
    expect(out.trim().endsWith('1 0 1 1')).toBe(true);
  });

  it('keeps the label clear of the logo and inside the card', () => {
    // Both were wrong on the first real render: the label ran over the logo and off the
    // right edge, because the size was chosen against the whole card width.
    const out = py([HEAD,
      `lay = mo.OverlayLayer(${spec('"logoPath":"temp/_t_logo.png"')}, 540, 960)`,
      `plain = mo.OverlayLayer(${spec('"logoPath":""')}, 540, 960)`,
      'logo = mo._load_logo("temp/_t_logo.png", int(960 * 0.062 * 0.62), int(540 * 0.24))',
      'x0, tw = lay.card_text_box',
      'print(int(lay.card.shape[1] == lay.card_w),',
      // Starts right of the logo, and the whole text area ends inside the card.
      '      int(x0 >= logo.shape[1]), int(x0 + tw <= lay.card_w),',
      // With no logo there is nothing to clear, so the text takes the card.
      '      int(plain.card_text_box[0] < x0))',
    ].join('\n'));
    expect(out.trim().endsWith('1 1 1 1')).toBe(true);
  });
});
