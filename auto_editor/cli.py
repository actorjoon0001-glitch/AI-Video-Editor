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
        description="영상 → 무음 컷 + 자막 + 메타데이터 + 썸네일 → YouTube 업로드",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    # ── prep: 무음 컷 + 자막 → CapCut 드래프트 ────────────────────────────────
    prep = sub.add_parser(
        "prep",
        aliases=["edit"],
        help="영상을 분석해 CapCut 드래프트(컷+자막)를 만듭니다",
    )
    prep.add_argument("--input", type=Path, required=True, help="입력 영상 경로")
    prep.add_argument("--project-name", default="auto_edit")
    prep.add_argument("--silence-db", type=float, default=-32.0)
    prep.add_argument("--min-silence", type=float, default=0.6)
    prep.add_argument("--padding", type=float, default=0.1)
    prep.add_argument("--whisper-model", default="small",
                      choices=["tiny", "base", "small", "medium", "large", "large-v2", "large-v3"])
    prep.add_argument("--language", default="ko")
    prep.add_argument("--no-subtitles", action="store_true")
    prep.add_argument("--no-cut", action="store_true")
    prep.add_argument("--draft-dir", type=Path, default=None,
                      help="CapCut 드래프트 폴더 (미지정 시 자동 탐지)")

    # ── metadata: 영상 → 자막 → Claude 호출 → metadata.json ──────────────────
    meta = sub.add_parser("metadata", help="영상에서 제목/설명/태그/썸네일 카피 생성")
    meta.add_argument("--input", type=Path, required=True, help="최종 영상 경로 (CapCut export 결과)")
    meta.add_argument("--out", type=Path, default=Path("metadata.json"))
    meta.add_argument("--whisper-model", default="small")
    meta.add_argument("--language", default="ko")
    meta.add_argument("--persona", default="",
                      help="채널 톤 묘사 (예: 'B2B SaaS 마케팅 채널, 차분하고 실용적')")
    meta.add_argument("--model", default="claude-sonnet-4-6", help="Anthropic 모델 ID")

    # ── thumbnail: metadata.json + 영상 → thumbnail.png ──────────────────────
    thumb = sub.add_parser("thumbnail", help="영상 프레임 + 카피로 썸네일 PNG 생성")
    thumb.add_argument("--input", type=Path, required=True, help="최종 영상 경로")
    thumb.add_argument("--metadata", type=Path, default=Path("metadata.json"))
    thumb.add_argument("--out", type=Path, default=Path("thumbnail.png"))
    thumb.add_argument("--at", type=float, default=None,
                       help="썸네일로 쓸 시점(초). 미지정 시 영상의 1/3 지점")
    thumb.add_argument("--copy", default=None,
                       help="metadata 없이 직접 카피 지정 (이 경우 --metadata 무시)")
    thumb.add_argument("--subcopy", default="")

    # ── publish: 영상 + metadata + thumbnail → YouTube 업로드 ────────────────
    pub = sub.add_parser("publish", help="최종 영상을 YouTube에 업로드")
    pub.add_argument("--input", type=Path, required=True, help="업로드할 영상 (mp4)")
    pub.add_argument("--metadata", type=Path, default=Path("metadata.json"))
    pub.add_argument("--thumbnail", type=Path, default=Path("thumbnail.png"))
    pub.add_argument("--title-index", type=int, default=0,
                     help="metadata.titles 중 사용할 인덱스(0=첫 번째)")
    pub.add_argument("--privacy", default="private",
                     choices=["private", "unlisted", "public"])
    pub.add_argument("--publish-at", default=None,
                     help="예약 공개 ISO 시각(예: 2026-05-05T18:00:00Z). 지정 시 privacy 무시")
    pub.add_argument("--client-secrets", type=Path, default=Path("client_secrets.json"))

    # ── auto: 최종 영상 → 메타+썸네일+업로드 한 번에 ─────────────────────────
    auto = sub.add_parser("auto", help="metadata + thumbnail + publish를 한 번에 실행")
    auto.add_argument("--input", type=Path, required=True, help="최종 영상 (CapCut export 결과)")
    auto.add_argument("--workdir", type=Path, default=Path("./auto_out"))
    auto.add_argument("--whisper-model", default="small")
    auto.add_argument("--language", default="ko")
    auto.add_argument("--persona", default="")
    auto.add_argument("--model", default="claude-sonnet-4-6")
    auto.add_argument("--privacy", default="private",
                      choices=["private", "unlisted", "public"])
    auto.add_argument("--publish-at", default=None)
    auto.add_argument("--client-secrets", type=Path, default=Path("client_secrets.json"))
    auto.add_argument("--no-upload", action="store_true",
                      help="업로드 단계는 건너뛰고 메타+썸네일만 생성")

    return parser


def _cmd_prep(args) -> int:
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


