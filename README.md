# AI Video Editor (CapCut 연동)

YouTube 업로드용 영상 자동 편집기. 영상 소스를 입력하면 무음 구간을 자동으로 잘라내고, 자막을 생성한 뒤 **CapCut 드래프트 파일**로 저장합니다. CapCut에서 그 드래프트를 열어 최종 조정만 하면 됩니다.

## 동작 원리

```
입력 영상  ─► 무음 분석 (ffmpeg silencedetect)
            ─► 음성 인식 (faster-whisper)
            ─► CapCut 드래프트 생성 (draft_content.json)
            ─► CapCut에서 열기 → 컷/자막 자동 적용된 상태
```

CapCut의 드래프트 폴더에 직접 써 넣으므로, CapCut 앱을 켜면 새 프로젝트로 바로 보입니다.

## 설치

```bash
python -m venv .venv
source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

ffmpeg가 시스템에 설치되어 있어야 합니다.
- macOS: `brew install ffmpeg`
- Windows: <https://ffmpeg.org/download.html>

## 사용법

```bash
python -m auto_editor edit \
    --input ./my_clip.mp4 \
    --project-name "내 유튜브 영상" \
    --silence-db -32 \
    --min-silence 0.6 \
    --whisper-model small \
    --language ko
```

옵션:

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--input` | (필수) | 영상 파일 경로 (여러 개 가능) |
| `--project-name` | `auto_edit` | CapCut 프로젝트 이름 |
| `--silence-db` | `-32` | 이 dB보다 작으면 무음으로 판정 |
| `--min-silence` | `0.6` | 최소 무음 길이(초). 이보다 짧으면 컷 안 함 |
| `--padding` | `0.1` | 컷 경계에 남기는 여유 시간(초) |
| `--whisper-model` | `small` | tiny / base / small / medium / large |
| `--language` | `ko` | 자막 언어 |
| `--no-subtitles` | | 자막 생성 건너뛰기 |
| `--no-cut` | | 무음 컷 건너뛰기 |
| `--draft-dir` | (자동 탐지) | CapCut 드래프트 폴더 경로 |

## CapCut 드래프트 폴더 위치

자동 탐지가 실패하면 `--draft-dir`로 직접 지정하세요.

- **Windows**: `%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft`
- **macOS**: `~/Movies/CapCut/User Data/Projects/com.lveditor.draft`

## 마무리

CapCut에서 프로젝트를 열면 컷과 자막이 적용된 상태로 보입니다. BGM, 트랜지션, 썸네일은 기존처럼 CapCut에서 직접 입히면 됩니다.
