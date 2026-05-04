"""Generate YouTube title / description / tags / thumbnail copy from transcript.

Uses the Anthropic Messages API with prompt caching on the system prompt so
repeated calls in a batch (same channel persona) hit cache.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from auto_editor.transcribe import Subtitle


SYSTEM_PROMPT = """\
당신은 한국 유튜브 채널의 메타데이터 카피라이터입니다. 영상 자막 전체를 읽고
다음을 JSON 한 덩어리로 출력합니다.

- titles: 제목 후보 5개. 각 30자 이하, 클릭 유도하되 낚시는 금지.
- description: 영상 설명문. 첫 2줄에 핵심을 담고, 챕터(시간:내용) 5개를 자동 추출.
- tags: 검색 노출용 태그 12개 이하. 한글 위주, 영어 키워드 1~2개.
- thumbnail_copy: 썸네일에 큰 글자로 박을 6~10자 후크 카피 1개.
- thumbnail_subcopy: 보조 카피 4~8자 (선택, 없으면 빈 문자열).

규칙:
- 영상에 실제 등장한 단어와 주제만 사용. 환각 금지.
- 모든 출력은 한국어. tags 안 영어 키워드는 예외.
- 최종 출력은 위 키만 가진 순수 JSON. 마크다운 코드펜스 금지.
"""


@dataclass
class VideoMetadata:
    titles: list[str] = field(default_factory=list)
    description: str = ""
    tags: list[str] = field(default_factory=list)
    thumbnail_copy: str = ""
    thumbnail_subcopy: str = ""

    @property
    def best_title(self) -> str:
        return self.titles[0] if self.titles else "제목 미정"

    def to_dict(self) -> dict:
        return {
            "titles": self.titles,
            "description": self.description,
            "tags": self.tags,
            "thumbnail_copy": self.thumbnail_copy,
            "thumbnail_subcopy": self.thumbnail_subcopy,
        }


def _subs_to_transcript(subs: list[Subtitle]) -> str:
    return "\n".join(f"[{s.start:6.1f}s] {s.text}" for s in subs)


def generate_metadata(
    subtitles: list[Subtitle],
    channel_persona: str = "",
    model: str = "claude-sonnet-4-6",
) -> VideoMetadata:
    """Call Claude to produce title/description/tags/thumbnail copy from transcript."""
    if not subtitles:
        raise ValueError("자막이 비었습니다. 메타데이터를 만들 수 없습니다.")

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY 환경 변수가 필요합니다. "
            "https://console.anthropic.com 에서 키를 발급받아 설정하세요."
        )

    from anthropic import Anthropic

    client = Anthropic(api_key=api_key)

    system_blocks = [
        {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}},
    ]
    if channel_persona:
        system_blocks.append({
            "type": "text",
            "text": f"채널 페르소나/톤: {channel_persona}",
            "cache_control": {"type": "ephemeral"},
        })

    user = (
        "다음은 영상 자막 전체입니다. 위 규칙대로 JSON 한 덩어리만 출력하세요.\n\n"
        f"<transcript>\n{_subs_to_transcript(subtitles)}\n</transcript>"
    )

    resp = client.messages.create(
        model=model,
        max_tokens=2048,
        system=system_blocks,
        messages=[{"role": "user", "content": user}],
    )
    text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()

    # Strip stray code fences if the model adds them despite instructions.
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0]

    data = json.loads(text)
    return VideoMetadata(
        titles=list(data.get("titles", []))[:5],
        description=str(data.get("description", "")),
        tags=list(data.get("tags", []))[:12],
        thumbnail_copy=str(data.get("thumbnail_copy", "")),
        thumbnail_subcopy=str(data.get("thumbnail_subcopy", "")),
    )


def save_metadata(meta: VideoMetadata, path: Path) -> None:
    path.write_text(json.dumps(meta.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")


def load_metadata(path: Path) -> VideoMetadata:
    data = json.loads(path.read_text(encoding="utf-8"))
    return VideoMetadata(**data)
