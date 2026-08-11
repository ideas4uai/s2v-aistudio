import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';
import { generateAudioHash } from '../../utils/hash.js';
import { sidecarRequest } from './ttsSidecar.js';
import { getVoiceForUser, recordUse } from './voiceRegistry.js';

const execAsync = promisify(exec);

/**
 * Kokoro-82M's full voice roster, from the model card's VOICES.md.
 * https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md
 *
 * License: Apache-2.0, stated on the model card ("With Apache-licensed weights,
 * Kokoro can be deployed anywhere from production environments to personal
 * projects"). Unambiguously fine for a monetised channel — which is why it, and
 * not XTTS, is the default.
 *
 * The full roster is listed rather than only the voices the UI offers, because it
 * doubles as the validity check: a voice name that is not in here does not exist,
 * and asking Kokoro for it would yield a broken or empty track. `grade` is the model
 * card's own quality rating and drives the default ordering in the picker.
 */
export const KOKORO_VOICES: Record<string, { lang: string; grade: string; label: string }> = {
  // American English
  af_heart:   { lang: 'english', grade: 'A',  label: 'Heart — American female' },
  af_bella:   { lang: 'english', grade: 'A-', label: 'Bella — American female' },
  af_nicole:  { lang: 'english', grade: 'B-', label: 'Nicole — American female, soft' },
  af_aoede:   { lang: 'english', grade: 'C+', label: 'Aoede — American female' },
  af_kore:    { lang: 'english', grade: 'C+', label: 'Kore — American female' },
  af_sarah:   { lang: 'english', grade: 'C+', label: 'Sarah — American female' },
  af_alloy:   { lang: 'english', grade: 'C',  label: 'Alloy — American female' },
  af_nova:    { lang: 'english', grade: 'C',  label: 'Nova — American female' },
  af_sky:     { lang: 'english', grade: 'C-', label: 'Sky — American female' },
  af_jessica: { lang: 'english', grade: 'D',  label: 'Jessica — American female' },
  af_river:   { lang: 'english', grade: 'D',  label: 'River — American female' },
  am_fenrir:  { lang: 'english', grade: 'C+', label: 'Fenrir — American male, deep' },
  am_michael: { lang: 'english', grade: 'C+', label: 'Michael — American male' },
  am_puck:    { lang: 'english', grade: 'C+', label: 'Puck — American male, bright' },
  am_echo:    { lang: 'english', grade: 'D',  label: 'Echo — American male' },
  am_eric:    { lang: 'english', grade: 'D',  label: 'Eric — American male' },
  am_liam:    { lang: 'english', grade: 'D',  label: 'Liam — American male' },
  am_onyx:    { lang: 'english', grade: 'D',  label: 'Onyx — American male, low' },
  am_adam:    { lang: 'english', grade: 'F+', label: 'Adam — American male' },
  am_santa:   { lang: 'english', grade: 'D-', label: 'Santa — American male, character' },
  // British English
  bf_emma:     { lang: 'english', grade: 'B-', label: 'Emma — British female' },
  bf_isabella: { lang: 'english', grade: 'C',  label: 'Isabella — British female' },
  bm_fable:    { lang: 'english', grade: 'C',  label: 'Fable — British male' },
  bm_george:   { lang: 'english', grade: 'C',  label: 'George — British male' },
  bf_alice:    { lang: 'english', grade: 'D',  label: 'Alice — British female' },
  bf_lily:     { lang: 'english', grade: 'D',  label: 'Lily — British female' },
  bm_daniel:   { lang: 'english', grade: 'D',  label: 'Daniel — British male' },
  bm_lewis:    { lang: 'english', grade: 'D+', label: 'Lewis — British male' },
  // Hindi
  hf_alpha: { lang: 'hindi', grade: 'C', label: 'Alpha — Hindi female' },
  hf_beta:  { lang: 'hindi', grade: 'C', label: 'Beta — Hindi female' },
  hm_omega: { lang: 'hindi', grade: 'C', label: 'Omega — Hindi male' },
  hm_psi:   { lang: 'hindi', grade: 'C', label: 'Psi — Hindi male' },
  // Spanish
  ef_dora:  { lang: 'spanish', grade: '',  label: 'Dora — Spanish female' },
  em_alex:  { lang: 'spanish', grade: '',  label: 'Alex — Spanish male' },
  em_santa: { lang: 'spanish', grade: '',  label: 'Santa — Spanish male, character' },
  // French / Italian / Portuguese / Japanese / Mandarin
  ff_siwis:      { lang: 'french',     grade: 'B-', label: 'Siwis — French female' },
  if_sara:       { lang: 'italian',    grade: 'C',  label: 'Sara — Italian female' },
  im_nicola:     { lang: 'italian',    grade: 'C',  label: 'Nicola — Italian male' },
  pf_dora:       { lang: 'portuguese', grade: '',   label: 'Dora — Brazilian Portuguese female' },
  pm_alex:       { lang: 'portuguese', grade: '',   label: 'Alex — Brazilian Portuguese male' },
  pm_santa:      { lang: 'portuguese', grade: '',   label: 'Santa — Brazilian Portuguese male' },
  jf_alpha:      { lang: 'japanese',   grade: 'C+', label: 'Alpha — Japanese female' },
  jf_gongitsune: { lang: 'japanese',   grade: 'C',  label: 'Gongitsune — Japanese female' },
  jf_tebukuro:   { lang: 'japanese',   grade: 'C',  label: 'Tebukuro — Japanese female' },
  jf_nezumi:     { lang: 'japanese',   grade: 'C-', label: 'Nezumi — Japanese female' },
  jm_kumo:       { lang: 'japanese',   grade: 'C-', label: 'Kumo — Japanese male' },
  zf_xiaobei:    { lang: 'mandarin',   grade: 'D',  label: 'Xiaobei — Mandarin female' },
  zf_xiaoni:     { lang: 'mandarin',   grade: 'D',  label: 'Xiaoni — Mandarin female' },
  zf_xiaoxiao:   { lang: 'mandarin',   grade: 'D',  label: 'Xiaoxiao — Mandarin female' },
  zf_xiaoyi:     { lang: 'mandarin',   grade: 'D',  label: 'Xiaoyi — Mandarin female' },
  zm_yunjian:    { lang: 'mandarin',   grade: 'D',  label: 'Yunjian — Mandarin male' },
  zm_yunxi:      { lang: 'mandarin',   grade: 'D',  label: 'Yunxi — Mandarin male' },
  zm_yunxia:     { lang: 'mandarin',   grade: 'D',  label: 'Yunxia — Mandarin male' },
  zm_yunyang:    { lang: 'mandarin',   grade: 'D',  label: 'Yunyang — Mandarin male' },
};

