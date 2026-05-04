#!/usr/bin/env python3
"""Whisper transcription helper for the AI Video Editor backend.

Runs faster-whisper on a single video/audio file and prints a JSON object
to stdout with the SRT, VTT, plain text, words (optional), and an
editPlan (optional). Designed to be spawned by the Node.js server (see
server/index.js / api/transcribe).

Output (stdout):
{
  "srt":      "...",
  "vtt":      "...",
  "text":     "...",
  "segments": [{"start": 0.0, "end": 1.2, "text": "hello"}, ...],
  "words":    [{"word": "hello", "start": 0.0, "end": 0.4}, ...],   // when --filler-mode != off
  "language": "ko",
  "duration": 12.3,
  "editPlan": {                                                      // when --filler-mode != off
    "cuts":          [{"start": 1.2, "end": 1.4, "reason": "filler", "word": "어"}, ...],
    "speedSegments": [{"start": 60.0, "end": 72.0, "speed": 1.25, "reason": "slow_speech"}, ...],
    "ngCandidates":  [{"start": 80.0, "end": 92.0, "reason": "repeated_take_candidate"}, ...]
  }
}
"""

from __future__ import annotations

import argparse
import difflib
import json
import sys
from datetime import timedelta


# 한국어 자주 쓰이는 필러/추임새. "보수적" 모드는 의미가 거의 없는 것만, "강하게" 모드는 더 넓게.
FILLERS_CONSERVATIVE = {"어", "음", "엄", "아"}
FILLERS_AGGRESSIVE = FILLERS_CONSERVATIVE | {"그", "그러니까", "이제", "약간", "뭐", "그냥"}

# 너무 짧은 필러를 자르면 오디오 팝/클릭 발생 → 앞뒤 패딩 (초)
FILLER_PAD_CONSERVATIVE = 0.10
FILLER_PAD_AGGRESSIVE = 0.06

# 말 늘어짐 임계 (words per second) — 한국어 평균 4~6 단어/초.
SLOW_WPS_THRESHOLD = 2.5
SLOW_SPEED = 1.25

# NG 후보: 텍스트 유사도 + 인접 chunk 길이 비교
NG_CHUNK_SIZE_S = 8.0     # chunk 한 개의 목표 길이
NG_SIMILARITY_THRESHOLD = 0.65


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


def _normalize_word(raw: str) -> str:
    """필러 매칭용 정규화 — 양 공백·문장부호 제거 후 lowercase."""
    return raw.strip().strip(".,!?…\"'~ ").lower()


def detect_filler_cuts(words: list[dict], mode: str) -> list[dict]:
    """word-level 결과에서 필러 단어를 찾아 cut 후보 반환.

    Args:
        words: [{"word": "...", "start": float, "end": float}, ...]
        mode: "conservative" | "aggressive"
    """
    if mode == "off" or not words:
        return []
    vocab = FILLERS_AGGRESSIVE if mode == "aggressive" else FILLERS_CONSERVATIVE
    pad = FILLER_PAD_AGGRESSIVE if mode == "aggressive" else FILLER_PAD_CONSERVATIVE
    cuts = []
    for w in words:
        norm = _normalize_word(w.get("word") or "")
        if not norm or norm not in vocab:
            continue
        start = max(0.0, float(w["start"]) - pad)
        end = float(w["end"]) + pad
        if end - start <= 0:
            continue
        cuts.append({
            "start": start,
            "end": end,
            "reason": "filler",
            "word": norm,
        })
    return _merge_overlapping(cuts)


def _merge_overlapping(cuts: list[dict]) -> list[dict]:
    """근접/겹치는 cut 들을 하나로 합쳐 audio pop 회피 + 효율."""
    if not cuts:
        return []
    cuts = sorted(cuts, key=lambda c: c["start"])
    merged = [dict(cuts[0])]
    for c in cuts[1:]:
        last = merged[-1]
        if c["start"] <= last["end"] + 0.05:
            last["end"] = max(last["end"], c["end"])
            # reason 은 그대로 유지(첫 컷의 사유)
        else:
            merged.append(dict(c))
    return merged


def compute_speed_segments(segments: list[dict]) -> list[dict]:
    """segment 별 말 속도 계산 → 느린 segment 만 1.25x 가속 후보로 표시."""
    plan = []
    for s in segments:
        text = (s.get("text") or "").strip()
        if not text:
            continue
        dur = float(s["end"]) - float(s["start"])
        if dur <= 0:
            continue
        # 한국어는 띄어쓰기로 단어 분리. 영어/중국어 등 다른 언어와 정확도 다를 수 있음.
        words_in_seg = len(text.split())
        wps = words_in_seg / dur
        if wps < SLOW_WPS_THRESHOLD:
            plan.append({
                "start": float(s["start"]),
                "end": float(s["end"]),
                "speed": SLOW_SPEED,
                "reason": "slow_speech",
                "wps": round(wps, 2),
            })
    return plan


