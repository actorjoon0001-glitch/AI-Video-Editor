"""Locate the user's CapCut draft directory across platforms."""

from __future__ import annotations

import os
import sys
from pathlib import Path

_CANDIDATES_BY_PLATFORM = {
    "darwin": [
        "~/Movies/CapCut/User Data/Projects/com.lveditor.draft",
        "~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft",
    ],
    "win32": [
        r"%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft",
        r"%LOCALAPPDATA%\JianyingPro\User Data\Projects\com.lveditor.draft",
    ],
    "linux": [
        "~/CapCut/User Data/Projects/com.lveditor.draft",
    ],
}


def find_draft_dir() -> Path | None:
    candidates = _CANDIDATES_BY_PLATFORM.get(sys.platform, [])
    for raw in candidates:
        expanded = Path(os.path.expandvars(os.path.expanduser(raw)))
        if expanded.is_dir():
            return expanded
    return None