export type TtsEngine = 'kokoro' | 'piper';

/** Kokoro has no Telugu voice — that language can only be served by Piper. This is
 *  the one place the engine choice is made for the user rather than by them. */
export const KOKORO_LANGUAGES = new Set(Object.values(KOKORO_VOICES).map((v) => v.lang));

// Each entry carries a voice for both engines so that switching engines changes how
// a character sounds, never who they are. `piper` values are unchanged from the
// Piper-only implementation, so selecting the offline engine reproduces the old
// output exactly.
type VoiceSpec = { kokoro: string; piper: string; speed: number; noise: number };

// Character voices win over voiceStyle — story episodes cast specific characters
// and must sound the same regardless of the project's narration style setting.
const CHARACTER_VOICES: Record<string, VoiceSpec> = {
  'VEER':     { kokoro: 'am_fenrir',  piper: 'en_US-ryan-high',           speed: 0.92, noise: 0.2  },
  'VEER_ALT': { kokoro: 'am_michael', piper: 'en_US-reza_ibrahim-medium', speed: 0.90, noise: 0.2  },
  'BYTE':     { kokoro: 'am_puck',    piper: 'en_US-joe-medium',          speed: 1.15, noise: 0.4  },
  'NOVA':     { kokoro: 'bf_emma',    piper: 'en_GB-alba-medium',         speed: 0.85, noise: 0.1  },
  'NARRATOR': { kokoro: 'af_heart',   piper: 'en_US-lessac-medium',       speed: 0.95, noise: 0.2  },
  'MIRA':     { kokoro: 'af_bella',   piper: 'en_US-lessac-medium',       speed: 0.88, noise: 0.2  },
  'BIAS':     { kokoro: 'am_michael', piper: 'en_US-lessac-medium',       speed: 0.92, noise: 0.15 },
  'NULL':     { kokoro: 'am_onyx',    piper: 'en_US-lessac-medium',       speed: 0.75, noise: 0.05 },
};

