"""
Persistent TTS worker for Kokoro-82M (Apache-2.0) and Chatterbox 0.5B (MIT).

Why a persistent process rather than one spawn per scene: loading Kokoro costs
several seconds, and an episode is 6-10 scenes. Spawning per scene would pay that
cost every time and dominate the actual synthesis. This stays alive for the life of
the Node server and keeps each model in memory after its first use.

Protocol: one JSON object per line on stdin, one JSON object per line on stdout.
Anything a library prints to stdout would corrupt that stream, so stdout is
redirected to stderr for the duration of every request (see `quiet`).

  -> {"id":"1","op":"synth","engine":"kokoro","voice":"af_heart","text":"hi","speed":1.0,"out":"a.wav"}
  <- {"id":"1","ok":true,"ms":812,"seconds":1.4,"sample_rate":24000}

  -> {"id":"2","op":"clone","sample":"ref.wav","out":"voices/cloned/xyz.pt"}
  <- {"id":"2","ok":true,"ms":9100,"peak_rss_mb":1840}

  -> {"id":"3","op":"synth","engine":"chatterbox","conds":"voices/cloned/xyz.pt","text":"hi","out":"b.wav"}
  <- {"id":"3","ok":true,"ms":4200,"seconds":1.5,"sample_rate":24000}

Every reply carries `ms` because the Node side reports real synthesis timings and
must never have to guess them.
"""
import contextlib
import io
import json
import os
import sys
import time
import traceback

# The protocol is UTF-8 JSON; Python is not, unless it is told so.
#
# On Windows sys.stdin defaults to the *locale* codepage — cp1252 on this machine,
# measured — while Node writes the request line as UTF-8 bytes. Every non-ASCII
# character in a script therefore arrived here as mojibake: an em dash (U+2014,
# E2 80 94) was decoded as "â€”", and Kokoro's G2P dutifully pronounced it, putting
# ~1.9s of spoken "a circumflex euro" into the middle of the narration. It is not a
# cosmetic bug: that phantom speech sits inside the measured speech span, so the
# captions — which only ever see the clean text — were spread across it and ran up
# to a second late on exactly the scenes whose script contained a dash.
#
# Set on the streams rather than via PYTHONIOENCODING in the spawn, so the script is
# correct however it is started. Anything a script can contain, this has to carry:
# curly quotes and ellipses come out of every LLM as often as dashes do.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

# Keep every framework single-machine friendly. This box is a 4-core/8-thread
# i5-8250U; letting torch spawn more threads than that only adds contention.
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

# Kokoro voice name -> KPipeline lang_code. The first letter of every Kokoro voice
# encodes its language, so the map is over prefixes, not over individual voice names.
# Every prefix the model card defines is kept here even though the app now only offers
# the English and Hindi voices: this map decodes whatever name it is handed, and
# narrowing it would turn an unoffered voice into a wrong-language synthesis rather
# than a clean lookup. The roster is enforced in ttsService, not here.
# https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md
LANG_BY_PREFIX = {
    "a": "a",  # American English
    "b": "b",  # British English
    "e": "e",  # Spanish
    "f": "f",  # French
    "h": "h",  # Hindi
    "i": "i",  # Italian
    "j": "j",  # Japanese
    "p": "p",  # Brazilian Portuguese
    "z": "z",  # Mandarin Chinese
}

_pipelines = {}   # lang_code -> KPipeline
_chatterbox = [None]


@contextlib.contextmanager
def quiet():
    """Point fd 1 at stderr for the duration of a request.

    kokoro/torch/transformers all print progress to stdout, and one stray byte there
    desynchronises the JSON-lines protocol — which surfaces on the Node side as an
    unparseable reply rather than as anything resembling a print.

    This swaps the *file descriptor*, not just `sys.stdout`. Rebinding `sys.stdout`
    alone is not enough: misaki shells out to `pip install en_core_web_sm` on first
    use, and a subprocess inherits fd 1 directly, so its output sails straight past
    any Python-level redirect. That is not hypothetical — it happened on the first
    run here and put pip's progress bars in the middle of the protocol stream.
    """
    sys.stdout.flush()
    saved_fd = os.dup(1)
    saved_obj = sys.stdout
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    try:
        yield
    finally:
        sys.stdout = saved_obj
        sys.stdout.flush()
        os.dup2(saved_fd, 1)
        os.close(saved_fd)


def kokoro_pipeline(lang_code):
    if lang_code not in _pipelines:
        from kokoro import KPipeline
        _pipelines[lang_code] = KPipeline(lang_code=lang_code)
    return _pipelines[lang_code]


