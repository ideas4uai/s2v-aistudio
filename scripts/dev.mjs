// Starts the API and the Vite dev server together, for parity with the old single
// `npm run dev`. Two processes, not one: Vite's HMR websocket used to live inside
// the backend process, so every backend restart force-reloaded the browser tab.
//
// To restart the backend WITHOUT disturbing the open page — the whole point of the
// split — run the two halves in separate terminals instead and restart only the API:
//
//   terminal 1:  npm run dev:web    (Vite on :3000 — leave this running)
//   terminal 2:  npm run dev:api    (API on :3001 — restart this freely)
//
// Ctrl-C here stops both.

import { spawn } from 'child_process';

const isWindows = process.platform === 'win32';
const run = (name, script) =>
  spawn(isWindows ? 'npm.cmd' : 'npm', ['run', script], {
    stdio: 'inherit',
    shell: isWindows, // npm.cmd needs a shell on Windows
  }).on('exit', (code) => {
    // If either half dies the other is useless — take both down so it's obvious.
    console.log(`[dev] ${name} exited (${code}) — stopping the other process`);
    shutdown();
  });

let stopping = false;
const children = [];

function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (!c.killed) c.kill();
  }
}

children.push(run('api', 'dev:api'), run('web', 'dev:web'));

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', shutdown);

console.log('[dev] API on http://localhost:3001 · app on http://localhost:3000');
console.log('[dev] To restart the backend without reloading the browser, run dev:api and dev:web in separate terminals.');
