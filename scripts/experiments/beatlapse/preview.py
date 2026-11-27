#!/usr/bin/env python3
"""Make a silent beatlapse from a local recording on a Mac."""

import argparse
import json
import math
from pathlib import Path
import re
import subprocess
import tempfile

from activity import WIDTH, HEIGHT, activity_flags, motion_ranges, stage_indices
from style_render import FPS, render_moving, render_stills


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


def sample_frames(source, directory, spacing, *, gray=False):
    # Both analyses see the same first picture on or after each clip-relative grid time.
    grid = f"setpts=PTS-STARTPTS,select='gte(t,selected_n*{spacing}-0.000001)',showinfo"
    if gray:
        resize = (f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease:flags=area,"
                  f"pad={WIDTH}:{HEIGHT}:(ow-iw)/2:(oh-ih)/2,format=gray")
        options = ["-f", "rawvideo", directory / "frames.gray"]
    else:
        resize = "scale=320:320:force_original_aspect_ratio=decrease"
        options = ["-q:v", "3", directory / "f%08d.jpg"]
    result = subprocess.run([
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "info", "-i", source,
        "-map", "0:v:0", "-vf", f"{grid},{resize}", "-frames:v", str(MAX_SAMPLES + 1),
        "-fps_mode", "passthrough", *options,
    ], check=True, stderr=subprocess.PIPE, text=True)
    times = [float(value) for value in re.findall(
        r"Parsed_showinfo_[^\n]*?\bn:\s*\d+[^\n]*?\bpts_time:\s*([-\d.e+]+)", result.stderr
    )]
    if not times or len(times) > MAX_SAMPLES:
        raise ValueError(f"Expected between 1 and {MAX_SAMPLES} frame samples. Check --sample.")
    if any(abs(t - i * spacing) > spacing / 2 for i, t in enumerate(times)):
        raise ValueError("A frame gap exceeds half the sampling interval. Increase --sample.")
    return times


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


def highlights(source, work, duration, budget, window, spacing):
    frames = work / "frames"
    frames.mkdir()
    times = sample_frames(source, frames, spacing)
    if len(list(frames.glob("*.jpg"))) != len(times):
        raise ValueError("Unable to match frame samples with their source timestamps.")
    native = work / "distances"
    subprocess.run([
        "swiftc", "-O", Path(__file__).with_name("distances.swift"), "-o", native,
    ], check=True)
    span = min(MAX_SAMPLES, round(window / spacing))
    limit = min(MAX_SAMPLES, math.floor(budget / window))
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
    render(source, cuts, work / "beatlapse.mp4")
    return "cuts.json", cuts


def moving_plan(source, intervals, budget, requested_speed, work):
    kept = sum(end - start for start, end in intervals)
    speed = requested_speed or max(1.0, kept / budget)
    if budget is not None and kept / speed > budget + 1e-6:
        raise ValueError(f"These intervals need {kept / speed:.2f}s at {speed:g}x. "
                         "Increase the budget or omit --speed to fit automatically.")
    max_frames = (math.floor(budget * FPS) if budget is not None
                  else max(1, math.ceil(kept / speed * FPS)))
    render_moving(source, intervals, speed, max_frames, work / "beatlapse.mp4")
    return {"playbackRate": speed, "intervals": [
        {"start": start, "end": end} for start, end in intervals
    ]}