def _cmd_metadata(args) -> int:
    from auto_editor.metadata import generate_metadata, save_metadata
    from auto_editor.transcribe import transcribe

    if not args.input.exists():
        print(f"입력 파일이 없습니다: {args.input}", file=sys.stderr)
        return 1

    print(f"[1/2] Whisper 전사 (model={args.whisper_model}, lang={args.language})")
    subs = transcribe(args.input, args.whisper_model, args.language)
    if not subs:
        print("자막을 한 줄도 만들 수 없습니다 (음성이 없거나 인식 실패).", file=sys.stderr)
        return 1
    print(f"      {len(subs)}줄 인식")

    print(f"[2/2] 메타데이터 생성 (model={args.model})")
    meta = generate_metadata(subs, channel_persona=args.persona, model=args.model)
    save_metadata(meta, args.out)
    print(f"완료: {args.out}")
    print(f"  추천 제목: {meta.best_title}")
    print(f"  태그 {len(meta.tags)}개 · 썸네일 카피: {meta.thumbnail_copy}")
    return 0


def _cmd_thumbnail(args) -> int:
    from auto_editor.metadata import load_metadata
    from auto_editor.thumbnail import ensure_pillow_available, render_thumbnail

    if not args.input.exists():
        print(f"입력 영상이 없습니다: {args.input}", file=sys.stderr)
        return 1
    ensure_pillow_available()

    if args.copy:
        copy, sub = args.copy, args.subcopy
    else:
        if not args.metadata.exists():
            print(f"metadata 파일이 없습니다: {args.metadata}", file=sys.stderr)
            return 1
        meta = load_metadata(args.metadata)
        copy = meta.thumbnail_copy or meta.best_title
        sub = meta.thumbnail_subcopy

    out = render_thumbnail(args.input, args.out, copy, sub, at_seconds=args.at)
    print(f"완료: {out}")
    return 0


def _cmd_publish(args) -> int:
    from auto_editor.metadata import load_metadata
    from auto_editor.youtube_upload import upload_video

    if not args.input.exists():
        print(f"입력 영상이 없습니다: {args.input}", file=sys.stderr)
        return 1
    if not args.metadata.exists():
        print(f"metadata 파일이 없습니다: {args.metadata}", file=sys.stderr)
        return 1

    meta = load_metadata(args.metadata)
    if args.title_index >= len(meta.titles):
        print(f"title_index {args.title_index}는 후보 {len(meta.titles)}개를 벗어납니다.", file=sys.stderr)
        return 1
    title = meta.titles[args.title_index]
    thumb = args.thumbnail if args.thumbnail.exists() else None

    print(f"YouTube 업로드: {title}")
    result = upload_video(
        video_path=args.input,
        title=title,
        description=meta.description,
        tags=meta.tags,
        thumbnail_path=thumb,
        privacy=args.privacy,
        publish_at_iso=args.publish_at,
        client_secrets=args.client_secrets,
    )
    print(f"완료: {result.url} · 상태: {result.status}")
    return 0


def _cmd_auto(args) -> int:
    from auto_editor.metadata import generate_metadata, save_metadata
    from auto_editor.thumbnail import ensure_pillow_available, render_thumbnail
    from auto_editor.transcribe import transcribe
    from auto_editor.youtube_upload import upload_video

    if not args.input.exists():
        print(f"입력 영상이 없습니다: {args.input}", file=sys.stderr)
        return 1
    args.workdir.mkdir(parents=True, exist_ok=True)
    meta_path = args.workdir / "metadata.json"
    thumb_path = args.workdir / "thumbnail.png"

    print(f"[1/4] Whisper 전사")
    subs = transcribe(args.input, args.whisper_model, args.language)
    if not subs:
        print("자막을 만들 수 없습니다.", file=sys.stderr)
        return 1

    print(f"[2/4] 메타데이터 생성")
    meta = generate_metadata(subs, channel_persona=args.persona, model=args.model)
    save_metadata(meta, meta_path)
    print(f"      제목 후보: {meta.titles}")

    print(f"[3/4] 썸네일 렌더링")
    ensure_pillow_available()
    render_thumbnail(args.input, thumb_path,
                     meta.thumbnail_copy or meta.best_title,
                     meta.thumbnail_subcopy)

    if args.no_upload:
        print(f"[4/4] 업로드 건너뜀 (--no-upload)")
        print(f"산출물: {meta_path} · {thumb_path}")
        return 0

    print(f"[4/4] YouTube 업로드")
    result = upload_video(
        video_path=args.input,
        title=meta.best_title,
        description=meta.description,
        tags=meta.tags,
        thumbnail_path=thumb_path,
        privacy=args.privacy,
        publish_at_iso=args.publish_at,
        client_secrets=args.client_secrets,
    )
    print(f"완료: {result.url}")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    cmd = args.cmd
    if cmd in {"prep", "edit"}:
        return _cmd_prep(args)
    if cmd == "metadata":
        return _cmd_metadata(args)
    if cmd == "thumbnail":
        return _cmd_thumbnail(args)
    if cmd == "publish":
        return _cmd_publish(args)
    if cmd == "auto":
        return _cmd_auto(args)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