def synth_kokoro(req):
    import numpy as np
    import soundfile as sf

    voice = req["voice"]
    lang = req.get("lang") or LANG_BY_PREFIX.get(voice[:1], "a")
    pipeline = kokoro_pipeline(lang)

    chunks = []
    for _gs, _ps, audio in pipeline(req["text"], voice=voice, speed=float(req.get("speed", 1.0))):
        chunks.append(audio if isinstance(audio, np.ndarray) else audio.detach().cpu().numpy())
    if not chunks:
        raise RuntimeError(f"Kokoro produced no audio for voice {voice!r}")

    wav = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
    # PCM_16 is not the default for float input (soundfile would pick 32-bit float).
    # The Node-side silence guard reads 16-bit samples, and Piper's output is PCM_16,
    # so writing anything else here makes Kokoro audio unverifiable and inconsistent.
    sf.write(req["out"], wav, 24000, subtype="PCM_16")
    return {"seconds": round(len(wav) / 24000.0, 3), "sample_rate": 24000}


def chatterbox_model():
    """Chatterbox TTS: 0.5B params, MIT weights (code and checkpoint), CPU inference.

    Not the 110M "Nano" variant the model card advertises — `chatterbox-tts` 0.1.7 on
    PyPI exposes only `ChatterboxTTS`, and `ChatterboxTurboTTS`/nano is not in any
    released wheel. The 0.5B model is what is actually installable, so it is what runs;
    the cost of that is time per scene, measured and reported rather than assumed.

    Deliberately pinned to CPU. The GPU here is a 940MX with 2GB of VRAM and the
    installed torch has no CUDA build, so asking for cuda would either fail outright
    or silently fall back — better to be explicit than surprised.
    """
    if _chatterbox[0] is None:
        from chatterbox.tts import ChatterboxTTS
        _chatterbox[0] = ChatterboxTTS.from_pretrained(device="cpu")
    return _chatterbox[0]


def peak_rss_mb():
    """Peak working set where the OS tracks it, current RSS otherwise.

    Windows exposes a true high-water mark as `peak_wset`; on other platforms this
    falls back to RSS sampled right after the work, which understates the real peak.
    """
    try:
        import psutil
        info = psutil.Process().memory_info()
        return round(getattr(info, "peak_wset", info.rss) / (1024 * 1024), 1)
    except Exception:
        return None


def do_clone(req):
    """Extract reusable speaker conditionals from a voice sample.

    The result is a ~165KB tensor file reloaded for every later synthesis, so a voice
    is cloned exactly once no matter how many videos use it.

    It is not, however, the expensive step. Measured on this machine: cloning takes
    ~60-80s once, while each subsequent generation runs at 14-23x realtime — roughly
    15-20x slower than Kokoro. "Clone once, cheap forever" holds for the cloning half
    and fails for the generation half; see the README.
    """
    from pathlib import Path

    model = chatterbox_model()
    model.prepare_conditionals(req["sample"], exaggeration=float(req.get("exaggeration", 0.5)))
    out = req["out"]
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    model.conds.save(Path(out))  # Conditionals.save is typed for pathlib, not str
    return {"peak_rss_mb": peak_rss_mb()}


def synth_chatterbox(req):
    import soundfile as sf
    from chatterbox.tts import Conditionals

    model = chatterbox_model()
    model.conds = Conditionals.load(req["conds"], map_location="cpu")
    wav = model.generate(req["text"], temperature=float(req.get("temperature", 0.8)))
    arr = wav.squeeze(0).detach().cpu().numpy()
    sf.write(req["out"], arr, model.sr, subtype="PCM_16")  # see synth_kokoro
    return {"seconds": round(len(arr) / float(model.sr), 3), "sample_rate": model.sr,
            "peak_rss_mb": peak_rss_mb()}


_aligner = [None]


def aligner():
    """faster-whisper base.en, int8 on CPU. Loaded once, on first alignment.

    Lives in this process because it is already the long-lived one: a per-scene spawn
    would pay the 3.2s model load nine times an episode for ~4s of actual work.
    """
    if _aligner[0] is None:
        from faster_whisper import WhisperModel
        _aligner[0] = WhisperModel("base.en", device="cpu", compute_type="int8")
    return _aligner[0]


def _key(word):
    """Comparison form of a word: letters, digits and apostrophes only."""
    import unicodedata
    return "".join(
        c for c in unicodedata.normalize("NFKD", word).lower()
        if c.isalnum() or c == "'"
    )


