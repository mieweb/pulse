#!/usr/bin/env python3
"""Regenerate the speech fixture clips in assets/dev/speech/ (dev seed `+ s8`).

Source: NASA's "#AskNASA: How Can I Be An Astronaut?" (YouTube -XQ_CuIwDlc, NASA's channel: US
government work, public domain), with its human English captions. Downloads it with yt-dlp, then
cuts ten clips in the recorder's format, one answer per clip: H.264 30 fps coded 1920x1080 with
square pixels and a 90-degree display rotation (portrait on screen, as the phone records it, so a
draft of them joins without re-encoding, alone or with recordings), AAC 48 kHz mono; each cut snapped to the quietest 10 ms within +-0.4 s of a gap in the captions.
Writes cuts.json (each clip's window in the source) and the captions (asknasa.en.json3).

  python3 scripts/make-speech-fixtures.py            # needs yt-dlp and ffmpeg on PATH
"""
import json, os, shutil, struct, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'assets', 'dev', 'speech')
SRC = os.path.join(OUT, '.source', 'asknasa.mp4')

# Planned clip windows (s), from the human captions' gaps: one answer per clip, intro and outro
# music left out.
CLEAN = [
    (0.40, 5.70), (10.50, 30.30), (30.40, 63.60), (65.10, 88.20), (88.90, 112.90),
    (113.30, 127.70), (128.20, 151.00), (151.70, 173.60), (173.70, 186.60), (186.70, 209.40),
]
def envelope(path, hop=0.01):
    raw = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'],
        capture_output=True, check=True).stdout
    n = len(raw) // 2
    samples = struct.unpack(f'<{n}h', raw[: n * 2])
    w = int(16000 * hop)
    env = []
    for i in range(0, n - w, w):
        chunk = samples[i:i + w]
        env.append((sum(s * s for s in chunk) / w) ** 0.5)
    return env, hop


def snap(env, hop, t, radius=0.4):
    lo, hi = max(0, int((t - radius) / hop)), min(len(env) - 1, int((t + radius) / hop))
    best = min(range(lo, hi + 1), key=lambda i: env[i])
    return round(best * hop, 3)


def main():
    src_dir = os.path.dirname(SRC)
    os.makedirs(src_dir, exist_ok=True)
    if not os.path.exists(SRC):
        subprocess.run(['yt-dlp', '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]',
                        '--merge-output-format', 'mp4', '--write-subs', '--sub-langs', 'en',
                        '--sub-format', 'json3', '-o', os.path.join(src_dir, 'asknasa.%(ext)s'),
                        '--', '-XQ_CuIwDlc'], check=True)
    env, hop = envelope(SRC)
    cuts = []
    for i, (a, b) in enumerate(CLEAN, 1):
        a, b = snap(env, hop, a), snap(env, hop, b)
        name = f'{i:02d}.mp4'
        coded = os.path.join(src_dir, f'coded-{name}')
        # Centre crop to 9:16 (an even 608 px, square pixels), the recorder's portrait 1080x1920 on
        # screen, coded on its side (1920x1080) as the phone codes it...
        subprocess.run([
            'ffmpeg', '-v', 'error', '-y', '-ss', f'{a:.3f}', '-to', f'{b:.3f}', '-i', SRC,
            '-vf', 'crop=608:ih,scale=1080:1920,setsar=1,fps=30,transpose=1', '-c:v', 'libx264',
            '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-b:v', '1000k', '-maxrate', '1500k',
            '-bufsize', '3000k', '-c:a', 'aac', '-ar', '48000', '-ac', '1', '-b:a', '96k', coded],
            check=True)
        # ...and turned upright by its display matrix (rotation 90, as the recorder writes).
        subprocess.run([
            'ffmpeg', '-v', 'error', '-y', '-display_rotation:v:0', '90', '-i', coded, '-c', 'copy',
            '-movflags', '+faststart', os.path.join(OUT, name)], check=True)
        os.remove(coded)
        cuts.append({'file': name, 'srcStart': a, 'srcEnd': b})
        print(f'{name} {a:7.3f}-{b:7.3f} ({b - a:5.2f} s)')
    with open(os.path.join(OUT, 'cuts.json'), 'w') as f:
        json.dump(cuts, f, indent=1)
    shutil.copy(os.path.join(src_dir, 'asknasa.en.json3'), os.path.join(OUT, 'asknasa.en.json3'))


if __name__ == '__main__':
    main()