def visual_edit(source, work, duration, args):
    style, budget = args.style, args.budget
    if style == "continuous":
        plan = moving_plan(source, [(0.0, duration)], budget, args.speed, work)
    else:
        times = sample_frames(source, work, args.sample, gray=True)
        with (work / "frames.gray").open("rb") as stream:
            frames = [stream.read(WIDTH * HEIGHT) for _ in times]
            if len(frames[-1]) != WIDTH * HEIGHT or stream.read(1):
                raise ValueError("Unable to match gray samples with their source timestamps.")
        active = activity_flags(frames)
        if style == "action":
            intervals = motion_ranges(times, active, duration)
            if not intervals:
                raise ValueError("No visible activity detected at this sampling interval.")
            plan = moving_plan(source, intervals, budget, args.speed, work)
        else:
            # Allow each card at least one second if the total budget permits.
            limit = max(1, math.floor(budget))
            if args.max_stages is not None:
                limit = min(limit, args.max_stages)
            indices = stage_indices(frames, times, active, limit)
            if not indices:
                raise ValueError("No changed view settled for a full second. "
                                 "Continuous playback can show this recording.")
            hold_frames = min(3 * FPS, math.floor(budget * FPS / len(indices)))
            render_stills(source, args.sample, indices, hold_frames, work / "beatlapse.mp4")
            plan = {"holdFrames": hold_frames, "framesPerSecond": FPS,
                    "stills": [{"sourceTime": times[i]} for i in indices]}
        plan["sampledFrames"] = len(times)
        plan["changedTransitions"] = sum(active)
    return "edit.json", {"style": style, **plan}


def preview(args):
    duration = video_duration(args.source)
    if args.style != "continuous" and duration / args.sample > MAX_SAMPLES:
        raise ValueError(f"At most {MAX_SAMPLES} frame samples per run. Increase --sample.")
    # Reserve a new directory exclusively. Stage all outputs before publishing.
    args.output.mkdir()
    published = []
    try:
        with tempfile.TemporaryDirectory(dir=args.output.parent) as scratch:
            work = Path(scratch)
            if args.style == "highlights":
                name, plan = highlights(args.source, work, duration, args.budget, args.window, args.sample)
            else:
                name, plan = visual_edit(args.source, work, duration, args)
            (work / name).write_text(json.dumps(plan, indent=2) + "\n")
            for filename in [name, "beatlapse.mp4"]:
                target = args.output / filename
                target.hardlink_to(work / filename)
                published.append(target)
    except BaseException:
        for target in published:
            target.unlink()
        args.output.rmdir()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog=(
        "Requires macOS 14+, swiftc, Python 3.10+, and ffmpeg/ffprobe with libx264. "
        "The output directory must be new and its parent must exist."
    ))
    parser.add_argument("source", type=Path, help="local video file")
    parser.add_argument("output", type=Path, help="new directory for the edit decisions and beatlapse.mp4")
    parser.add_argument("--style", choices=["highlights", "continuous", "action", "stages"],
                        default="highlights", help="what the viewer wants to see")
    parser.add_argument("--budget", type=float, help="maximum output seconds (default 8 unless --speed is set)")
    parser.add_argument("--speed", type=float, help="fixed playback rate (1 or higher) for continuous or action")
    parser.add_argument("--max-stages", type=int, help="maximum completed states to show in stages mode")
    parser.add_argument("--window", type=float, default=2, help="seconds per highlights excerpt")
    parser.add_argument("--sample", type=float, default=0.5, help="seconds between sampled frames")
    args = parser.parse_args()
    if not args.source.is_file():
        parser.error("Expected a local video file.")
    if args.speed is not None:
        if args.style not in ("action", "continuous") or not math.isfinite(args.speed) or args.speed < 1:
            parser.error("--speed requires action or continuous style and a finite rate of at least 1.")
    elif args.budget is None:
        args.budget = 8.0
    if args.max_stages is not None and (args.style != "stages" or args.max_stages < 1):
        parser.error("--max-stages requires stages style and a positive integer.")
    if args.budget is not None:
        if not math.isfinite(args.budget) or args.budget <= 0:
            parser.error("The budget must be positive and finite.")
        if args.style != "highlights" and (not math.isfinite(args.budget * FPS) or args.budget < 1 / FPS):
            parser.error("The budget must allow at least one output frame.")
    if not all(math.isfinite(n) and n > 0 for n in (args.sample, args.window)):
        parser.error("Window and sampling interval must be positive and finite.")
    if args.style == "highlights":
        ratio = args.window / args.sample
        if (args.window > args.budget or ratio < 1 or not math.isfinite(ratio)
                or not math.isclose(ratio, round(ratio)) or not math.isfinite(args.budget / args.window)):
            parser.error("Window must fit the budget and be an integer multiple of sample spacing.")
    try:
        preview(args)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")
    print(f"Saved {args.style} preview to {args.output}")


if __name__ == "__main__":
    main()