// project.settings.voiceStyle — drives the narrator/default voice only.
// 'professional' is byte-identical to NARRATOR so existing projects don't shift.
const STYLE_VOICES: Record<string, VoiceSpec> = {
  'professional': { kokoro: 'af_heart',   piper: 'en_US-lessac-medium', speed: 0.95, noise: 0.2  },
  'energetic':    { kokoro: 'af_bella',   piper: 'en_US-joe-medium',    speed: 1.15, noise: 0.4  },
  'dramatic':     { kokoro: 'am_fenrir',  piper: 'en_US-ryan-high',     speed: 0.82, noise: 0.5  },
  'casual':       { kokoro: 'am_puck',    piper: 'en_US-joe-medium',    speed: 1.02, noise: 0.3  },
  'calm':         { kokoro: 'bf_emma',    piper: 'en_GB-alba-medium',   speed: 0.88, noise: 0.15 },
};

/**
 * Splits a voiceStyle value into an engine override and the style itself.
 *
 * Accepted forms, all of which reach here from the Voice Style dropdown:
 *   'professional'      legacy value — engine comes from TTS_ENGINE (Kokoro)
 *   'piper:professional' explicit offline engine, same style
 *   'kokoro:af_bella'   a specific Kokoro voice, bypassing the style table
 */
export function parseVoiceStyle(voiceStyle?: string): { engine?: TtsEngine; value: string } {
  const raw = (voiceStyle ?? '').trim();
  const m = /^(kokoro|piper):(.*)$/i.exec(raw);
  if (!m) return { value: raw.toLowerCase() };
  return { engine: m[1].toLowerCase() as TtsEngine, value: m[2].toLowerCase() };
}

export const DEFAULT_ENGINE: TtsEngine =
  process.env.TTS_ENGINE === 'piper' ? 'piper' : 'kokoro';

export function resolveVoiceProfile(character?: string, voiceStyle?: string) {
  const { engine: engineOverride, value: style } = parseVoiceStyle(voiceStyle);

  // NARRATOR is the placeholder every classic project gets, not a cast member
  // anyone chose — so it must NOT short-circuit voiceStyle, or the Voice Style
  // dropdown is inert on exactly the projects it exists for. Only an explicitly
  // cast character outranks it.
  const cast = character?.toUpperCase() ?? '';
  const castSpec = cast !== 'NARRATOR' ? CHARACTER_VOICES[cast] : undefined;

  // 'kokoro:af_bella' names a voice directly. It still borrows the narrator's
  // speed/noise so the delivery matches the rest of the system.
  const direct = engineOverride === 'kokoro' && KOKORO_VOICES[style] ? style : undefined;

  const spec = castSpec ?? STYLE_VOICES[style] ?? CHARACTER_VOICES['NARRATOR'];
  return {
    engine: engineOverride ?? DEFAULT_ENGINE,
    kokoroVoice: direct ?? spec.kokoro,
    speed: spec.speed,
    modelName: spec.piper,
    lengthScale: (1 / spec.speed).toFixed(3),
    noiseScale: spec.noise.toFixed(3),
    noiseW: (spec.noise * 0.5).toFixed(3),
  };
}

// Every non-English language the UI offers must map to a real Piper model here.
// A language that is missing from this map is a language we cannot speak — it must
// fail loudly rather than get handed an English model that reads the script as
// gibberish. Models: https://huggingface.co/rhasspy/piper-voices (~63MB each).
const LANGUAGE_VOICES: Record<string, string> = {
  hindi:   'hi_IN-rohan-medium',
  telugu:  'te_IN-maya-medium',
  spanish: 'es_ES-davefx-medium',
};

