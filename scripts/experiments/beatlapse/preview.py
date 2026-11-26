#!/usr/bin/env python3
"""Select a silent, chronological beatlapse locally on a Mac using Apple Vision."""

import argparse
import json
import math
from pathlib import Path
import re
import subprocess
import tempfile


MAX_SAMPLES = 1500


def video_duration(source):
    result = subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "format=duration:stream=duration", "-of", "json", source,
    ])
    probe = json.loads(result)
    if not probe["streams"]:
        raise ValueError("The input has no video track.")
    duration = float(probe["streams"][0].get("duration") or probe["format"]["duration"])
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("The video needs a known, positive duration.")
    return duration


def sample_frames(source, directory, spacing):
    # Keep the first picture on or after each clip-relative grid time. Check source
    # timestamps so sparse/VFR footage cannot silently shift the cut list.
    filters = (
        f"setpts=PTS-STARTPTS,select='gte(t,selected_n*{spacing}-0.000001)',"
        "showinfo,scale=320:320:force_original_aspect_ratio=decrease"
    )
    result = subprocess.run([
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "info", "-i", source,
        "-map", "0:v:0", "-vf", filters, "-frames:v", str(MAX_SAMPLES + 1),
        "-fps_mode", "passthrough", "-q:v", "3", directory / "f%08d.jpg",
    ], check=True, stderr=subprocess.PIPE, text=True)
    ticks = [float(value) for value in re.findall(
        r"Parsed_showinfo_[^\n]*?\bn:\s*\d+[^\n]*?\bpts_time:\s*([-\d.e+]+)", result.stderr
    )]
    count = len(list(directory.glob("*.jpg")))
    if count > MAX_SAMPLES:
        raise ValueError(f"More than {MAX_SAMPLES} pictures. Increase --sample.")
    if not ticks or len(ticks) != count:
        raise ValueError("Unable to match frame samples with their source timestamps.")
    if any(abs(tick - index * spacing) > spacing / 2 for index, tick in enumerate(ticks)):
        raise ValueError("A frame gap exceeds half the sampling interval. Increase --sample.")
    return count


def render(source, cuts, destination):
    # Each trim runs in the source video's time base. Normalize nonzero track start
    # times before trimming, then reset each excerpt's start for concatenation.
    pieces = []
    for index, cut in enumerate(cuts):
        pieces.append(
            f"[0:v]setpts=PTS-STARTPTS,trim=start={cut['start']}:end={cut['end']},"
            f"setpts=PTS-STARTPTS[beat{index}]"
        )
    inputs = "".join(f"[beat{i}]" for i in range(len(cuts)))
    pieces.append(f"{inputs}concat=n={len(cuts)}:v=1:a=0,scale=640:-2,setsar=1[out]")
    subprocess.run([
        "ffmpeg", "-nostdin", "-v", "error", "-i", source, "-filter_complex", ";".join(pieces),
        "-map", "[out]", "-an", "-c:v", "libx264", "-crf", "23", "-preset", "fast",
        "-movflags", "+faststart", destination,
    ], check=True)


def preview(source, output, budget, window, spacing):
    duration = video_duration(source)
    if duration / spacing > MAX_SAMPLES:
        raise ValueError(f"At most {MAX_SAMPLES} frame samples per run. Increase --sample.")
    span = min(MAX_SAMPLES, round(window / spacing))
    limit = min(MAX_SAMPLES, math.floor(budget / window))
    # Reserve a new directory exclusively. Stage all outputs before publishing.
    output.mkdir()
    published = []
    try:
        with tempfile.TemporaryDirectory(dir=output.parent) as scratch:
            work = Path(scratch)
            frames = work / "frames"
            frames.mkdir()
            count = sample_frames(source, frames, spacing)
            native = work / "distances"
            subprocess.run([
                "swiftc", "-O", Path(__file__).with_name("distances.swift"), "-o", native,
            ], check=True)
            chosen = json.loads(subprocess.check_output([
                native, frames, str(span), str(limit), str(MAX_SAMPLES),
            ]))
            cuts = []
            for item in chosen:
                index = item["startIndex"]
                start = index * spacing
                end = min((index + span) * spacing, duration)
                if start >= end:
                    raise ValueError("Decoded sample times exceed the probed video duration.")
                cuts.append({"start": start, "end": end, "reason": item["reason"]})
            (work / "cuts.json").write_text(json.dumps(cuts, indent=2) + "\n")
            render(source, cuts, work / "beatlapse.mp4")
            for name in ["cuts.json", "beatlapse.mp4"]:
                target = output / name
                target.hardlink_to(work / name)
                published.append(target)
            return count, len(cuts)
    except BaseException:
        for target in published:
            target.unlink()
        output.rmdir()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog=(
        "Requires macOS 14+, swiftc, Python 3.10+, and ffmpeg/ffprobe with libx264. "
        "The output directory must be new and its parent must exist."
    ))
    parser.add_argument("source", type=Path, help="local video file")
    parser.add_argument("output", type=Path, help="new directory for cuts.json and beatlapse.mp4")
    parser.add_argument("--budget", type=float, default=8, help="maximum output seconds")
    parser.add_argument("--window", type=float, default=2, help="seconds per excerpt")
    parser.add_argument("--sample", type=float, default=0.5, help="seconds between sampled frames")
    args = parser.parse_args()
    if not args.source.is_file():
        parser.error("Expected a local video file.")
    if not all(math.isfinite(n) and n > 0 for n in (args.sample, args.window, args.budget)):
        parser.error("All time parameters must be positive and finite.")
    ratio = args.window / args.sample
    if (args.window > args.budget or ratio < 1 or not math.isfinite(ratio)
            or not math.isclose(ratio, round(ratio)) or not math.isfinite(args.budget / args.window)):
        parser.error("Window must fit the budget and be an integer multiple of sample spacing.")
    try:
        frames, cuts = preview(args.source, args.output, args.budget, args.window, args.sample)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")
    print(f"Selected {cuts} excerpts from {frames} sampled frames in {args.output}")


if __name__ == "__main__":
    main()
