# AI Video Editor — Backend

Node.js + Express 서버. ffmpeg native 바이너리로 영상을 편집하고 결과 mp4를 반환합니다. 클라이언트(`public/`)에서 무음 감지로 만든 keep 구간 + 옵션을 받아 컷·인코딩만 수행합니다.

## API

### `POST /api/process`
- multipart form
  - `video`: 입력 영상 파일 (필수, 500MB 이하)
  - `options`: JSON 문자열 (필수)
    ```json
    {
      "keeps": [{ "start": 0.0, "end": 12.5 }, { "start": 14.0, "end": 30.0 }],
      "ratio": "16:9",
      "speed": 1.0,
      "loudnorm": true
    }
    ```
- 응답
  ```json
  { "id": "<uuid>", "url": "/api/result/<uuid>", "durationMs": 12345, "sizeBytes": 5500000 }
  ```

### `GET /api/result/:id`
- 처리된 mp4 파일 다운로드. 1시간 후 만료.

### `GET /healthz` · `GET /api/health`
- 라우트 가용성 + 백엔드 능력치. 프론트가 이걸 보고 옵션을 켤지 정합니다.
  ```json
  {
    "ok": true,
    "whisper": true,
    "metadataProvider": "claude",   // 또는 "heuristic" (ANTHROPIC_API_KEY 없음)
    "youtube": false,               // YOUTUBE_* 자격 증명 유무
    "youtubeAllowsPublic": false,
    "routes": [ ... ]
  }
  ```

### `POST /api/jobs` — 다단계 파이프라인 (큐 모드)
영상 + 옵션을 한 번 올리면 백엔드가 6단계를 순차 처리합니다. `edit` 만 치명적이고
나머지는 실패해도 다음 단계로 진행합니다 (partial success).

| stage | 하는 일 | 실행 조건 |
|---|---|---|
| `edit` | 컷 + 비율 + 속도 + 음량 정규화 | 항상 (실패 시 전체 중단) |
| `transcribe` | Whisper 전사 → SRT/VTT | `transcribe: true` |
| `burn` | SRT 를 영상에 영구 합성 | `burn: true` + transcribe 성공 |
| `thumbnail` | 균등 분포 썸네일 추출 | `thumbnails: true` |
| `metadata` | 제목 후보/설명/태그/썸네일 카피 | `metadata: true` + transcribe 성공 |
| `upload` | YouTube 게시 | `upload: true` + 자격 증명 + metadata 성공 |

- `options` 예시
  ```json
  {
    "keeps": [{ "start": 0.0, "end": 12.5 }],
    "ratio": "16:9", "speed": 1.0, "loudnorm": true,
    "transcribe": true, "thumbnails": true, "thumbnailCount": 6,
    "language": "ko", "model": "tiny", "fillerMode": "off",
    "burn": true,
    "metadata": true, "metadataPersona": "담백한 정보 위주 리뷰 채널",
    "upload": false, "privacy": "private", "publishAt": null
  }
  ```
- 응답: `202 { "jobId": "...", "statusUrl": "/api/jobs/<id>", "pollIntervalMs": 3000 }`

### `GET /api/jobs/:id`
- 단계별 상태. 디스크 경로는 노출하지 않고 `/api/jobs/:id/files/:name` URL 로만 줍니다.

### `POST /api/jobs/:id/stages/:stage/retry`
- `transcribe` / `burn` / `thumbnail` / `metadata` 는 언제든 재시도 가능.
- `upload` 는 **실패했을 때만** 재시도 허용 (중복 게시 방지).
- `edit` 은 원본 업로드가 이미 정리돼 재시도 불가 — 재업로드 필요.

### `GET /api/jobs/:id/files/:name`
- `edited.mp4` / `burned.mp4` / `subtitles.srt` / `subtitles.vtt` / `metadata.json` / `thumb_N.jpg`

## 로컬 실행

```bash
cd server
npm install
npm start
# → http://localhost:8080
```

ffmpeg 가 시스템에 설치돼 있어야 합니다 (`brew install ffmpeg` / `apt install ffmpeg`).

## Docker 로 실행

```bash
docker build -t ai-video-editor-api server/
docker run -p 8080:8080 -e ALLOWED_ORIGINS=http://localhost:8888 ai-video-editor-api
```