// Substituted for an English voice that isn't installed. English style/character
// voices differ in delivery, not intelligibility, so swapping one for another is a
// downgrade worth a warning — not a reason to fail an otherwise good render.
const ENGLISH_FALLBACK_VOICE = 'en_US-lessac-medium';

export class MissingVoiceModelError extends Error {
  constructor(public readonly modelName: string | null, public readonly language: string, voicesDir: string) {
    super(
      (modelName
        ? `Voice model "${modelName}" for language "${language}" is not installed in ${voicesDir}. ` +
          `Install it: download ${modelName}.onnx and ${modelName}.onnx.json (~63MB) from ` +
          `https://huggingface.co/rhasspy/piper-voices into ${voicesDir}.`
        : `No voice model is configured for language "${language}". Add it to LANGUAGE_VOICES ` +
          `in ttsService.ts and install a matching model from https://huggingface.co/rhasspy/piper-voices, ` +
          `or pick a supported language (${['english', ...Object.keys(LANGUAGE_VOICES)].join(', ')}).`
      ) + ` Rendering would have produced a video with silent audio, so it was failed instead.`
    );
    this.name = 'MissingVoiceModelError';
  }
}

/**
 * Picks the Piper model for a language, and confirms it is actually on disk.
 *
 * Without this check a missing .onnx surfaces as a Piper subprocess failure, which
 * the caller catches and swallows into a silent-audio fallback — so the render is
 * reported "completed" with no voice at all. That silent success is the bug this
 * function exists to prevent.
 */
export async function resolveVoiceModel(
  voicesDir: string,
  profileModel: string,
  language: string,
  modelExists: (m: string) => Promise<boolean> = (m) =>
    fs.access(path.join(voicesDir, `${m}.onnx`)).then(() => true, () => false),
): Promise<string> {
  const lang = language.toLowerCase();
  const isEnglish = lang === 'english';
  const wanted = isEnglish ? profileModel : LANGUAGE_VOICES[lang];

  // A non-English language with no mapping at all — nothing to even look for.
  if (!wanted) throw new MissingVoiceModelError(null, lang, voicesDir);
  if (await modelExists(wanted)) return wanted;
  if (!isEnglish) throw new MissingVoiceModelError(wanted, lang, voicesDir);

  if (await modelExists(ENGLISH_FALLBACK_VOICE)) {
    console.warn(`[TTS] Voice model "${wanted}" is not installed — falling back to ${ENGLISH_FALLBACK_VOICE}`);
    return ENGLISH_FALLBACK_VOICE;
  }
  throw new MissingVoiceModelError(wanted, lang, voicesDir);
}

/** The Kokoro counterpart of MissingVoiceModelError — same contract, different fix. */
export class MissingKokoroVoiceError extends Error {
  constructor(public readonly voice: string | null, public readonly language: string) {
    super(
      (voice
        ? `Kokoro has no voice named "${voice}".`
        : `Kokoro has no voice for language "${language}" (it covers ${[...KOKORO_LANGUAGES].sort().join(', ')}).`
      ) + ` Pick a listed voice, or select the offline Piper engine if it has one for this language.` +
      ` Rendering would have produced a video with silent audio, so it was failed instead.`
    );
    this.name = 'MissingKokoroVoiceError';
  }
}

/**
 * Picks the Kokoro voice for a language and confirms it actually exists.
 *
 * The Piper counterpart above checks the filesystem; Kokoro ships its voices inside
 * the model, so the equivalent check is against the published roster. The reason for
 * having it is identical: an unknown voice name would surface as a sidecar error,
 * which the caller would otherwise swallow into a silent-audio fallback and report
 * as a successful render.
 *
 * Returns null when Kokoro simply does not cover the language (Telugu) — that is a
 * routing decision for the caller, not a failure, because Piper may still have it.
 */
