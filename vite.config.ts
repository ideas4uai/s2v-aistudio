import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

// Only files the browser can actually use are worth watching. Vite's full-reload
// is SILENT — no console line — so every watched file that changes with no HMR
// boundary reloads the page out from under you with no trace. Everything else in
// this repo root is runtime output the server rewrites while you are using the
// UI: outputs/, cache/ and assets/ (written per scene during a render), temp/,
// uploads/, dist/, audit_output/, logs, mp4s. An ignore list kept losing this
// race — outputs/ was added, then cache/ and assets/ turned up — so this is a
// whitelist instead. It cannot be outgrown by the next output directory.
const WATCHED = ['src', 'public', 'index.html', 'vite.config.ts', '.env'];

// Server-only trees. The browser never imports these, so a change has no HMR
// boundary and falls back to a full reload — editing the backend while someone
// is using the UI reloaded the page for no benefit (measured: reload +100ms
// after touch). Verified none of them appear in any import from src/pages,
// src/components, src/content-studio/ui, App.tsx or main.tsx — if that ever
// changes, the importing file stops hot-updating and must come off this list.
const SERVER_ONLY = [
  'src/server', 'src/pipeline', 'src/controllers', 'src/services', 'src/scripts',
  'src/content-studio/agents', 'src/content-studio/workflow', 'src/content-studio/domain',
];

const under = (rel: string, dir: string) => rel === dir || rel.startsWith(dir + '/');

function isIgnored(file: string) {
  const rel = path.relative(__dirname, file).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) return false; // repo root itself — must stay walkable
  if (SERVER_ONLY.some((d) => under(rel, d))) return true;
  // Watch it if it is inside a watched path, or is an ancestor chokidar must
  // descend through to reach one. Ignore everything else.
  return !WATCHED.some((w) => under(rel, w) || w.startsWith(rel + '/'));
}

// Names the file behind a reload. Without this a full-reload is invisible, which
// is the only reason this bug survived as long as it did.
const logFullReload = {
  name: 'log-full-reload',
  configureServer(server: any) {
    let last = '(no file change — dependency re-optimization?)';
    server.watcher.on('all', (_event: string, file: string) => { last = file; });
    const send = server.ws.send.bind(server.ws);
    server.ws.send = (...args: any[]) => {
      if (args[0]?.type === 'full-reload') console.log(`[vite] full page reload <- ${last}`);
      return send(...args);
    };
  },
};

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss(), logFullReload],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify — file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: { ignored: [isIgnored] },
    },
  };
});
