#!/bin/bash
# Regenerate the A/V SYNC fixture clips in assets/dev/sync/ (dev seeds `+ s6` / `+ s7`).
#
# Purpose: measure lip sync of a merged export instead of judging it by eye. Each clip is 12 s
# of black with an event every second (t = 0.5, 1.5, … 11.5): a 2-frame white flash on video and
# a 5 ms 2 kHz click on audio, starting at the same instant. Export a seeded draft on a phone,
# pull the file back and measure audio minus video at every event with any flash/click checker
# (ffmpeg: first bright frame of each flash vs first loud audio sample of each click).
#
#   - `sync-48k.mp4`  → 48 kHz mono AAC. Copies of it share one signature, so a draft of only
#                       these joins without re-encoding video (`Dev sample 6 (sync)`).
#   - `sync-44k.mp4`  → 44.1 kHz mono AAC (messaging-app audio). Mixed with the 48 kHz clip, the
#                       join re-encodes the audio from both rates into the draft's layout
#                       (`Dev sample 7 (sync, mixed audio)`).
#
# Same portrait handling as the recorder and the other dev fixtures: a coded-landscape buffer +
# a 90° rotation matrix in a QuickTime container, H.264 High 30 fps, and like the camera no
# B-frames (x264 adds them by default; a copied clip that reorders frames sends iOS's merge to a
# full encode, so with them an edited draft would never take the selective path). A yellow bar fills along
# the bottom so position is visible while trimming.
#
# Requires: ffmpeg with libx264 (brew install ffmpeg).
# Usage: bash scripts/make-sync-fixtures.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/assets/dev/sync"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
DUR=12

command -v ffmpeg >/dev/null || { echo "ffmpeg not found (brew install ffmpeg)"; exit 1; }
mkdir -p "$OUT"
rm -f "$OUT"/*.mp4

# An event while frac(t + 0.5) is small: the flash covers 2 frames at 30 fps, the click 5 ms.
FLASH="lt(mod(t+0.5\,1)\,0.06)"
# The bar slides in as an overlay: drawbox evaluates its width once, so it can't grow over time.
VF="[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=white:thickness=fill:enable='${FLASH}'[flash];"
VF="${VF}[flash][2:v]overlay=x='W*t/${DUR}-w':y=H-h:shortest=1,transpose=1[v]"
CLICK="if(lt(mod(t+0.5\,1)\,0.005)\,0.8*sin(2*PI*2000*t)\,0)"

for rate in 48000 44100; do
  name="sync-$((rate / 1000))k"
  echo ">>> $name (${rate} Hz mono, ${DUR}s)"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "color=c=black:s=1080x1920:r=30:d=${DUR}" \
    -f lavfi -i "aevalsrc=${CLICK}:s=${rate}:d=${DUR}" \
    -f lavfi -i "color=c=yellow:s=1080x18:r=30:d=${DUR}" \
    -filter_complex "$VF" -map "[v]" -map 1:a \
    -c:v libx264 -preset veryfast -crf 24 -profile:v high -pix_fmt yuv420p -g 30 -bf 0 \
    -c:a aac -b:a 128k -ac 1 "$TMP/$name.tmp.mov"
  ffmpeg -hide_banner -loglevel error -y -display_rotation 90 -i "$TMP/$name.tmp.mov" \
    -c copy -f mov -movflags +faststart "$OUT/$name.mp4"
done

ls -la "$OUT"
