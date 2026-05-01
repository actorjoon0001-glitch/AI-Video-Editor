"""Transcribe audio with faster-whisper into timed subtitle segments."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass
class Subtitle:
    start: float
    end: float
    text: str


def transcribe(
    path: Path,
    model_name: str = "small",
    language: str = "ko",
) -> list[Subtitle]:
    from faster_whisper import WhisperModel

    model = WhisperModel(model_name, device="auto", compute_type="auto")
    segments, _info = model.transcribe(
        str(path),
        language=language,
        vad_filter=True,
        word_timestamps=False,
    )
    return [
        Subtitle(start=float(s.start), end=float(s.end), text=s.text.strip())
        for s in segments
        if s.text and s.text.strip()
    ]


def remap_subtitles(
    subtitles: list[Subtitle],
    keeps: list[tuple[float, float]],
) -> list[Subtitle]:
    """Translate subtitle timestamps from original timeline to cut timeline.

    `keeps` is the list of (start, end) ranges that survived cutting, in order.
    Subtitles fully within a kept range are shifted; ones overlapping a cut are clipped.
    """
    out: list[Subtitle] = []
    elapsed = 0.0
    for k_start, k_end in keeps:
        for sub in subtitles:
            ov_start = max(sub.start, k_start)
            ov_end = min(sub.end, k_end)
            if ov_end - ov_start <= 0.05:
                continue
            new_start = elapsed + (ov_start - k_start)
            new_end = elapsed + (ov_end - k_start)
            out.append(Subtitle(start=new_start, end=new_end, text=sub.text))
        elapsed += k_end - k_start
    return out