def align_words(req):
    """When each word of `text` is actually spoken in `wav`.

    Returns one entry per word of the caller's text, in order, always — the captions
    and the kinetic overlay both index into this list, so a short answer would be
    worse than no answer. Words the transcript did not match are interpolated between
    the neighbours that did.

    Why measure rather than divide: the caption timeline used to spread the words
    evenly across the measured speech span, which assumes every word takes the same
    time to say. Measured against forced alignment on nine real scenes, that ran the
    captions up to 0.47s late even on scenes with no other defect, because real word
    durations vary about threefold and the span's -40dB end overshoots the last word
    by ~0.39s. No weighting heuristic closed it: character- and syllable-weighted
    division were measured too and left the worst case at 0.42-0.47s.

    The alignment runs on the PROCESSED segment audio, not the raw narration, so
    whatever the filter chain did to the timeline — silenceremove deletes 0.2-1.6s of
    internal pauses per scene — is already baked into what is measured.
    """
    text = str(req.get("text") or "")
    words = [w for w in text.split() if w.strip()]
    if not words:
        return {"words": []}

    segments, _info = aligner().transcribe(
        req["wav"], word_timestamps=True, beam_size=1,
        vad_filter=False, condition_on_previous_text=False,
    )
    heard = [(w.word.strip(), float(w.start), float(w.end))
             for seg in segments for w in (seg.words or [])]

    # Monotonic match: each word may only take a transcript word after the one its
    # predecessor took, so a repeated word ("real or not, real or not") cannot pull
    # the timeline backwards. A near window first, then a forward scan for a word the
    # transcript dropped or merged.
    out, cursor = [], 0
    for word in words:
        k = _key(word)
        hit = None
        if k:
            for j in range(cursor, min(cursor + 6, len(heard))):
                if _key(heard[j][0]) == k:
                    hit = j
                    break
            if hit is None:
                for j in range(cursor, len(heard)):
                    if _key(heard[j][0]) == k:
                        hit = j
                        break
        if hit is None:
            out.append(None)
        else:
            out.append((heard[hit][1], heard[hit][2]))
            cursor = hit + 1

    matched = sum(1 for x in out if x is not None)
    if matched < 2:
        # Nothing usable — say so rather than hand back an invented timeline. The
        # caller keeps its own even division, which is wrong by a fraction of a second
        # rather than wrong by the length of the scene.
        return {"words": [], "matched": matched, "heard": len(heard)}

    # Fill the gaps by even division between the neighbours that did match, and give
    # unmatched words at either end the same treatment against the span's edges.
    first = next(i for i, x in enumerate(out) if x is not None)
    last = len(out) - 1 - next(i for i, x in enumerate(reversed(out)) if x is not None)
    span_start, span_end = out[first][0], out[last][1]
    for i in range(first):
        out[i] = (span_start, span_start)
    for i in range(last + 1, len(out)):
        out[i] = (span_end, span_end)
    i = first
    while i <= last:
        if out[i] is not None:
            i += 1
            continue
        j = i
        while out[j] is None:
            j += 1
        lo, hi = out[i - 1][1], out[j][0]
        step = (hi - lo) / (j - i + 1)
        for n in range(j - i):
            out[i + n] = (lo + n * step, lo + (n + 1) * step)
        i = j

    return {
        "words": [{"word": w, "start": round(s, 3), "end": round(e, 3)}
                  for w, (s, e) in zip(words, out)],
        "matched": matched,
        "heard": len(heard),
    }


OPS = {
    "synth_kokoro": synth_kokoro,
    "synth_chatterbox": synth_chatterbox,
    "clone": do_clone,
    "align": align_words,
    "ping": lambda req: {"pong": True},
}


def handle(req):
    op = req.get("op")
    if op == "synth":
        op = f"synth_{req.get('engine', 'kokoro')}"
    fn = OPS.get(op)
    if fn is None:
        raise ValueError(f"unknown op {req.get('op')!r}/{req.get('engine')!r}")
    return fn(req)


def main():
    # Announce readiness before the first request so Node can distinguish "starting"
    # from "wedged" without a timeout guess.
    print(json.dumps({"id": "__ready__", "ok": True, "python": sys.version.split()[0]}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        started = time.time()
        try:
            with quiet():
                result = handle(req)
            reply = {"id": req.get("id"), "ok": True, "ms": int((time.time() - started) * 1000)}
            reply.update(result or {})
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            reply = {"id": req.get("id"), "ok": False,
                     "ms": int((time.time() - started) * 1000),
                     "error": f"{type(exc).__name__}: {exc}"}
        print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    main()
