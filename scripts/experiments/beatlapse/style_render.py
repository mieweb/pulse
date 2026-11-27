"""Silent, 30 fps previews. All source times are relative to the first video frame."""

import json
import math
from pathlib import Path
import re
import subprocess


FPS = 30
# Keep the displayed aspect ratio, including anamorphic pixels. ffmpeg applies
# the input display matrix before video filters, as it does in the analysis pass.
SCALE = "scale=640:'max(2,2*round(320/dar))'"


def _encode(source, filters, frames, destination, *, hold_frames=None):
    source = Path(source).resolve(strict=True)
    destination = Path(destination).resolve()
    if not source.is_file() or destination.exists():
        raise ValueError("Expected an input file and a new output file.")
    # Begin each hold with one detailed I-frame (roughly QP23). Subsequent
    # unchanged pictures can reference it at very low bitrate.
    codec_options = (["-g", str(hold_frames), "-bf", "0", "-qp", "51",
                      "-x264-params", "scenecut=0:ipratio=26"]
                     if hold_frames else ["-crf", "23"])
    result = subprocess.run([
        "ffmpeg", "-nostdin", "-n", "-hide_banner", "-v", "info" if hold_frames else "error",
        "-i", source, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", filters,
        "-frames:v", str(frames), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast", *codec_options,
        "-map_metadata", "-1", "-map_chapters", "-1", "-write_tmcd", "0",
        "-movflags", "+faststart", destination,
    ], stderr=subprocess.PIPE, text=True)
    if result.returncode:
        raise ValueError(f"Could not render preview: {result.stderr.strip()[-1200:]}")
    info = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,nb_frames,avg_frame_rate",
        "-of", "json", destination,
    ]))
    streams = info["streams"]
    if (len(streams) != 1 or streams[0]["codec_type"] != "video"
            or streams[0].get("avg_frame_rate") != "30/1"
            or int(streams[0].get("nb_frames", 0)) != frames):
        raise ValueError("The encoded preview does not match the planned frame count and rate.")
    return result.stderr


def _interval_expression(starts, values, variable):
    """Choose the leaf for this timestamp using a balanced ffmpeg expression."""
    def build(left, right):
        if right - left == 1:
            return values[left]
        mid = (left + right) // 2
        return f"if(lt({variable},{starts[mid]}),{build(left, mid)},{build(mid, right)})"

    return build(0, len(starts))


def render_moving(source, intervals, speed, max_frames, destination):
    if not intervals or not math.isfinite(speed) or speed <= 0 or max_frames < 1:
        raise ValueError("Moving playback needs source intervals, a positive speed and a frame budget.")
    starts, keep, gaps = [], [], []
    duration = 0.0
    previous_end = 0.0
    for start, end in intervals:
        if not (math.isfinite(start) and math.isfinite(end) and previous_end <= start < end):
            raise ValueError("Source intervals must be finite, ordered and nonoverlapping.")
        starts.append(start)
        keep.append(f"gte(t,{start})*lt(t,{end})")
        gaps.append(str(start - duration))
        duration += end - start
        previous_end = end
    frames = min(max_frames, max(1, math.floor(FPS * duration / speed + 0.5)))
    # Concatenate in clip-relative time before quantizing once to the playback
    # grid. Rounding each fast excerpt independently would accumulate frame drift.
    select = _interval_expression(starts, keep, "t")
    skipped = _interval_expression(starts, gaps, "T")
    filters = (
        f"settb=AVTB,setpts=PTS-STARTPTS,select='{select}',"
        f"setpts='(PTS-({skipped})/TB)/{speed}',{SCALE},"
        f"tpad=stop_mode=clone:stop=-1,fps={FPS}:start_time=0"
    )
    _encode(source, filters, frames, destination)


def render_stills(source, spacing, indices, hold_frames, destination):
    if (not math.isfinite(spacing) or spacing <= 0 or hold_frames < 1 or not indices
            or indices[0] < 0 or any(right <= left for left, right in zip(indices, indices[1:]))):
        raise ValueError("Stages need ordered, unique frame indices and a positive hold.")
    # First select the same sampled pictures used in analysis. The second select
    # uses their indices; the full-resolution originals go straight to the encoder.
    select = _interval_expression(indices, [f"eq(n,{i})" for i in indices], "n")
    filters = (
        f"setpts=PTS-STARTPTS,select='gte(t,selected_n*{spacing}-0.000001)',"
        f"select='{select}',showinfo=checksum=0,{SCALE},settb=1/{FPS},"
        f"setpts=N*{hold_frames},tpad=stop_mode=clone:stop=-1,fps={FPS}:start_time=0"
    )
    log = _encode(source, filters, len(indices) * hold_frames, destination, hold_frames=hold_frames)
    if len(re.findall(r"Parsed_showinfo_[^\n]*?\bn:\s*\d+[^\n]*?\bpts_time:", log)) != len(indices):
        raise ValueError("Unable to decode all requested stage frames.")
