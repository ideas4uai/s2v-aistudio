/**
 * Metro Engine V4 integration test.
 * Takes one EP2 scene's cached assets, renders a 10-second clip through
 * metro_engine_v4.py, and reports file size / duration / frame count.
 *
 * Run: npx tsx scripts/test_metro_v4.ts
 * No API spend — uses cached assets from %TEMP%\ais-renderer only.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync, execSync } from 'child_process';

const EP2_PROJECT_ID = '85fed594-3d48-46bf-bfea-6e4d2037efd0';
const TEMP_DIR = path.join(os.tmpdir(), 'ais-renderer');
const OUTPUT_FILE = 'E:\\s2v-aistudio\\outputs\\metro_v4_test.mp4';
const ENGINE = path.join(process.cwd(), 'src', 'scripts', 'metro_engine_v4.py');

function findScenePair(): { bg: string; char: string } | null {
  const bgDir = path.join(TEMP_DIR, EP2_PROJECT_ID);
  if (!fs.existsSync(bgDir)) return null;
  const bgs = fs.readdirSync(bgDir).filter(f => f.endsWith('_background.png'));
  for (const bg of bgs) {
    const sceneId = bg.replace('_background.png', '');
    const char = path.join(TEMP_DIR, `${sceneId}_transparent.png`);
    if (fs.existsSync(char)) {
      return { bg: path.join(bgDir, bg), char };
    }
  }
  // Background-only fallback (unified-style render)
  if (bgs.length > 0) return { bg: path.join(bgDir, bgs[0]), char: '' };
  return null;
}

function main() {
  const pair = findScenePair();
  if (!pair) {
    console.error('ERROR: no cached EP2 background found in', TEMP_DIR);
    console.error('Run a render first so assets are cached, then retry.');
    process.exit(1);
  }

  console.log('── Metro V4 integration test ──');
  console.log('Background:', path.basename(pair.bg));
  console.log('Character: ', pair.char ? path.basename(pair.char) : 'none (unified mode)');

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  if (fs.existsSync(OUTPUT_FILE)) fs.unlinkSync(OUTPUT_FILE);

  const args = [
    ENGINE,
    '--background', pair.bg,
    '--character', pair.char,
    '--output', OUTPUT_FILE,
    '--duration', '10',
    '--emotion', 'tense',
    '--scene_type', 'street',
    '--fps', '24',
    '--width', '1080',
    '--height', '1920',
    '--prev_scene_type', 'black',
    '--next_scene_type', 'street',
    '--seed', '42',
  ];

  console.log('\nSpawning: py', args.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' '), '\n');
  const t0 = Date.now();
  const proc = spawnSync('py', args, { stdio: 'inherit', timeout: 900000 });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (proc.status !== 0) {
    console.error(`\nFAILED: engine exited with code ${proc.status}`);
    process.exit(1);
  }
  if (!fs.existsSync(OUTPUT_FILE)) {
    console.error('\nFAILED: output file not created');
    process.exit(1);
  }

  // ── Quality metrics ──
  const sizeBytes = fs.statSync(OUTPUT_FILE).size;
  const sizeMb = (sizeBytes / 1024 / 1024).toFixed(2);
  let duration = '?';
  let frames = '?';
  let codec = '?';
  try {
    duration = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${OUTPUT_FILE}"`
    ).toString().trim();
    frames = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=nb_frames -of csv=p=0 "${OUTPUT_FILE}"`
    ).toString().trim();
    codec = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "${OUTPUT_FILE}"`
    ).toString().trim();
  } catch { /* ffprobe optional */ }

  console.log('\n── Result ──');
  console.log(`Output:     ${OUTPUT_FILE}`);
  console.log(`File size:  ${sizeMb} MB (${sizeBytes} bytes)`);
  console.log(`Duration:   ${duration}s (expected ~10.0)`);
  console.log(`Frames:     ${frames} (expected 240 @ 24fps)`);
  console.log(`Codec:      ${codec}`);
  console.log(`Wall time:  ${elapsed}s`);
}

main();
