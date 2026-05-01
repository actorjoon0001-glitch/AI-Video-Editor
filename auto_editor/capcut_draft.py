"""Generate a CapCut/JianYing draft (`draft_content.json`).

The schema is reverse-engineered from CapCut desktop drafts. Fields are kept
to a minimal subset that the editor accepts; CapCut fills in unspecified
defaults when the project is opened.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from auto_editor.probe import MediaInfo
from auto_editor.silence import Segment
from auto_editor.transcribe import Subtitle


def _uuid() -> str:
    return str(uuid.uuid4()).upper()


def _us(seconds: float) -> int:
    return int(round(seconds * 1_000_000))


@dataclass
class ClipPlan:
    media: MediaInfo
    keeps: list[Segment]


def build_draft(
    project_name: str,
    plan: ClipPlan,
    subtitles: list[Subtitle],
    canvas_width: int = 1920,
    canvas_height: int = 1080,
) -> dict:
    media = plan.media
    fps = media.fps if media.fps > 0 else 30.0

    # ── Materials ────────────────────────────────────────────────────────────
    video_material_id = _uuid()
    audio_material_id = _uuid()

    video_material = {
        "id": video_material_id,
        "type": "video",
        "path": str(media.path.resolve()),
        "material_name": media.path.name,
        "width": media.width,
        "height": media.height,
        "duration": _us(media.duration),
        "has_audio": media.has_audio,
        "create_time": int(time.time()),
    }

    materials: dict = {
        "videos": [video_material],
        "audios": [],
        "texts": [],
        "stickers": [],
        "effects": [],
        "transitions": [],
        "speeds": [],
        "canvases": [],
        "sound_channel_mappings": [],
        "vocal_separations": [],
    }

    if media.has_audio:
        materials["audios"].append({
            "id": audio_material_id,
            "type": "extract_music",
            "path": str(media.path.resolve()),
            "name": media.path.name,
            "duration": _us(media.duration),
        })

    # ── Video segments (cut timeline) ────────────────────────────────────────
    video_segments = []
    audio_segments = []
    cursor_us = 0
    for keep in plan.keeps:
        src_start = _us(keep.start)
        seg_dur = _us(keep.duration)
        common = {
            "source_timerange": {"start": src_start, "duration": seg_dur},
            "target_timerange": {"start": cursor_us, "duration": seg_dur},
            "speed": 1.0,
            "volume": 1.0,
            "visible": True,
        }
        video_segments.append({
            "id": _uuid(),
            "material_id": video_material_id,
            **common,
            "extra_material_refs": [],
        })
        if media.has_audio:
            audio_segments.append({
                "id": _uuid(),
                "material_id": audio_material_id,
                **common,
                "extra_material_refs": [],
            })
        cursor_us += seg_dur

    total_duration_us = cursor_us if cursor_us > 0 else _us(media.duration)

    # ── Subtitles → text materials + text track ──────────────────────────────
    text_segments = []
    for sub in subtitles:
        text_id = _uuid()
        materials["texts"].append({
            "id": text_id,
            "type": "text",
            "content": json.dumps({
                "text": sub.text,
                "styles": [{
                    "fill": {"content": {"solid": {"color": [1, 1, 1]}}},
                    "font": {"size": 8.0},
                    "strokes": [{"content": {"solid": {"color": [0, 0, 0]}}, "width": 0.08}],
                }],
            }, ensure_ascii=False),
            "text_color": "#FFFFFF",
            "font_size": 8.0,
            "alignment": 1,
        })
        seg_dur = _us(sub.end - sub.start)
        text_segments.append({
            "id": _uuid(),
            "material_id": text_id,
            "source_timerange": {"start": 0, "duration": seg_dur},
            "target_timerange": {"start": _us(sub.start), "duration": seg_dur},
            "clip": {
                "alpha": 1.0,
                "transform": {"x": 0.0, "y": -0.75},
                "scale": {"x": 1.0, "y": 1.0},
            },
            "visible": True,
            "extra_material_refs": [],
        })

    # ── Tracks ───────────────────────────────────────────────────────────────
    tracks = [
        {
            "id": _uuid(),
            "type": "video",
            "attribute": 0,
            "flag": 0,
            "segments": video_segments,
        }
    ]
    if audio_segments:
        tracks.append({
            "id": _uuid(),
            "type": "audio",
            "attribute": 0,
            "flag": 0,
            "segments": audio_segments,
        })
    if text_segments:
        tracks.append({
            "id": _uuid(),
            "type": "text",
            "attribute": 0,
            "flag": 0,
            "segments": text_segments,
        })

    return {
        "id": _uuid(),
        "name": project_name,
        "duration": total_duration_us,
        "fps": fps,
        "canvas_config": {
            "width": canvas_width,
            "height": canvas_height,
            "ratio": "16:9",
        },
        "materials": materials,
        "tracks": tracks,
        "create_time": int(time.time()),
        "update_time": int(time.time()),
        "version": 360000,
        "new_version": "100.0.0",
        "platform": {"app_id": 3704, "app_source": "lv", "os": "mac"},
        "extra_info": None,
    }


def write_draft(draft: dict, draft_root: Path, project_name: str) -> Path:
    """Write `draft_content.json` plus a minimal meta file under draft_root/<project>."""
    project_dir = draft_root / project_name
    project_dir.mkdir(parents=True, exist_ok=True)

    content_path = project_dir / "draft_content.json"
    content_path.write_text(json.dumps(draft, ensure_ascii=False, indent=2), encoding="utf-8")

    meta = {
        "draft_id": draft["id"],
        "draft_name": project_name,
        "draft_fold_path": str(project_dir.resolve()),
        "tm_draft_create": int(time.time() * 1000),
        "tm_draft_modified": int(time.time() * 1000),
        "draft_timeline_materials_size": 0,
        "draft_root_path": str(draft_root.resolve()),
        "duration": draft["duration"],
    }
    (project_dir / "draft_meta_info.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return project_dir
