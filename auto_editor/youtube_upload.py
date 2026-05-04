"""Upload a finished video to YouTube via the Data API v3.

Auth: OAuth 2.0 installed-app flow. First run opens a browser to consent;
the resulting token is cached at `--token-path` (default `~/.auto_editor/youtube_token.json`).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
DEFAULT_TOKEN_PATH = Path.home() / ".auto_editor" / "youtube_token.json"


@dataclass
class UploadResult:
    video_id: str
    url: str
    status: str


def _load_credentials(client_secrets_path: Path, token_path: Path):
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow

    creds = None
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)

    if creds and creds.valid:
        return creds
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
    else:
        if not client_secrets_path.exists():
            raise FileNotFoundError(
                f"YouTube OAuth client_secrets 파일이 없습니다: {client_secrets_path}\n"
                "Google Cloud Console → APIs & Services → Credentials 에서 "
                "OAuth 2.0 Client ID (Desktop)를 만들고 JSON을 받아 이 경로에 두세요."
            )
        flow = InstalledAppFlow.from_client_secrets_file(str(client_secrets_path), SCOPES)
        creds = flow.run_local_server(port=0)

    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(creds.to_json(), encoding="utf-8")
    return creds


def upload_video(
    video_path: Path,
    title: str,
    description: str,
    tags: list[str],
    *,
    thumbnail_path: Path | None = None,
    privacy: str = "private",
    category_id: str = "22",  # People & Blogs (default safe)
    made_for_kids: bool = False,
    publish_at_iso: str | None = None,
    client_secrets: Path = Path("client_secrets.json"),
    token_path: Path = DEFAULT_TOKEN_PATH,
) -> UploadResult:
    """Upload `video_path` to YouTube, optionally setting a custom thumbnail."""
    if privacy not in {"private", "unlisted", "public"}:
        raise ValueError("privacy는 private/unlisted/public 중 하나여야 합니다.")
    if not video_path.exists():
        raise FileNotFoundError(video_path)

    from googleapiclient.discovery import build
    from googleapiclient.http import MediaFileUpload

    creds = _load_credentials(client_secrets, token_path)
    youtube = build("youtube", "v3", credentials=creds)

    body: dict = {
        "snippet": {
            "title": title[:100],  # YouTube hard limit
            "description": description[:5000],
            "tags": tags[:30],
            "categoryId": category_id,
        },
        "status": {
            "privacyStatus": "private" if publish_at_iso else privacy,
            "selfDeclaredMadeForKids": made_for_kids,
        },
    }
    if publish_at_iso:
        body["status"]["publishAt"] = publish_at_iso  # forces privacy=private until then

    media = MediaFileUpload(
        str(video_path),
        chunksize=8 * 1024 * 1024,
        resumable=True,
        mimetype="video/*",
    )
    request = youtube.videos().insert(
        part="snippet,status",
        body=body,
        media_body=media,
    )

    response = None
    while response is None:
        status, response = request.next_chunk()
        if status:
            print(f"  업로드 진행률: {int(status.progress() * 100)}%")

    video_id = response["id"]

    if thumbnail_path and thumbnail_path.exists():
        try:
            youtube.thumbnails().set(
                videoId=video_id,
                media_body=MediaFileUpload(str(thumbnail_path), mimetype="image/png"),
            ).execute()
            print("  썸네일 적용 완료")
        except Exception as e:
            # 썸네일 실패는 영상 업로드 자체를 망치지 않도록 경고만.
            print(f"  ⚠ 썸네일 적용 실패 (영상은 업로드됨): {e}")

    return UploadResult(
        video_id=video_id,
        url=f"https://youtu.be/{video_id}",
        status=response.get("status", {}).get("privacyStatus", "unknown"),
    )
