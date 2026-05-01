"""Detect silent regions in audio using ffmpeg's silencedetect filter."""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path


_START_RE = re.compile(r"silence_start: (-?\d+\.?\d*)")
_END_RE = re.compile(r"silence_end: (-?\d+\.?\d*) \| silence_duration: (-?\d+\.?\d*)")


@dataclass
class Segment:
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


def detect_silences(
    path: Path,
    noise_db: float = -32.0,
    min_silence: float = 0.6,
) -> list[Segment]:
    """Run ffmpeg silencedetect and parse stderr for silence ranges."""
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-i", str(path),
        "-af", f"silencedetect=noise={noise_db}dB:d={min_silence}",
        "-f", "null",
        "-",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    log = result.stderr

    silences: list[Segment] = []
    pending_start: float | None = None
    for line in log.splitlines():
        if (m := _START_RE.search(line)):
            pending_start = float(m.group(1))
        elif (m := _END_RE.search(line)):
            end = float(m.group(1))
            if pending_start is not None:
                silences.append(Segment(start=max(0.0, pending_start), end=end))
                pending_start = None
    return silences


def keep_segments(
    duration: float,
    silences: list[Segment],
    padding: float = 0.1,
) -> list[Segment]:
    """Invert silences into 'keep' segments, applying padding around cuts."""
    keeps: list[Segment] = []
    cursor = 0.0
    for s in silences:
        cut_start = max(cursor, s.start + padding)
        cut_end = min(duration, s.end - padding)
        if cut_start > cursor + 0.05:
            keeps.append(Segment(cursor, min(cut_start, duration)))
        cursor = max(cursor, cut_end)
    if cursor < duration - 0.05:
        keeps.append(Segment(cursor, duration))
    # Merge zero-length / near-zero keeps
    return [k for k in keeps if k.duration > 0.1]
