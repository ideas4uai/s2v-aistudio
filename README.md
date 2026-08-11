<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/01f45827-64bf-41cc-9e8f-37013c68bb47

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

Open http://localhost:3000.

### Dev runs as two processes

`npm run dev` starts two of them:

| command | what it runs | port |
|---|---|---|
| `npm run dev:web` | Vite dev server — serves the app, owns HMR | 3000 (open this) |
| `npm run dev:api` | Express API, renderer, pipeline | 3001 |

Vite proxies `/api`, `/v1`, `/outputs`, `/uploads`, `/cache` and `/music` to the API,
so every URL in the frontend stays exactly as it would be if one process served both.

**Why they are split.** Vite used to run in middleware mode *inside* the Express
process. Its HMR websocket therefore lived and died with the backend, and the browser
treats a dropped HMR socket as "server connection lost" and force-reloads the page
(`vite/dist/client/client.mjs:560-562`). There is no backend file watcher, so every
backend edit needs a manual restart — which meant every backend edit reloaded whatever
you were looking at, mid-render included. As separate processes the API can restart as
often as it likes and the open tab never notices.

**So: to restart the backend without disturbing the browser, run the two halves in
separate terminals** and restart only `dev:api`. `npm run dev` runs both under one
parent for convenience, but Ctrl-C there stops both — which does reload the page,
because you also restarted Vite.

Production is unchanged and still a single process: `npm run build` then `npm start`
serves the built app and the API together on one port.

## Voices

Three engines, chosen per project in the **Voice** picker on the create screen (each
has a ▶ Preview button that synthesises a few seconds before you commit):

| engine | what it is | licence | runs on |
|---|---|---|---|
| **Kokoro-82M** (default) | 54 voices, 8 languages | Apache-2.0 | CPU, ~1× realtime |
| **Piper** | the previous default, kept as the offline option | MIT | CPU, fast |
| **Cloned voice** | your own voice, cloned locally in Voice Studio | MIT (Chatterbox) | CPU, ~14-23× realtime |

Kokoro is the default because Piper was judged too robotic, and because Apache-2.0 is
unambiguous for a monetised channel. Piper stays selectable — it is the only engine
here with a **Telugu** voice, and requests for a language Kokoro cannot speak are
routed to it automatically.

### The two Python environments

`chatterbox-tts` pins torch 2.6 / numpy 1.26 / transformers 5.2. Installing it next to
Kokoro downgrades all three and breaks Kokoro outright, so they get one environment
each. Neither is the `py` launcher, which is Python 3.11 here and belongs to the render
engine (cv2, `metro_engine_v4.py`) — a TTS dependency change must never break a render.

```
TTS_PYTHON=.../python.exe          # kokoro + soundfile
CLONE_PYTHON=.../.venv-clone/...   # chatterbox-tts + psutil + soundfile + "setuptools<81"
```

Both are set in `.env`. `python` on PATH resolves differently for Node than for a
shell, so these are pinned rather than inferred. Set up the cloning environment with:

```
python -m venv .venv-clone
.venv-clone/Scripts/python -m pip install chatterbox-tts psutil soundfile "setuptools<81"
```

`setuptools<81` is not optional: `resemble-perth` imports `pkg_resources`, which
setuptools 81 removed. Without it the watermarker silently becomes `None` and
Chatterbox fails to construct.

Both environments run the same worker, `src/scripts/tts_sidecar.py`, as a long-lived
process speaking JSON-lines over stdin/stdout. It is persistent because loading Kokoro
costs ~15s and an episode is 6-10 scenes.

### Voice Studio

`/voice-studio` clones a voice from a 10-30s sample, on this machine — the sample never
leaves it. Cloning is a one-time ~60-80s step producing a ~165KB checkpoint under
`voices/cloned/`; that checkpoint is then reused by any project, with no re-cloning.

Cloned voices are **private to the account that created them** and there is no sharing
mechanism. Cloning requires accepting a consent statement, enforced server-side rather
than only in the UI, and every clone and every use is written to `voices/audit.jsonl`,
readable at `/api/voices/audit`. Deleting a voice erases its checkpoint, the original
sample and its audit entries. Rendered MP4s carry a `comment`/`description` tag
declaring the narration synthetic, for platform disclosure requirements.

`voices/` is gitignored: voice samples are personal data and the registry names real users.
