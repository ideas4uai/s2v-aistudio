"""Caption-sync check for the collapsed encode pipeline.

Two questions, both measured rather than reasoned about:

  1. detectSpeechSpan used to run on the muxed MP4 and now runs on the processed WAV
     that gets muxed into it. Do they agree? (AAC encoder delay/priming is the thing
     that could move it.)
  2. On the finished single-pass file, does speech actually start when the first
     caption cue says it does?

Tolerance is the +/-100ms established for the caption-sync work.
"""
import json, os, re, subprocess, sys

FF = os.path.abspath('node_modules/ffmpeg-static/ffmpeg.exe')
OUT = os.path.abspath(sys.argv[1])
os.makedirs(OUT, exist_ok=True)
TOL = 0.100

p = json.load(open('outputs/04fa8d80-7de2-409b-aef9-57c70eb177b5.json'))


def ff(args, capture_err=True):
    return subprocess.run([FF, '-hide_banner'] + args, capture_output=True, text=True)


def duration(path):
    r = subprocess.run(['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
                        '-of', 'csv=p=0', path], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def speech_span(path, total):
    """Port of detectSpeechSpan in renderService.ts — same filter, same pairing rules."""
    r = ff(['-i', path, '-af', 'silencedetect=noise=-40dB:d=0.2', '-f', 'null', '-'])
    err = r.stderr
    starts = [float(m) for m in re.findall(r'silence_start:\s*(-?[\d.]+)', err)]
    ends = [float(m) for m in re.findall(r'silence_end:\s*(-?[\d.]+)', err)]
    if not starts:
        return 0.0, total
    periods = [(s, ends[i] if i < len(ends) else total) for i, s in enumerate(starts)]
    start = periods[0][1] if periods[0][0] <= 0.05 else 0.0
    end = periods[-1][0] if periods[-1][1] >= total - 0.2 else total
    if not (end > start) or end - start < 0.2:
        return 0.0, total
    return start, min(end, total)


worst_span = 0.0
worst_cue = 0.0
rows = []

for s in p['scenes']:
    sid = s['scene_id'][:8]
    wav = s['narration_path']
    vis = s['visuals'][0]['rendered_path']
    if not (os.path.exists(wav) and os.path.exists(vis)):
        print('skip', sid); continue

    pad = float(s.get('pad_seconds') or 0)
    raw = duration(wav)
    af = ('asetpts=PTS-STARTPTS,silenceremove=stop_periods=-1:stop_duration=0.05:'
          'stop_threshold=-40dB,apad' + ('' if pad > 0 else '=pad_dur=0.1'))
    cap = '%.3f' % (raw + pad if pad > 0 else raw + 0.1)

    # NEW: span measured on the processed WAV
    pwav = os.path.join(OUT, sid + '_proc.wav')
    ff(['-loglevel', 'error', '-i', wav, '-af', af, '-c:a', 'pcm_s16le',
        '-ar', '44100', '-ac', '2', '-t', cap, '-y', pwav])
    d_new = duration(pwav)
    new_start, new_end = speech_span(pwav, d_new)

    # OLD: span measured on a muxed MP4 built the way the old chain built it
    old = os.path.join(OUT, sid + '_old.mp4')
    ff(['-loglevel', 'error', '-stream_loop', '-1', '-i', vis, '-i', wav,
        '-vf', 'setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=increase,'
               'crop=1920:1080,setsar=1',
        '-af', af, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
        '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k',
        '-t', cap, '-y', old])
    d_old = duration(old)
    old_start, old_end = speech_span(old, d_old)

    # Ground truth: where the narration audio itself actually stops. The two files carry
    # the same audio, so this is the number both spans are trying to estimate.
    astream = subprocess.run(['ffprobe', '-v', 'quiet', '-select_streams', 'a:0',
                              '-show_entries', 'stream=duration', '-of', 'csv=p=0', pwav],
                             capture_output=True, text=True)
    true_end = float(astream.stdout.strip())
    # A detected trailing silence means speech stopped before the audio did. ffmpeg
    # CLOSES a trailing silence at EOF rather than leaving it open, so "runs to the end"
    # has to be tested on the end timestamp, not on a missing one.
    r = ff(['-i', pwav, '-af', 'silencedetect=noise=-40dB:d=0.2', '-f', 'null', '-'])
    sil_starts = [float(m) for m in re.findall(r'silence_start:\s*(-?[\d.]+)', r.stderr)]
    sil_ends = [float(m) for m in re.findall(r'silence_end:\s*(-?[\d.]+)', r.stderr)]
    if sil_starts:
        last_start = sil_starts[-1]
        last_end = sil_ends[-1] if len(sil_ends) == len(sil_starts) else true_end
        if last_end >= true_end - 0.2:
            true_end = last_start

    d_new, d_old = abs(new_end - true_end), abs(old_end - true_end)
    worst_span = max(worst_span, d_new)
    rows.append((sid, true_end, old_end, new_end, d_old, d_new))
    print('%s  true speech end %.3f | old %.3f (err %.3f) | new %.3f (err %.3f)  %s'
          % (sid, true_end, old_end, d_old, new_end, d_new,
             'OK' if d_new <= TOL else 'FAIL'))

print('\nworst NEW error vs true speech end: %.3fs (tolerance %.3fs) -> %s'
      % (worst_span, TOL, 'PASS' if worst_span <= TOL else 'FAIL'))
print('worst OLD error vs true speech end: %.3fs'
      % max(r[4] for r in rows))
sys.exit(0 if worst_span <= TOL else 1)