def detect_ng_candidates(segments: list[dict]) -> list[dict]:
    """반복 take 의심 chunk 를 검출. 첫 버전에선 자동 삭제하지 않고 후보만 표시.

    인접 chunk 의 텍스트 유사도가 높고 앞 chunk 가 더 짧으면 (= 말 끊고 다시 말한 패턴)
    앞 chunk 를 NG 후보로 표시.
    """
    if not segments:
        return []
    chunks = _group_segments_into_chunks(segments, NG_CHUNK_SIZE_S)
    candidates = []
    for i in range(len(chunks) - 1):
        a, b = chunks[i], chunks[i + 1]
        if not a["text"].strip() or not b["text"].strip():
            continue
        sim = difflib.SequenceMatcher(None, a["text"], b["text"]).ratio()
        if sim >= NG_SIMILARITY_THRESHOLD and a["duration"] <= b["duration"]:
            candidates.append({
                "start": a["start"],
                "end": a["end"],
                "reason": "repeated_take_candidate",
                "similarity": round(sim, 2),
                "next_text_preview": b["text"][:60],
            })
    return candidates


def _group_segments_into_chunks(segments: list[dict], target_s: float) -> list[dict]:
    chunks: list[dict] = []
    cur_start = None
    cur_text = []
    cur_end = 0.0
    for s in segments:
        if cur_start is None:
            cur_start = float(s["start"])
        cur_text.append((s.get("text") or "").strip())
        cur_end = float(s["end"])
        if cur_end - cur_start >= target_s:
            chunks.append({
                "start": cur_start,
                "end": cur_end,
                "duration": cur_end - cur_start,
                "text": " ".join(t for t in cur_text if t),
            })
            cur_start = None
            cur_text = []
    # tail
    if cur_start is not None and cur_text:
        chunks.append({
            "start": cur_start,
            "end": cur_end,
            "duration": cur_end - cur_start,
            "text": " ".join(t for t in cur_text if t),
        })
    return chunks


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="입력 영상/오디오 파일 경로")
    ap.add_argument("--language", default="ko", help="ISO-639-1 언어 코드 (기본 ko)")
    # tiny 가 Render Free 의 메모리/CPU 한계에서 가장 안정적. 더 큰 모델이 필요하면
    # WHISPER_MODEL 환경변수 또는 --model 인자로 override.
    ap.add_argument("--model", default="tiny", help="tiny / base / small / medium / large")
    ap.add_argument("--compute-type", default="int8",
                    help="ctranslate2 compute type (int8 가 CPU 에서 가장 빠름)")
    ap.add_argument("--beam-size", type=int, default=1,
                    help="디코딩 beam 크기. 1 이 가장 빠름 (정확도 약간 손실)")
    ap.add_argument("--filler-mode", default="off",
                    choices=["off", "conservative", "aggressive"],
                    help="off 면 자막만 생성. conservative/aggressive 면 word-level + editPlan 도 반환")
    args = ap.parse_args()

    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device="auto", compute_type=args.compute_type)

    want_words = args.filler_mode != "off"
    segments_iter, info = model.transcribe(
        args.input,
        language=args.language,
        vad_filter=True,
        word_timestamps=want_words,
        beam_size=args.beam_size,
    )

    segments: list[dict] = []
    words: list[dict] = []
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
        if want_words and getattr(s, "words", None):
            for w in s.words:
                wt = (w.word or "").strip()
                if not wt:
                    continue
                words.append({
                    "word": wt,
                    "start": float(w.start),
                    "end": float(w.end),
                    "probability": getattr(w, "probability", None),
                })

    out: dict = {
        "srt": "\n".join(srt_chunks),
        "vtt": "\n".join(vtt_chunks),
        "text": " ".join(text_chunks),
        "segments": segments,
        "language": info.language,
        "duration": float(info.duration),
    }

    if want_words:
        out["words"] = words
        out["editPlan"] = {
            "cuts": detect_filler_cuts(words, args.filler_mode),
            "speedSegments": compute_speed_segments(segments),
            "ngCandidates": detect_ng_candidates(segments),
        }

    json.dump(out, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
