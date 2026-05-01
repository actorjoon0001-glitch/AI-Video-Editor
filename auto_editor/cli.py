"""Command-line interface."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from auto_editor.draft_dir import find_draft_dir
from auto_editor.pipeline import EditOptions, run


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="auto_editor",
        description="영상 → 무음 컷 + 자막 → CapCut 드래프트 자동 생성",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    edit = sub.add_parser("edit", help="영상을 편집해 CapCut 드래프트를 만듭니다")
    edit.add_argument("--input", type=Path, required=True, help="입력 영상 경로")
    edit.add_argument("--project-name", default="auto_edit")
    edit.add_argument("--silence-db", type=float, default=-32.0)
    edit.add_argument("--min-silence", type=float, default=0.6)
    edit.add_argument("--padding", type=float, default=0.1)
    edit.add_argument("--whisper-model", default="small",
                      choices=["tiny", "base", "small", "medium", "large", "large-v2", "large-v3"])
    edit.add_argument("--language", default="ko")
    edit.add_argument("--no-subtitles", action="store_true")
    edit.add_argument("--no-cut", action="store_true")
    edit.add_argument("--draft-dir", type=Path, default=None,
                      help="CapCut 드래프트 폴더 (미지정 시 자동 탐지)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.cmd != "edit":
        return 2

    if not args.input.exists():
        print(f"입력 파일이 없습니다: {args.input}", file=sys.stderr)
        return 1

    draft_root = args.draft_dir or find_draft_dir()
    if draft_root is None:
        print(
            "CapCut 드래프트 폴더를 찾지 못했습니다. --draft-dir 로 직접 지정해 주세요.",
            file=sys.stderr,
        )
        return 1

    opts = EditOptions(
        project_name=args.project_name,
        silence_db=args.silence_db,
        min_silence=args.min_silence,
        padding=args.padding,
        whisper_model=args.whisper_model,
        language=args.language,
        do_subtitles=not args.no_subtitles,
        do_cut=not args.no_cut,
    )
    run(args.input, draft_root, opts)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
