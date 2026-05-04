#!/usr/bin/env python3
"""Whisper transcription helper for the AI Video Editor backend.

Runs faster-whisper on a single video/audio file and prints a JSON object
to stdout with the SRT, VTT, plain text, and metadata. Designed to be
spawned by the Node.js server (see server/index.js / api/transcribe).

Output (stdout):
{
  "srt":      "1\\n00:00:00,000 --> ...\\nhello\\n\\n2\\n...",
  "vtt":      "WEBVTT\\n\\n00:00:00.000 --> ...\\nhello\\n\\n...",
  "text":     "hello world ...",
  "segments": [{"start": 0.0, "end": 1.2, "text": "hello"}, ...],
  "language": "ko",
  "duration": 12.3
}
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import timedelta


def fmt_srt(seconds: float) -> str:
    if seconds < 0:
        seconds = 0.0
    td = timedelta(seconds=seconds)
    total = td.total_seconds()
    h = int(total // 3600)
    m = int((total % 3600) // 60)
    s = total % 60
    # SRT uses comma as decimal separator
    return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ",")


def fmt_vtt(seconds: float) -> str:
    return fmt_srt(seconds).replace(",", ".")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="입력 영상/오디오 파일 경로")
    ap.add_argument("--language", default="ko", help="ISO-639-1 언어 코드 (기본 ko)")
    ap.add_argument("--model", default="small", help="tiny / base / small / medium / large")
    ap.add_argument(
        "--compute-type", default="int8",
        help="ctranslate2 compute type (int8 가 CPU 에서 가장 빠름)",
    )
    args = ap.parse_args()

    # faster-whisper 는 CPU/GPU 자동 선택. Render 컨테이너는 CPU 만.
    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device="auto", compute_type=args.compute_type)
    segments_iter, info = model.transcribe(
        args.input,
        language=args.language,
        vad_filter=True,
        word_timestamps=False,
    )

    segments: list[dict] = []
    srt_chunks: list[str] = []
    vtt_chunks: list[str] = ["WEBVTT", ""]
    text_chunks: list[str] = []

    idx = 1
    for s in segments_iter:
        text = (s.text or "").strip()
        if not text:
            continue
        start, end = float(s.start), float(s.end)
        segments.append({"start": start, "end": end, "text": text})
        srt_chunks.append(f"{idx}\n{fmt_srt(start)} --> {fmt_srt(end)}\n{text}\n")
        vtt_chunks.append(f"{fmt_vtt(start)} --> {fmt_vtt(end)}\n{text}\n")
        text_chunks.append(text)
        idx += 1

    json.dump(
        {
            "srt": "\n".join(srt_chunks),
            "vtt": "\n".join(vtt_chunks),
            "text": " ".join(text_chunks),
            "segments": segments,
            "language": info.language,
            "duration": float(info.duration),
        },
        sys.stdout,
        ensure_ascii=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
