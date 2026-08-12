"""Frame-integrity check for parallelised frame synthesis.

Renders are split across processes by frame range, so the failure mode to guard
against is a discontinuity exactly at a range boundary — particles restarting, a
dropped or duplicated frame. This compares a sequential render against a parallel
one of the same scene and reports whether the boundaries look like any other frame.

Usage:
  set METRO_V4_WORKERS=1 && py src/scripts/metro_engine_v4.py --background BG --output seq.mp4 --duration 20 ...
  set METRO_V4_WORKERS=4 && py src/scripts/metro_engine_v4.py --background BG --output par.mp4 --duration 20 ...
  py src/scripts/verify_parallel_frames.py seq.mp4 par.mp4

Exits non-zero on mismatch, so it can gate a change to the synthesis loop.
"""
import subprocess, numpy as np, sys
W,H = 480,270           # downscale: structural comparison, not a pixel-perfect codec diff
def frames(path):
    cmd=['ffmpeg','-v','error','-i',path,'-vf',f'scale={W}:{H}','-f','rawvideo','-pix_fmt','gray','-']
    raw=subprocess.run(cmd,capture_output=True).stdout
    n=len(raw)//(W*H)
    return np.frombuffer(raw[:n*W*H],dtype=np.uint8).reshape(n,H,W).astype(np.int16)
a=frames(sys.argv[1]); b=frames(sys.argv[2])
print(f'frames: sequential={len(a)} parallel={len(b)}')
n=min(len(a),len(b))
d=np.abs(a[:n]-b[:n]).mean(axis=(1,2))
print(f'mean |diff| per frame: avg={d.mean():.2f} max={d.max():.2f} (0-255 scale)')
# The failure mode of bad parallelisation is a jump exactly at a range boundary.
bounds=[n*i//4 for i in (1,2,3)]
print('at worker range boundaries:', {f'f{b_}': round(float(d[b_]),2) for b_ in bounds})
print('neighbouring frames        :', {f'f{b_-1}': round(float(d[b_-1]),2) for b_ in bounds})
worst=int(d.argmax())
print(f'worst frame {worst} diff {d[worst]:.2f}; boundary frames are {bounds}')
ok = len(a) == len(b) and d.max() < 12 and all(abs(d[b_] - d.mean()) < 8 for b_ in bounds)
print('VERDICT:', 'CONTENT MATCHES (no boundary discontinuity)' if ok else 'MISMATCH - investigate')
sys.exit(0 if ok else 1)
