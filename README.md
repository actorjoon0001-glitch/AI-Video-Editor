# AI Video Editor — YouTube 자동 발행 파이프라인

영상 한 개를 던지면 **컷 편집 → 자막 → 제목/설명/태그 → 썸네일 → YouTube 업로드** 까지
끝내는 도구 모음입니다.

## 두 가지 사용 모드

### A. 브라우저 에디터 (`public/`)
드래그 앤 드롭으로 무음 컷 + 비율 변환 + 썸네일 추출. 브라우저 안에서만 동작 (업로드 없음).
ffmpeg.wasm 기반. 결과물을 mp4 로 받아서 다음 단계로.

### B. CLI 파이프라인 (`auto_editor/`)
헤드리스 자동화용. Whisper 자막 → Claude 메타데이터 → 썸네일 합성 → YouTube 업로드.
n8n 으로 묶어 무인 발행 가능 (`n8n/youtube-pipeline.json`).

```
원본 영상  ─►  prep        (무음 컷 + 자막 → CapCut 드래프트)
            ─►  CapCut에서 마무리 export → 최종 mp4
            ─►  metadata    (Claude → 제목/설명/태그/썸네일 카피)
            ─►  thumbnail   (영상 프레임 + 카피 → PNG 1280x720)
            ─►  publish     (YouTube Data API v3 업로드)
```

## 설치

```bash
python -m venv .venv
source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

ffmpeg / ffprobe 는 시스템에 설치돼 있어야 합니다.
- macOS: `brew install ffmpeg`
- Windows: <https://ffmpeg.org/download.html>

### 필요한 키

| 무엇 | 어디 | 환경 변수 / 파일 |
|---|---|---|
| Claude API | <https://console.anthropic.com> | `ANTHROPIC_API_KEY` |
| YouTube 업로드 | Google Cloud Console → OAuth 2.0 Client ID (Desktop) | `client_secrets.json` |

## 명령 한눈에 보기

```bash
# 1단계: 원본 영상 → CapCut 드래프트 (무음 컷 + 자막)
python -m auto_editor prep --input ./raw.mp4 --project-name "ep-12"

# (CapCut에서 미세 조정 후 export → ./final.mp4)

# 2단계: 메타데이터 생성
export ANTHROPIC_API_KEY=sk-ant-...
python -m auto_editor metadata \
    --input ./final.mp4 \
    --persona "B2B SaaS 마케팅, 차분하고 실용적" \
    --out ./metadata.json

# 3단계: 썸네일 생성
python -m auto_editor thumbnail \
    --input ./final.mp4 \
    --metadata ./metadata.json \
    --out ./thumbnail.png

# 4단계: YouTube 업로드 (첫 실행 시 브라우저로 OAuth 인증)
python -m auto_editor publish \
    --input ./final.mp4 \
    --metadata ./metadata.json \
    --thumbnail ./thumbnail.png \
    --privacy private
```

또는 2~4단계를 한 번에:

```bash
python -m auto_editor auto \
    --input ./final.mp4 \
    --workdir ./out \
    --persona "B2B SaaS 마케팅, 차분하고 실용적" \
    --privacy unlisted
```

## n8n 연동

`n8n/youtube-pipeline.json` 을 n8n 에 import 하면 webhook 으로 자동 발행 흐름이 만들어집니다.
세부 사항은 [n8n/README.md](./n8n/README.md).

## 폴더 구조

```
auto_editor/         # 헤드리스 CLI 파이프라인
  pipeline.py        # prep: 컷 + 자막 → CapCut 드래프트
  silence.py         # ffmpeg silencedetect
  transcribe.py      # faster-whisper 전사
  capcut_draft.py    # draft_content.json 생성
  metadata.py        # Claude로 제목/설명/태그 생성
  thumbnail.py       # 영상 프레임 + 카피 합성
  youtube_upload.py  # YouTube Data API v3 업로드
  cli.py             # argparse subcommands
public/              # 브라우저 에디터 (ffmpeg.wasm)
n8n/                 # 자동화 워크플로 JSON
```

## CapCut 드래프트 폴더 자동 탐지

자동 탐지가 실패하면 `--draft-dir` 로 직접 지정하세요.

- **Windows**: `%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft`
- **macOS**: `~/Movies/CapCut/User Data/Projects/com.lveditor.draft`

## 보안 주의

- `client_secrets.json`, `~/.auto_editor/youtube_token.json`, `metadata.json` 의 채널 페르소나
  등은 절대 커밋하지 마세요. `.gitignore` 에 등록되어 있습니다.
- `ANTHROPIC_API_KEY` 는 환경 변수로만 전달.
