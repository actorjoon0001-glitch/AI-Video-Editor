"""추출된 썸네일 사진 위에 텍스트 카드를 합성한다.

사진 추출과 업로드는 건드리지 않는다. 업로드 직전에 한 장을 더 만들어 낼 뿐이고,
원본은 그대로 남아 있어서 문구만 바꿔 다시 만들 수 있다.

stdin 으로 JSON 을 받고 stdout 으로 JSON 을 돌려준다.
  입력: {"image", "out", "line1", "line2", "line3", "fonts": [...]}
  출력: {"ok": true, "path", "font", "sizes": [...]}  또는  {"ok": false, "error"}

실패는 조용히 넘기지 않고 이유를 돌려준다 — 호출하는 쪽이 원본 사진으로
업로드를 이어가되, 왜 카드가 안 붙었는지는 남길 수 있어야 한다.
"""

import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

CANVAS_W, CANVAS_H = 1280, 720

PANEL_W = 560
PANEL_COLOR = (0x0D, 0x11, 0x17)
PANEL_ALPHA = int(255 * 0.82)
FADE_TO = 680                      # 560~680 구간에서 82% → 0%

ACCENT = (0xE4, 0xA8, 0x53)
ACCENT_BAR = (64, 624, 88, 6)      # x, y, w, h

TEXT_X = 64
TEXT_RIGHT = FADE_TO               # 글자가 흐려지는 구간을 넘어가면 읽히지 않는다
STROKE_W = 6

# (y, 크기, 색) — 3줄일 때의 기준 위치
LINE_SPECS = [
    (180, 96, ACCENT),
    (300, 84, (0xFF, 0xFF, 0xFF)),
    (404, 84, (0xFF, 0xFF, 0xFF)),
]

MAX_CHARS = 7
SHRINK_STEP = 8
SHRINK_TRIES = 3
MAX_BYTES = 2 * 1024 * 1024


class CardError(Exception):
    pass


def resolve_font(families):
    """패밀리 이름을 실제 폰트 파일 경로로 바꾼다.

    fontconfig 은 못 찾아도 가장 비슷한 걸 돌려주므로, 이름이 실제로 일치하는지
    확인해야 한다. 확인 없이 쓰면 Black 을 요청하고 보통 굵기를 받는다.
    """
    for fam in families:
        try:
            out = subprocess.run(
                ["fc-match", "-f", "%{family}|%{file}", fam],
                capture_output=True, text=True, timeout=10,
            ).stdout
        except Exception:
            continue
        if "|" not in out:
            continue
        got, path = out.split("|", 1)
        names = [n.strip().lower() for n in got.split(",")]
        if fam.strip().lower() in names and os.path.exists(path):
            return fam, path
    raise CardError("쓸 수 있는 폰트를 찾지 못했습니다: " + ", ".join(families))


def cover_crop(img):
    """비율이 달라도 가운데를 기준으로 꽉 채워 자른다 (CSS object-fit: cover)."""
    img = img.convert("RGB")
    src_w, src_h = img.size
    scale = max(CANVAS_W / src_w, CANVAS_H / src_h)
    new = (max(1, round(src_w * scale)), max(1, round(src_h * scale)))
    img = img.resize(new, Image.LANCZOS)
    left = (new[0] - CANVAS_W) // 2
    top = (new[1] - CANVAS_H) // 2
    return img.crop((left, top, left + CANVAS_W, top + CANVAS_H))


def panel_layer():
    """왼쪽 패널 + 오른쪽으로 사라지는 그라데이션."""
    layer = Image.new("RGBA", (CANVAS_W, CANVAS_H), PANEL_COLOR + (0,))
    alpha = Image.new("L", (CANVAS_W, 1), 0)
    px = alpha.load()
    for x in range(CANVAS_W):
        if x < PANEL_W:
            px[x, 0] = PANEL_ALPHA
        elif x < FADE_TO:
            t = (x - PANEL_W) / (FADE_TO - PANEL_W)
            px[x, 0] = int(PANEL_ALPHA * (1 - t))
        else:
            px[x, 0] = 0
    layer.putalpha(alpha.resize((CANVAS_W, CANVAS_H)))
    return layer


def fit_line(text, size, font_path):
    """폭에 맞을 때까지 크기를 줄인다. 글자 수는 줄인다고 달라지지 않으므로
    글자 수 초과는 여기서 다루지 않고 호출 전에 막는다."""
    for attempt in range(SHRINK_TRIES + 1):
        s = size - SHRINK_STEP * attempt
        if s <= 0:
            break
        font = ImageFont.truetype(font_path, s)
        w = font.getbbox(text, stroke_width=STROKE_W)[2]
        if TEXT_X + w <= TEXT_RIGHT:
            return font, s
    raise CardError(
        f'"{text}" 가 {SHRINK_TRIES}번 줄여도 패널 폭({TEXT_RIGHT - TEXT_X}px)을 넘습니다.'
    )


def render(req):
    line1 = (req.get("line1") or "").strip()
    if not line1:
        raise CardError("line1 이 비어 있습니다.")
    lines = [line1, (req.get("line2") or "").strip(), (req.get("line3") or "").strip()]
    lines = [l for l in lines if l]

    for l in lines:
        if len(l) > MAX_CHARS:
            raise CardError(f'"{l}" 는 {len(l)}자입니다 — 한 줄 최대 {MAX_CHARS}자.')

    family, font_path = resolve_font(req.get("fonts") or [])

    fitted = []
    for i, text in enumerate(lines):
        _, size, color = LINE_SPECS[i]
        font, used = fit_line(text, size, font_path)
        fitted.append((text, font, color, used, LINE_SPECS[i][0]))

    # 3줄 기준으로 잡힌 좌표를, 줄이 적으면 세로 가운데로 다시 배치한다.
    tops = [f[4] for f in fitted]
    if len(fitted) < 3:
        heights = [f[1].getbbox(f[0], stroke_width=STROKE_W)[3] for f in fitted]
        block = (tops[-1] - tops[0]) + heights[-1]
        offset = (CANVAS_H - block) // 2 - tops[0]
        tops = [t + offset for t in tops]

    base = cover_crop(Image.open(req["image"]))
    base = Image.alpha_composite(base.convert("RGBA"), panel_layer())

    draw = ImageDraw.Draw(base)
    x, y, w, h = ACCENT_BAR
    draw.rectangle([x, y, x + w, y + h], fill=ACCENT)
    for (text, font, color, _size, _y), top in zip(fitted, tops):
        draw.text((TEXT_X, top), text, font=font, fill=color,
                  stroke_width=STROKE_W, stroke_fill=PANEL_COLOR)

    out = req["out"]
    rgb = base.convert("RGB")
    for quality in (90, 82, 74, 66):
        rgb.save(out, "JPEG", quality=quality, optimize=True, progressive=True)
        if os.path.getsize(out) <= MAX_BYTES:
            break
    return {
        "ok": True,
        "path": out,
        "font": family,
        "sizes": [f[3] for f in fitted],
        "bytes": os.path.getsize(out),
    }


def main():
    try:
        req = json.loads(sys.stdin.read())
        print(json.dumps(render(req), ensure_ascii=False))
    except CardError as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
    except Exception as e:  # 예상 못 한 실패도 호출자가 폴백할 수 있게 형식을 지킨다
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