export function resolveKokoroVoice(profileVoice: string, language: string): string | null {
  const lang = language.toLowerCase();
  if (!KOKORO_LANGUAGES.has(lang)) return null;

  // English keeps whatever the character/style table chose; other languages must be
  // re-pointed at a voice that speaks them, or the model reads the script phonetically
  // in the wrong language.
  if (lang === 'english') {
    if (!KOKORO_VOICES[profileVoice]) throw new MissingKokoroVoiceError(profileVoice, lang);
    return profileVoice;
  }
  if (KOKORO_VOICES[profileVoice]?.lang === lang) return profileVoice;

  // Best available voice for the language, by the model card's own grades.
  const ranked = Object.entries(KOKORO_VOICES)
    .filter(([, v]) => v.lang === lang)
    .sort((a, b) => gradeRank(a[1].grade) - gradeRank(b[1].grade));
  if (!ranked.length) throw new MissingKokoroVoiceError(null, lang);
  return ranked[0][0];
}

/** Orders the model card's letter grades. Ungraded voices sort last, not first. */
export function gradeRank(grade: string): number {
  const order = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F+', 'F'];
  const i = order.indexOf(grade);
  return i === -1 ? order.length : i;
}

/**
 * Runs Piper with the text piped straight into its stdin as UTF-8 bytes.
 *
 * This used to shell out to `cmd /c "type file.txt | piper..."` on Windows and
 * `cat file | piper` elsewhere. Routing non-ASCII narration (Hindi, Telugu) through
 * a shell means its encoding depends on the console codepage, and a mangled script
 * does not fail — Piper exits 0 and synthesizes near-silence. Writing the bytes to
 * the child's stdin removes that dependency along with the two command strings and
 * their quoting hazards. Belt and braces with the isSilentWav check below.
 */
