"""End-to-end pipeline: probe → cut → transcribe → CapCut draft."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from auto_editor.capcut_draft import ClipPlan, build_draft, write_draft
from auto_editor.probe import probe
from auto_editor.silence import Segment, detect_silences, keep_segments
from auto_editor.transcribe import remap_subtitles, transcribe


@dataclass
class EditOptions:
    project_name: str = "auto_edit"
    silence_db: float = -32.0
    min_silence: float = 0.6
    padding: float = 0.1
    whisper_model: str = "small"
    language: str = "ko"
    do_subtitles: bool = True
    do_cut: bool = True


def run(input_path: Path, draft_root: Path, opts: EditOptions) -> Path:
    print(f"[1/4] 영상 분석: {input_path.name}")
    media = probe(input_path)
    print(f"      길이 {media.duration:.1f}s · {media.width}x{media.height} · {media.fps:.2f}fps")

    if opts.do_cut and media.has_audio:
        print(f"[2/4] 무음 감지 (noise<{opts.silence_db}dB, ≥{opts.min_silence}s)")
        silences = detect_silences(input_path, opts.silence_db, opts.min_silence)
        keeps = keep_segments(media.duration, silences, opts.padding)
        cut_total = media.duration - sum(k.duration for k in keeps)
        print(f"      {len(silences)}개 무음 구간 · 총 {cut_total:.1f}s 제거")
    else:
        print("[2/4] 무음 컷 건너뜀")
        keeps = [Segment(0.0, media.duration)]

    if opts.do_subtitles and media.has_audio:
        print(f"[3/4] Whisper 전사 (model={opts.whisper_model}, lang={opts.language})")
        raw_subs = transcribe(input_path, opts.whisper_model, opts.language)
        subs = remap_subtitles(raw_subs, [(k.start, k.end) for k in keeps])
        print(f"      자막 {len(subs)}줄 생성")
    else:
        print("[3/4] 자막 생성 건너뜀")
        subs = []

    print(f"[4/4] CapCut 드래프트 작성 → {draft_root}")
    draft = build_draft(opts.project_name, ClipPlan(media, keeps), subs)
    out_dir = write_draft(draft, draft_root, opts.project_name)
    print(f"완료: {out_dir}")
    return out_dir