## Render 배포 (권장)

1. https://render.com 가입 (GitHub 연동)
2. **New +** → **Blueprint** → 이 레포 선택
3. `server/render.yaml` 자동 감지됨
4. **Apply** 클릭 → ai-video-editor-api 서비스 생성
5. 배포 끝나면 URL 확인 (예: `https://ai-video-editor-api.onrender.com`)
6. 프론트엔드 `public/app.js` 의 `BACKEND_URL` 을 그 URL 로 설정 (또는 그대로 둬도 자동 탐지)

### 환경 변수

| 키 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `8080` | 서버 포트 |
| `ALLOWED_ORIGINS` | `https://ai-video-editor-good.netlify.app,localhost...` | CORS 허용 출처(쉼표 구분) |
| `TMP_DIR` | `/tmp/aive` | 임시 파일 디렉토리 |
| `PYTHON_BIN` | `/opt/venv/bin/python3` | faster-whisper 가 설치된 인터프리터 |
| `WHISPER_MODEL` | `tiny` | 기본 Whisper 모델 |

#### 메타데이터 (`metadata` stage)

| 키 | 기본값 | 설명 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 없음 | 있으면 Claude 로 생성. 없으면 로컬 키워드 분석으로 폴백 (stage 는 계속 동작) |
| `ANTHROPIC_MODEL` | `claude-opus-5` | 메타데이터 생성 모델 |

structured outputs 로 JSON 스키마를 강제하고, 고정 시스템 프롬프트에 prompt caching 을
걸어 반복 호출 비용을 줄입니다. 안전장치 거절에 대비해 server-side fallback 을 기본으로
켜두고, 조직에 해당 beta 가 없으면 일반 요청으로 한 번 더 시도합니다.

#### YouTube 업로드 (`upload` stage)

| 키 | 기본값 | 설명 |
|---|---|---|
| `YOUTUBE_CLIENT_ID` | 없음 | OAuth 2.0 클라이언트 ID |
| `YOUTUBE_CLIENT_SECRET` | 없음 | OAuth 2.0 클라이언트 시크릿 |
| `YOUTUBE_REFRESH_TOKEN` | 없음 | 최초 동의로 발급받은 refresh token |
| `YOUTUBE_ALLOW_PUBLIC` | `false` | `true` 가 아니면 `public` 요청도 `private` 로 낮춤 |

셋 다 없으면 `upload` stage 는 사유를 남기고 skipped 됩니다 — 실패가 아닙니다.
refresh token 은 서버에 브라우저가 없으므로 로컬에서 한 번 발급받아 넣습니다
(Google Cloud Console → OAuth 2.0 Client ID (Desktop) → `youtube.upload` 스코프로 동의).

### 비용
- Render Free: 750h/월 무료, 15분 idle 후 슬립 (첫 요청 ~30초)
- Render Starter ($7/월): 항상 켜져 있음
- Modal/Railway 도 동일한 Dockerfile 로 배포 가능

## 보안 / 제한

- 클라이언트 옵션은 화이트리스트만 통과 (임의 ffmpeg 옵션 주입 불가)
- `speed` 0.5~2.0 클램프, `ratio`/`language`/`model`/`fillerMode`/`privacy` 는 enum 검증
- 파일 크기 500MB 상한
- 결과 mp4 1시간 자동 삭제, job 산출물도 TTL 만료 시 같이 삭제
- job 응답은 디스크 경로를 노출하지 않음 (`/api/jobs/:id/files/:name` URL 로만)
- 업로드는 명시적 opt-in + 서버 자격 증명이 있어야 하고, 기본 공개 범위는 `private`.
  `public` 은 `YOUTUBE_ALLOW_PUBLIC=true` 인 배포에서만 통과
- `upload` 재시도는 실패한 경우에만 허용 (중복 게시 방지)

## 추가 기능 미지원 (TODO)
- BGM + 사이드체인 더킹 (현재 클라 ffmpeg.wasm 에만 있음)
- 다중 영상 자동 병합 (큐 모드는 단일 영상만)
- 업로드 재개(resume) — 네트워크가 끊기면 처음부터 다시 올립니다
