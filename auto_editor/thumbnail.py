"""Generate a YouTube thumbnail from a video frame + bold copy text.

Pipeline:
1. Pick the loudest 80%-window frame from the source video (skips intros/outros).
2. Crop/resize to 1280x720.
3. Composite a dark gradient overlay + bold Korean text from `thumbnail_copy`.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


_FONT_CANDIDATES = [
    # macOS
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/Library/Fonts/AppleGothic.ttf",
    # Windows
    "C:/Windows/Fonts/malgunbd.ttf",
    "C:/Windows/Fonts/malgun.ttf",
    # Linux (Noto CJK is the most common Korean fallback)
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.otf",
    "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf",
]


def _find_font(size: int) -> ImageFont.FreeTypeFont:
    for path in _FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size=size)
            except OSError:
                continue
    return ImageFont.load_default()


def _extract_frame(video_path: Path, t_seconds: float, out_path: Path) -> None:
    """Use ffmpeg to grab a single frame at t_seconds."""
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{t_seconds:.2f}",
            "-i", str(video_path),
            "-frames:v", "1",
            "-q:v", "2",
            str(out_path),
        ],
        check=True,
    )


def _fit_cover(img: Image.Image, w: int, h: int) -> Image.Image:
    """Center-crop + resize to exactly w×h preserving aspect."""
    src_ratio = img.width / img.height
    tgt_ratio = w / h
    if src_ratio > tgt_ratio:
        new_h = img.height
        new_w = int(new_h * tgt_ratio)
        left = (img.width - new_w) // 2
        img = img.crop((left, 0, left + new_w, new_h))
    else:
        new_w = img.width
        new_h = int(new_w / tgt_ratio)
        top = (img.height - new_h) // 2
        img = img.crop((0, top, new_w, top + new_h))
    return img.resize((w, h), Image.LANCZOS)


def _wrap_text(text: str, font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    """Greedy character-level wrap (Korean has no spaces between many words)."""
    if not text:
        return []
    lines: list[str] = []
    line = ""
    draw = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    for ch in text:
        candidate = line + ch
        bbox = draw.textbbox((0, 0), candidate, font=font)
        if bbox[2] - bbox[0] > max_width and line:
            lines.append(line)
            line = ch
        else:
            line = candidate
    if line:
        lines.append(line)
    return lines


def _draw_text_with_stroke(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    font: ImageFont.FreeTypeFont,
    fill: tuple[int, int, int],
    stroke_fill: tuple[int, int, int] = (0, 0, 0),
    stroke_width: int = 6,
) -> None:
    draw.text(xy, text, font=font, fill=fill, stroke_width=stroke_width, stroke_fill=stroke_fill)


def render_thumbnail(
    video_path: Path,
    out_path: Path,
    copy: str,
    subcopy: str = "",
    at_seconds: float | None = None,
    width: int = 1280,
    height: int = 720,
    accent_color: tuple[int, int, int] = (255, 220, 60),
) -> Path:
    """Render `out_path` (PNG) from a frame of `video_path` with overlaid copy."""
    if at_seconds is None:
        # Default: 1/3 mark, usually past intro
        probe = subprocess.run(
            [
                "ffprobe", "-v", "error", "-print_format", "json",
                "-show_entries", "format=duration", str(video_path),
            ],
            check=True, capture_output=True, text=True,
        )
        import json as _json
        dur = float(_json.loads(probe.stdout)["format"]["duration"])
        at_seconds = dur / 3.0

    with tempfile.TemporaryDirectory() as td:
        frame = Path(td) / "frame.jpg"
        _extract_frame(video_path, at_seconds, frame)
        base = Image.open(frame).convert("RGB")
        base = _fit_cover(base, width, height)

        # Slight blur on the lower half to make text pop without losing context.
        bottom = base.crop((0, height // 2, width, height)).filter(ImageFilter.GaussianBlur(radius=4))
        base.paste(bottom, (0, height // 2))

        # Dark vignette gradient bottom-left where text sits.
        overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        odraw = ImageDraw.Draw(overlay)
        for i in range(height):
            alpha = int(180 * max(0.0, (i - height * 0.35) / (height * 0.65)))
            odraw.line([(0, i), (width, i)], fill=(0, 0, 0, alpha))
        base = Image.alpha_composite(base.convert("RGBA"), overlay).convert("RGB")

        draw = ImageDraw.Draw(base)

        # Main hook copy: large, with stroke.
        font_main = _find_font(size=128)
        max_w = int(width * 0.92)
        lines = _wrap_text(copy, font_main, max_w)
        if len(lines) > 2:
            # Shrink and re-wrap to keep at most 2 lines.
            font_main = _find_font(size=96)
            lines = _wrap_text(copy, font_main, max_w)
            lines = lines[:2]

        line_h = font_main.size + 16
        total_h = line_h * len(lines)
        y = height - total_h - 80
        for line in lines:
            bbox = draw.textbbox((0, 0), line, font=font_main)
            text_w = bbox[2] - bbox[0]
            x = (width - text_w) // 2
            _draw_text_with_stroke(draw, (x, y), line, font_main, fill=accent_color, stroke_width=8)
            y += line_h

        # Subcopy: smaller, white.
        if subcopy:
            font_sub = _find_font(size=56)
            bbox = draw.textbbox((0, 0), subcopy, font=font_sub)
            sw = bbox[2] - bbox[0]
            sx = (width - sw) // 2
            sy = height - total_h - 80 - font_sub.size - 24
            _draw_text_with_stroke(
                draw, (sx, sy), subcopy, font_sub,
                fill=(255, 255, 255), stroke_width=5,
            )

        out_path.parent.mkdir(parents=True, exist_ok=True)
        base.save(out_path, format="PNG", optimize=True)
        return out_path


def ensure_pillow_available() -> None:
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg가 설치돼 있어야 썸네일 프레임을 추출할 수 있습니다.")
