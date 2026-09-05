import * as fs from 'fs';
import * as path from 'path';
import { Project } from '../models/project.js';
import { isSilentWav } from '../server/services/ttsService.js';
import { validateAssetConsistency } from './characterAssetService.js';
import { normalizeLanguage, languageName, captionsSupported } from '../utils/language.js';
import { isSilentBeat, silenceIsDeliberate } from '../utils/narration.js';

/**
 * Pre-publish quality gate.
 *
 * Replaces a score that was `50 + 20 + 30` — a number that looked like a measurement
 * and checked almost nothing. The point of this gate is to refuse to hand over a
 * broken video unattended, with a reason specific enough to act on.
 *
 * Every check reports one of three states, and the distinction matters:
 *   pass    — the check ran and the project satisfied it
 *   fail    — the check ran and found a real problem
 *   skipped — the check could not run (no applicable data, tooling unavailable)
 *
 * `skipped` is never silently folded into `pass`. A consistency check that cannot
 * run is not a video that passed consistency, and reporting it as such is exactly
 * the fake-green this gate exists to prevent.
 */

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface GateCheck {
  id: string;
  label: string;
  status: CheckStatus;
  /** One line, specific enough to act on: names the scene and what is wrong. */
  detail: string;
}

export interface QualityGateResult {
  passed: boolean;
  /** 0-100, derived from the checks that actually ran. Skipped checks do not score. */
  score: number;
  checks: GateCheck[];
  /** Human-readable reasons, empty when passed. */
  failures: string[];
  checkedAt: string;
}