function runPiper(bin: string, cwd: string, args: string[], text: string, timeoutMs = 60000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error(`Piper timed out after ${timeoutMs}ms`), { killed: true }));
    }, timeoutMs);

    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Piper exited with code ${code}: ${stderr.slice(-500)}`));
    });

    child.stdin.on('error', () => { /* child died first; the close handler reports it */ });
    child.stdin.end(Buffer.from(text, 'utf8'));
  });
}

export class SilentSynthesisError extends Error {
  constructor(modelName: string, sceneId: string, engine = 'Piper') {
    super(
      `${engine} reported success but produced pure silence for scene ${sceneId} using "${modelName}". ` +
      `The text most likely did not survive the trip to the synthesizer (encoding), or the model ` +
      `cannot pronounce this script. Failing instead of shipping a silent video.`
    );
    this.name = 'SilentSynthesisError';
  }
}

/**
 * True if a 16-bit PCM WAV is silence. Piper exits 0 even when it has synthesized
 * nothing at all, so the exit code cannot be trusted on its own — this is the check
 * that stops an empty track from being cached and rendered as a "successful" video.
 */
export async function isSilentWav(wavPath: string): Promise<boolean> {
  const buf = await fs.readFile(wavPath);
  for (let i = 44; i < buf.length - 1; i += 2) {
    if (Math.abs(buf.readInt16LE(i)) > 32) return false; // any real sample
  }
  return true;
}

function estimateDurationSec(text: string, hintSec?: number): number {
  if (hintSec && hintSec > 0) return hintSec;
  // ~150 wpm = 2.5 words/second; minimum 3 seconds
  const words = text.trim().split(/\s+/).filter(w => w.length > 0).length;
  return Math.max(3, Math.ceil(words / 2.5));
}

async function generateSilentAudio(outputPath: string, durationSec: number): Promise<string> {
  const silencePath = outputPath.replace(/\.wav$/, '-silence.wav');
  try {
    await execAsync(
      `"${ffmpegStatic}" -f lavfi -i anullsrc=r=44100:cl=stereo -t ${durationSec.toFixed(2)} -y "${silencePath}"`
    );
  } catch (ffmpegErr: any) {
    // Last resort: ffmpeg itself failed — write a raw silent WAV directly (no dependencies)
    console.error(`[TTS] ffmpeg silence generation failed: ${ffmpegErr.message} — writing raw WAV`);
    const sampleRate = 44100;
    const numSamples = Math.round(sampleRate * Math.max(1, durationSec));
    const dataSize = numSamples * 2; // mono, 16-bit
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);   // PCM
    header.writeUInt16LE(1, 22);   // mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28); // byte rate
    header.writeUInt16LE(2, 32);   // block align
    header.writeUInt16LE(16, 34);  // bits per sample
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    await fs.writeFile(silencePath, Buffer.concat([header, Buffer.alloc(dataSize, 0)]));
  }
  return silencePath;
}

/** Where a synthesised clip is cached. Keyed on the text plus every parameter that
 *  changes the sound, so a script edit or a voice change is a miss and nothing else is. */
function cachePathFor(text: string, signature: string): string {
  return path.join(process.cwd(), 'cache', 'tts', `${generateAudioHash(text, signature)}.wav`);
}

async function cacheResult(outputPath: string, cachePath: string, sceneId: string): Promise<void> {
  const stats = await fs.stat(outputPath);
  if (stats.size <= 1000) return; // don't cache a corrupt/empty synth (matches segment validity floor)
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.copyFile(outputPath, cachePath);
  } catch (cacheErr: any) {
    console.warn(`[TTS] Failed to cache narration for scene ${sceneId}: ${cacheErr.message}`);
  }
}

/**
 * Kokoro-82M synthesis through the persistent Python sidecar.
 *
 * Applies the same two guards as the Piper path: the voice is validated before the
 * call (by resolveKokoroVoice, in the caller) and the output is checked for silence
 * after it. A synthesiser that returns success having produced nothing is the failure
 * mode that matters here — it is the one that ships a silent video.
 */
async function synthesizeKokoro(
  text: string, sceneId: string, voice: string, speed: number, outputPath: string,
): Promise<string> {
  const cachePath = cachePathFor(text, `kokoro|${voice}|sp${speed.toFixed(3)}`);
  try {
    await fs.access(cachePath);
    console.log(`[TTS] Cache hit for scene ${sceneId} (kokoro/${voice})`);
    return cachePath;
  } catch { /* miss — synthesize */ }

  const res = await sidecarRequest('kokoro', {
    op: 'synth', engine: 'kokoro', voice, speed, text, out: outputPath,
  });
  console.log(
    `[TTS] Kokoro complete for scene ${sceneId}: voice=${voice} speed=${speed} ` +
    `${res.seconds}s audio in ${res.ms}ms (${(res.ms / 1000 / res.seconds).toFixed(2)}x realtime)`
  );

  if (await isSilentWav(outputPath)) throw new SilentSynthesisError(voice, sceneId, 'Kokoro');
  await cacheResult(outputPath, cachePath, sceneId);
  return outputPath;
}

/**
 * Synthesis from a locally cloned voice (Chatterbox 0.5B, MIT).
 *
 * Loads the saved speaker conditionals rather than re-deriving them from the
 * original sample, which is what makes a cloned voice cheap to reuse. Ownership is
 * checked here and not only in the route, because this is the last point before the
 * voice reaches a video — and every successful use is written to the audit trail.
 */
async function synthesizeCloned(
  text: string, sceneId: string, projectId: string, voiceId: string, ownerUid: string, outputPath: string,
): Promise<string> {
  const voice = await getVoiceForUser(voiceId, ownerUid);
  if (!voice) throw new ClonedVoiceAccessError(voiceId, ownerUid);

  const cachePath = cachePathFor(text, `cloned|${voiceId}`);
  try {
    await fs.access(cachePath);
    console.log(`[TTS] Cache hit for scene ${sceneId} (cloned/${voice.name})`);
    await recordUse(voice, projectId);
    return cachePath;
  } catch { /* miss — synthesize */ }

  const res = await sidecarRequest('clone', {
    op: 'synth', engine: 'chatterbox', conds: voice.checkpointPath, text, out: outputPath,
  });
  console.log(
    `[TTS] Cloned voice "${voice.name}" complete for scene ${sceneId}: ` +
    `${res.seconds}s audio in ${res.ms}ms (${(res.ms / 1000 / res.seconds).toFixed(2)}x realtime)`
  );

  if (await isSilentWav(outputPath)) throw new SilentSynthesisError(voice.name, sceneId, 'Chatterbox');
  await cacheResult(outputPath, cachePath, sceneId);
  await recordUse(voice, projectId);
  return outputPath;
}

export class ClonedVoiceAccessError extends Error {
  constructor(voiceId: string, uid: string) {
    super(
      `Cloned voice "${voiceId}" does not exist or is not owned by ${uid}. Cloned voices are ` +
      `private to the account that created them and there is no sharing mechanism. ` +
      `Rendering would have produced a video with silent audio, so it was failed instead.`
    );
    this.name = 'ClonedVoiceAccessError';
  }
}

export async function generateNarration(
  text: string,
  sceneId: string,
  projectId: string,
  settings?: any,
  durationSec?: number
): Promise<string> {
  const projectAudioDir = path.join(os.tmpdir(), 'ais-audio', projectId);
  await fs.mkdir(projectAudioDir, { recursive: true });
  const outputPath = path.join(projectAudioDir, `narration-${sceneId}.wav`);
  const silenceDuration = estimateDurationSec(text, durationSec);
  const textFilePath = path.join(projectAudioDir, `text-${sceneId}.txt`);

  // Normalise short language codes to full names used throughout the routing
  const langRaw = (settings?.language || 'en').toLowerCase();
  const lang = langRaw === 'te' ? 'telugu'
             : langRaw === 'hi' ? 'hindi'
             : langRaw === 'es' ? 'spanish'
             : langRaw === 'en' ? 'english'
             : langRaw; // pass-through if already a full name

  const profile = resolveVoiceProfile(settings?.character, settings?.voiceStyle);

  // 1. A cloned voice, if one is selected. It is an explicit per-project choice, so
  // it outranks every engine default — and it never silently degrades to another
  // voice: a clone the caller cannot use is an error, not a reason to substitute.
  if (settings?.clonedVoiceId) {
    return synthesizeCloned(
      text, sceneId, projectId, settings.clonedVoiceId,
      settings.ownerUid || settings.userId || 'dev-user', outputPath,
    );
  }

  // 2. Kokoro-82M — the default engine. Apache-2.0, runs on CPU, and the reason
  // Piper is no longer the default.
  if (profile.engine === 'kokoro') {
    // Outside the try below for the same reason as the Piper check: that catch turns
    // failures into silence, which is the wrong answer for "this voice does not exist".
    const kokoroVoice = resolveKokoroVoice(profile.kokoroVoice, lang);

    if (kokoroVoice) {
      try {
        return await synthesizeKokoro(text, sceneId, kokoroVoice, profile.speed, outputPath);
      } catch (kokoroErr: any) {
        // Silence is never "recovered" into silence — see SilentSynthesisError.
        if (kokoroErr instanceof SilentSynthesisError) throw kokoroErr;
        console.error(
          `[TTS] Kokoro failed for scene ${sceneId}: ${kokoroErr.message} — falling back to Piper`
        );
      }
    } else {
      // Kokoro has no voice for this language (Telugu). Piper does, so this is a
      // routing decision rather than a failure.
      console.warn(`[TTS] Kokoro has no "${lang}" voice — using Piper for scene ${sceneId}`);
    }
  }

  // 3. Piper TTS — the offline engine. Only attempted if PIPER_BIN_PATH is configured.
  const piperBin = process.env.PIPER_BIN_PATH;
  if (piperBin) {
    const voicesDir = process.env.PIPER_VOICES_DIR || path.dirname(piperBin);
    const { modelName: profileModel, lengthScale, noiseScale, noiseW } = profile;

    // Deliberately OUTSIDE the try below: that catch turns any failure into silent
    // audio, which is exactly the wrong answer for "this language has no voice".
    // Let MissingVoiceModelError propagate and fail the render.
    const modelName = await resolveVoiceModel(voicesDir, profileModel, lang);

    try {
      console.log(`[TTS] Using Piper TTS for scene ${sceneId}`);
      await fs.writeFile(textFilePath, text, 'utf8');

      // customVoiceId is an ElevenLabs voice_id (src/server/routes/voices.ts) — Piper
      // cannot load it, and there is no ElevenLabs synthesis path. Say so, don't pretend.
      if (settings?.customVoiceId) {
        console.warn(`[TTS] customVoiceId ${settings.customVoiceId} is an ElevenLabs voice and is NOT supported by Piper — using ${modelName}`);
      }

      console.log('[TTS] Scene character:', settings?.character, 'voiceStyle:', settings?.voiceStyle, 'language:', lang, 'Voice model selected:', modelName, `length_scale=${lengthScale} noise_scale=${noiseScale} noise_w=${noiseW}`);

      // Narration cache: same text + voice model + style flags is deterministic
      // output, so a repeat render skips Piper entirely. Keyed on the text itself,
      // so any script edit is a cache miss.
      const ttsCacheDir = path.join(process.cwd(), 'cache', 'tts');
      const cachePath = path.join(ttsCacheDir, `${generateAudioHash(text, `${modelName}|ls${lengthScale}|ns${noiseScale}|nw${noiseW}`)}.wav`);
      try {
        await fs.access(cachePath);
        console.log(`[TTS] Cache hit for scene ${sceneId}`);
        await fs.unlink(textFilePath).catch(() => {});
        return cachePath;
      } catch { /* cache miss — synthesize below */ }

      const modelFile = `${modelName}.onnx`;
      const piperDir = path.dirname(piperBin);

      await runPiper(piperBin, piperDir, [
        '--model', modelFile,
        '--length_scale', lengthScale,
        '--noise_scale', noiseScale,
        '--noise_w', noiseW,
        '--output_file', outputPath,
      ], text);
      await fs.unlink(textFilePath).catch(() => {});
      const stats = await fs.stat(outputPath);
      console.log(`[TTS] Piper complete for scene: ${sceneId} size: ${stats.size} bytes`);

      // Exit code 0 is not proof of speech — see SilentSynthesisError.
      if (await isSilentWav(outputPath)) throw new SilentSynthesisError(modelName, sceneId);

      if (stats.size > 1000) { // don't cache a corrupt/empty synth (matches segment validity floor)
        try {
          await fs.mkdir(ttsCacheDir, { recursive: true });
          await fs.copyFile(outputPath, cachePath);
        } catch (cacheErr: any) {
          console.warn(`[TTS] Failed to cache narration for scene ${sceneId}: ${cacheErr.message}`);
        }
      }
      return outputPath;
    } catch (piperErr: any) {
      // A synth that produced silence must not be "recovered" into silence — that is
      // the exact silent success this whole path exists to prevent. Everything else
      // (crash, timeout, bad model file) keeps the long-standing fallback behaviour.
      if (piperErr instanceof SilentSynthesisError) {
        console.error(`[TTS] ${piperErr.message}`);
        await fs.unlink(textFilePath).catch(() => {});
        throw piperErr;
      }
      const errMsg = (piperErr as any).stderr ? `${piperErr.message} | stderr: ${(piperErr as any).stderr}` : piperErr.message;
      const isTimeout = piperErr.killed || piperErr.code === 'ETIMEDOUT' || piperErr.message?.includes('timed out');
      if (isTimeout) {
        console.error(`[TTS] Piper TTS timeout after 30s for scene ${sceneId} — using silence`);
      } else {
        console.error(`[TTS] Piper failed for scene ${sceneId}: ${errMsg} — using silence`);
      }
      await fs.unlink(textFilePath).catch(() => {});
      console.log(`[TTS] Using silent audio fallback for scene: ${sceneId}`);
      return generateSilentAudio(outputPath, silenceDuration);
    }
  }

  // 4. Nothing left to try. Reaching here means Kokoro was unavailable or failed AND
  // Piper is not configured, so there is no engine that can speak this scene.
  console.warn(
    `[TTS] No TTS engine produced audio for scene ${sceneId} (engine=${profile.engine}, language=${lang}, ` +
    `PIPER_BIN_PATH ${piperBin ? 'set' : 'not set'}) — using silence`
  );
  console.log(`[TTS] Using silent audio fallback for scene: ${sceneId}`);
  return generateSilentAudio(outputPath, silenceDuration);
}

