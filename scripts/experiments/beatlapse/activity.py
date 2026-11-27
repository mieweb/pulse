"""Detect moving intervals and settled stages from the same chronological grayscale samples."""

from itertools import groupby
from math import floor

WIDTH = 160
HEIGHT = 90
# The strong threshold ignores small fluctuations between decoded still frames.
# Three neighboring changed pixels distinguish a small stroke from a hot pixel.
STRONG_LUMA_CHANGE = 20
# Broad low-contrast motion can change many pixels without any strong edges.
SOFT_LUMA_CHANGE = 8
SOFT_FRACTION = 0.08
_SOFT_MASK = bytes(int(value >= SOFT_LUMA_CHANGE) for value in range(256))
_STRONG_MASK = bytes(int(value >= STRONG_LUMA_CHANGE) for value in range(256))
EDGE_CONTEXT_SECONDS = 0.2
JOIN_PAUSES_SECONDS = 0.5


def visibly_changed(before, after):
    """True for a small coherent change or widespread modest luminance change."""
    if len(before) != WIDTH * HEIGHT or len(after) != len(before):
        raise ValueError("Activity detection expects 160 × 90 grayscale samples.")
    changes = bytes(abs(a - b) for a, b in zip(before, after))
    if changes.translate(_SOFT_MASK).count(1) >= len(changes) * SOFT_FRACTION:
        return True
    strong = changes.translate(_STRONG_MASK)
    if strong.count(1) < 3:
        return False
    # In any two-by-two block with three changed pixels one row is a pair.
    pair = strong.find(b"\x01\x01")
    while pair != -1:
        if pair % WIDTH != WIDTH - 1:
            above = pair - WIDTH
            below = pair + WIDTH
            if above >= 0 and (strong[above] or strong[above + 1]):
                return True
            if below + 1 < len(strong) and (strong[below] or strong[below + 1]):
                return True
        pair = strong.find(b"\x01\x01", pair + 1)
    return False


def activity_flags(frames):
    """flags[i] describes the transition from picture i to picture i+1."""
    return [visibly_changed(before, after) for before, after in zip(frames, frames[1:])]


def motion_ranges(times, active, duration):
    """Source intervals of visible activity, with brief context at each end."""
    if len(active) != max(0, len(times) - 1):
        raise ValueError("Every pair of sampled pictures needs an activity flag.")
    ranges = []
    for i, changed in enumerate(active):
        if not changed:
            continue
        start, end = times[i], times[i + 1]
        if i + 1 == len(times) - 1:
            end = duration
        if ranges and start - ranges[-1][1] <= JOIN_PAUSES_SECONDS:
            ranges[-1] = (ranges[-1][0], end)
        else:
            ranges.append((start, end))
    return [(max(0, start - EDGE_CONTEXT_SECONDS), min(duration, end + EDGE_CONTEXT_SECONDS))
            for start, end in ranges]


MIN_SETTLED_SECONDS = 1.0


def stage_indices(frames, times, active, max_stages):
    """Return at most max_stages source frame indices, in chronological order.

    active[i] describes the transition between frames i and i+1. A stage needs
    evidence of change followed by a sustained quiet interval. A static opening
    is the baseline, and a recording in continuous motion may have no stages.
    """
    if len(frames) != len(times) or len(active) != max(0, len(frames) - 1):
        raise ValueError("Expected one time per frame and one activity flag per adjacent pair.")
    if max_stages < 1:
        raise ValueError("The stage limit must be at least one.")

    settled = []
    previous = 0
    for moving, transitions in groupby(range(len(active)), key=active.__getitem__):
        if moving:
            continue
        edges = list(transitions)
        first, last = edges[0], edges[-1] + 1
        if first == 0 or times[last] - times[first] < MIN_SETTLED_SECONDS:
            continue
        # Choose a real sampled picture in the middle of the quiet interval,
        # away from the moving pictures at either edge.
        center = (times[first] + times[last]) / 2
        still = min(range(first, last + 1), key=lambda index: abs(times[index] - center))
        if visibly_changed(frames[previous], frames[still]):
            settled.append(still)
            previous = still

    if len(settled) <= max_stages:
        return settled
    if max_stages == 1:
        return settled[-1:]
    # Spread the available cards across the completed steps. Keep both ends and
    # prefer the later state if two interior candidates are equally spaced.
    stride = (len(settled) - 1) / (max_stages - 1)
    return [settled[floor(slot * stride + 0.5)] for slot in range(max_stages)]