/** A local file that exists and is bigger than a truncated/empty write. */
function realFile(p: unknown, minBytes = 1): boolean {
  if (typeof p !== 'string' || !p || /^https?:\/\//i.test(p)) return false;
  try { return fs.statSync(p).size >= minBytes; } catch { return false; }
}

/** Scene label a user can find in the editor: 1-based, matching display order. */
function sceneLabel(project: Project, sceneId: string): string {
  const ordered = [...(project.scenes || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const idx = ordered.findIndex((s) => s.scene_id === sceneId);
  return idx >= 0 ? `Scene ${idx + 1}` : `Scene ${sceneId.slice(0, 8)}`;
}

const pass = (id: string, label: string, detail: string): GateCheck =>
  ({ id, label, status: 'pass', detail });
const fail = (id: string, label: string, detail: string): GateCheck =>
  ({ id, label, status: 'fail', detail });
const skip = (id: string, label: string, detail: string): GateCheck =>
  ({ id, label, status: 'skipped', detail });

/** Every scene rendered a segment, so the stitched video contains all of them. */
function checkSceneCount(project: Project): GateCheck {
  const id = 'scene_count', label = 'All scenes present in the video';
  const scenes = project.scenes || [];
  if (scenes.length === 0) return fail(id, label, 'Project has no scenes.');

  const missing = scenes.filter((s) => !realFile((s as any).segment_path, 1000));
  if (missing.length) {
    const names = missing.map((s) => sceneLabel(project, s.scene_id)).join(', ');
    return fail(id, label,
      `${missing.length} of ${scenes.length} scenes produced no video segment: ${names}.`);
  }
  return pass(id, label, `All ${scenes.length} scenes produced a video segment.`);
}

function checkNoFailedScenes(project: Project): GateCheck {
  const id = 'no_failed_scenes', label = 'No scene failed to render';
  const scenes = project.scenes || [];
  const failed = scenes.filter((s) => s.status === 'failed');
  if (failed.length) {
    const detail = failed
      .map((s) => {
        const why = (s as any).error_log ? `: ${String((s as any).error_log).slice(0, 120)}` : '';
        return `${sceneLabel(project, s.scene_id)}${why}`;
      })
      .join('; ');
    return fail(id, label, `${failed.length} of ${scenes.length} scenes failed to render — ${detail}`);
  }
  const degraded = scenes.filter((s) => s.status === 'degraded');
  if (degraded.length) {
    const names = degraded.map((s) => sceneLabel(project, s.scene_id)).join(', ');
    return fail(id, label,
      `${degraded.length} scene(s) rendered in a degraded state (a fallback was used): ${names}.`);
  }
  return pass(id, label, `All ${scenes.length} scenes rendered cleanly.`);
}

/**
 * Narration exists and actually contains sound on every scene.
 *
 * Exported because automate mode runs this same check one step earlier, just
 * before the stitch, where a failure is still cheap to stop. Same function, so
 * the pre-render halt and the terminal gate can never disagree.
 */
export async function checkAudioPresent(project: Project): Promise<GateCheck> {
  const id = 'audio_present', label = 'Every scene has audible narration';
  const scenes = project.scenes || [];
  if (scenes.length === 0) return fail(id, label, 'Project has no scenes.');

  const problems: string[] = [];
  const silentAllowed = silenceIsDeliberate(scenes);
  let silentBeats = 0;
  for (const scene of scenes) {
    const p = (scene as any).narration_path;
    const where = sceneLabel(project, scene.scene_id);

    // A deliberately wordless beat has no narration by design. Counting it as missing
    // audio would fail the gate on the one thing the script prompt explicitly allows.
    if (silentAllowed && isSilentBeat(scene)) { silentBeats++; continue; }

    if (!realFile(p, 1000)) {
      problems.push(`${where} has no narration audio`);
      continue;
    }
    // Silence is the failure that survives every other check: the render succeeds,
    // the file exists, and the video ships mute.
    try {
      if (await isSilentWav(p)) problems.push(`${where} narration is silent`);
    } catch {
      problems.push(`${where} narration could not be read (${path.basename(String(p))})`);
    }
  }

  if (problems.length) return fail(id, label, problems.join('; ') + '.');
  return pass(id, label, silentBeats
    ? `All ${scenes.length - silentBeats} speaking scenes have audible narration (${silentBeats} silent beat${silentBeats > 1 ? 's' : ''}).`
    : `All ${scenes.length} scenes have audible narration.`);
}

function checkVisualPresent(project: Project): GateCheck {
  const id = 'visual_present', label = 'Every scene has a visual';
  const scenes = project.scenes || [];
  if (scenes.length === 0) return fail(id, label, 'Project has no scenes.');

  const missing = scenes.filter((s) => {
    const v: any = (s.visuals || [])[0] || {};
    return !realFile(v.rendered_path, 1000) && !realFile(v.asset_path, 1000)
      && !realFile((s as any).image_path, 1000);
  });
  if (missing.length) {
    const names = missing.map((s) => sceneLabel(project, s.scene_id)).join(', ');
    return fail(id, label, `${missing.length} scene(s) have no generated visual: ${names}.`);
  }
  return pass(id, label, `All ${scenes.length} scenes have a visual.`);
}

/**
 * How far a caption may sit from the speech it belongs to before the gate fails.
 *
 * Not the +/-100ms the caption-sync work established -- that tolerance is for two
 * measurements of the SAME instant agreeing. Captions whose per-word times come from
 * even division rather than forced alignment are legitimately up to ~0.47s out on a
 * clean scene, and failing those would fail correct renders.
 *
 * What this catches is the failure that actually shipped: captions laid out across
 * duration_actual instead of the speech span, so every cue after the first drifts
 * progressively later -- measured at 2.85s behind on a 6.58s scene. Half a second sits
 * above the honest even-division error and far below a real desync.
 */
export const CAPTION_DRIFT_TOLERANCE_SEC = Number(process.env.CAPTION_DRIFT_TOLERANCE_SEC ?? 0.5);

/**
 * Do the captions line up with the speech?
 *
 * Compares two numbers the render already measured -- the caption cue envelope against
 * detectSpeechSpan's speech_start/speech_end -- rather than re-deriving anything with
 * ffmpeg. The gate runs after every render and must stay cheap.
 *
 * Scenes without a measured span report nothing rather than passing: an older record
 * that predates the measurement is unchecked, not correct.
 */
export function checkCaptionSync(project: Project): GateCheck {
  const id = 'caption_sync', label = 'Captions match the speech';
  const scenes = project.scenes || [];

  // caption_chunks is what a rendered project actually persists -- `captions` is the
  // per-word array, populated in memory during the render and empty on every record on
  // disk. Reading only `captions` made this check skip every real project while passing
  // its fixtures, which is the same stage-gap failure the check exists to catch.
  const cuesOf = (s: any): Array<{ start: number; end: number }> => {
    const raw = (s.captions?.length ? s.captions : s.caption_chunks) || [];
    return raw
      .map((c: any) => ({ start: Number(c.start), end: Number(c.end) }))
      .filter((c: any) => Number.isFinite(c.start) && Number.isFinite(c.end));
  };

  const measurable = scenes.filter((s: any) =>
    cuesOf(s).length > 0 && Number(s.speech_end) > Number(s.speech_start));
  if (!measurable.length) {
    // Distinguish "captions were deliberately left off" from "something went wrong".
    // The first is a decision the operator was told about; the second needs looking at.
    const unavailable = (project as any).captions_unavailable;
    if (unavailable) return skip(id, label, unavailable.reason);
    if (!captionsSupported((project as any).settings?.language)) {
      return skip(id, label, 'Captions are not rendered for this language — nothing to sync.');
    }
    return skip(id, label, 'No scene carries both caption cues and a measured speech span.');
  }

  let worst = { drift: 0, sceneId: '', where: '' };
  const offenders: string[] = [];
  for (const s of measurable as any[]) {
    const cues = cuesOf(s);
    const firstCue = Math.min(...cues.map((c) => c.start));
    const lastCue = Math.max(...cues.map((c) => c.end));
    const startDrift = Math.abs(firstCue - Number(s.speech_start));
    const endDrift = Math.abs(lastCue - Number(s.speech_end));

    for (const [drift, where] of [[startDrift, 'start'], [endDrift, 'end']] as const) {
      if (drift > worst.drift) worst = { drift, sceneId: s.scene_id, where };
    }
    if (Math.max(startDrift, endDrift) > CAPTION_DRIFT_TOLERANCE_SEC) {
      offenders.push(`${sceneLabel(project, s.scene_id)} (${Math.max(startDrift, endDrift).toFixed(2)}s)`);
    }
  }

  if (offenders.length) {
    return fail(id, label,
      `Captions drift from the speech by more than ${CAPTION_DRIFT_TOLERANCE_SEC}s in `
      + `${offenders.length} scene(s): ${offenders.join(', ')}.`);
  }
  return pass(id, label,
    `Worst drift ${worst.drift.toFixed(2)}s across ${measurable.length} scene(s), `
    + `within ${CAPTION_DRIFT_TOLERANCE_SEC}s.`);
}

/**
 * Share of a string's letters that belong to one Unicode script.
 *
 * Denominator counts marks as well as letters. Telugu and Devanagari write vowels and
 * the virama as combining marks, which are \p{M} and not \p{L} but ARE inside the
 * script's block -- so a letters-only denominator is smaller than the numerator and a
 * real Telugu script measured 169%.
 */
function scriptShare(text: string, pattern: RegExp): number {
  const glyphs = (text.match(/[\p{L}\p{M}]/gu) || []).length;
  if (!glyphs) return 0;
  return Math.min(1, (text.match(pattern) || []).length / glyphs);
}

/** The scripts each supported language is actually written in. */
const LANGUAGE_SCRIPT: Record<string, RegExp> = {
  en: /[A-Za-z]/g,
  te: /[\u0C00-\u0C7F]/g,
  hi: /[\u0900-\u097F]/g,
};

/**
 * Minimum share of letters that must be in the expected script.
 *
 * Not 1.0, and not close to it: a correct Telugu script legitimately keeps product and
 * company names in Latin -- a real generated one measured 793 Telugu characters to 8
 * Latin ("AI"). Half is far above what borrowed nouns produce and far below what a
 * script written in the wrong language entirely would score.
 */
export const LANGUAGE_MATCH_THRESHOLD = 0.5;

/**
 * Is the narration in the language that was asked for?
 *
 * This is the check that would have caught the bug it was written for. The scriptwriter
 * had no language field, so a Telugu project got an English script, and Piper read
 * English words through Telugu phonemes. Every existing check passed: the WAV was valid
 * and not silent, so audio was "present" and the render "completed". The video was
 * unintelligible and shipped as a success.
 *
 * Script share, not a language-detection model: the failure being caught is an entire
 * script in the wrong writing system, which is unambiguous from the characters alone
 * and needs no dependency to see.
 */
export function checkLanguageMatch(project: Project): GateCheck {
  const id = 'language_match', label = 'Narration is in the selected language';
  const code = normalizeLanguage((project as any).settings?.language);
  const scenes = project.scenes || [];

  if (!code) return skip(id, label, 'No language selected for this project.');
  const pattern = LANGUAGE_SCRIPT[code];
  if (!pattern) return skip(id, label, `No script rule for "${code}".`);

  const spoken = scenes.map((s: any) => String(s.narration_text || '')).join(' ').trim();
  if (!spoken) return skip(id, label, 'No narration to check.');

  const share = scriptShare(spoken, pattern);
  const name = languageName(code);
  if (share < LANGUAGE_MATCH_THRESHOLD) {
    return fail(id, label,
      `Project is set to ${name}, but only ${Math.round(share * 100)}% of the narration is `
      + `written in ${name}'s script. The voice model will read it phonetically and the `
      + `result will not be intelligible.`);
  }
  return pass(id, label, `${Math.round(share * 100)}% of the narration is in ${name}'s script.`);
}

/**
 * Character appearance drift, using the existing LAB skin-tone validator.
 *
 * Only meaningful where a scene depicts a named character AND that character has a
 * reference image to compare against. Narrator-only projects — the standard
 * educational flow — have neither, so this reports `skipped`, not `pass`.
 *
 * validateAssetConsistency deliberately fails open (it returns passed:true when the
 * Python validator cannot run) because it was written to avoid blocking asset
 * generation. That behaviour is wrong for a gate, so anything that is not a genuine
 * comparison is counted as unchecked rather than as a pass.
 */
function checkCharacterConsistency(project: Project): GateCheck {
  const id = 'character_consistency', label = 'Character appearance is consistent';
  const scenes = project.scenes || [];
  const characters: any[] = (project as any).universe?.characters || [];

  if (characters.length === 0) {
    return skip(id, label, 'No characters in this project — nothing to compare.');
  }

  const comparisons: { where: string; deltaE: number; ok: boolean }[] = [];
  for (const scene of scenes) {
    const name = String((scene as any).character || '').toUpperCase();
    if (!name || name === 'NARRATOR') continue;

    const character = characters.find((c: any) => String(c.name).toUpperCase() === name);
    const reference = character?.referenceImageUrl;
    const asset = ((scene.visuals || [])[0] as any)?.asset_path;
    if (!realFile(reference) || !realFile(asset)) continue;

    const { passed, deltaE, ran } = validateAssetConsistency(asset, reference);
    // `ran` distinguishes a real comparison from the wrapper's fail-open bail-out.
    // Inferring it from deltaE === 0 was wrong: an exact match scores 0 too.
    if (!ran) continue;
    comparisons.push({ where: `${sceneLabel(project, scene.scene_id)} (${name})`, deltaE, ok: passed });
  }

  if (comparisons.length === 0) {
    return skip(id, label,
      'No scene had both a named character and a usable reference image to compare against.');
  }
  const drifted = comparisons.filter((c) => !c.ok);
  if (drifted.length) {
    const detail = drifted.map((c) => `${c.where} deltaE ${c.deltaE.toFixed(1)}`).join('; ');
    return fail(id, label,
      `${drifted.length} of ${comparisons.length} character shots drifted from the reference — ${detail}.`);
  }
  return pass(id, label, `${comparisons.length} character shot(s) matched their reference.`);
}

/**
 * Runs every gate check. Async only because reading audio samples is.
 */
export async function runQualityGate(project?: Project): Promise<QualityGateResult> {
  const checkedAt = new Date().toISOString();
  if (!project || !project.scenes) {
    return {
      passed: false, score: 0, checkedAt,
      checks: [fail('project', 'Project is renderable', 'No project or no scenes to check.')],
      failures: ['No project or no scenes to check.'],
    };
  }

  const checks: GateCheck[] = [
    checkSceneCount(project),
    checkNoFailedScenes(project),
    await checkAudioPresent(project),
    checkVisualPresent(project),
    checkCharacterConsistency(project),
    // The two silent-pass cases: a video in the wrong language and captions against
    // the wrong window both used to complete as successes.
    checkLanguageMatch(project),
    checkCaptionSync(project),
  ];

  const failures = checks.filter((c) => c.status === 'fail').map((c) => c.detail);
  const ran = checks.filter((c) => c.status !== 'skipped');
  const passedCount = ran.filter((c) => c.status === 'pass').length;
  // Skipped checks are excluded from the denominator: a project cannot score higher
  // by having fewer checks apply to it, nor be punished for them.
  const score = ran.length === 0 ? 0 : Math.round((passedCount / ran.length) * 100);

  return { passed: failures.length === 0, score, checks, failures, checkedAt };
}

/**
 * Backwards-compatible score for callers that only want the number.
 * The gate itself is what decides publishability — see runQualityGate.
 */
export const calculateQualityScore = async (project?: Project): Promise<number> =>
  (await runQualityGate(project)).score;
