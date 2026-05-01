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

### `GET /healthz`
- `{ "ok": true }`

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

### 비용
- Render Free: 750h/월 무료, 15분 idle 후 슬립 (첫 요청 ~30초)
- Render Starter ($7/월): 항상 켜져 있음
- Modal/Railway 도 동일한 Dockerfile 로 배포 가능

## 보안 / 제한

- 클라이언트 옵션은 화이트리스트만 통과 (임의 ffmpeg 옵션 주입 불가)
- `keeps` 배열, `ratio`, `speed`, `loudnorm` 만 받음
- `speed` 0.5~2.0 클램프
- 파일 크기 500MB 상한
- 결과 mp4 1시간 자동 삭제

## 추가 기능 미지원 (TODO)
- BGM + 사이드체인 더킹 (현재 클라 ffmpeg.wasm 에만 있음)
- 썸네일 후보 추출 (클라이언트에서 결과 mp4 로 따로 추출 권장)
- 자막 자동 생성 (Whisper)
