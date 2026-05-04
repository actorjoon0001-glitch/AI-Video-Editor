# n8n 자동 발행 파이프라인

`youtube-pipeline.json` 을 n8n 에 import 하면 다음 흐름이 만들어집니다.

```
Webhook ─► metadata 생성 ─► thumbnail 생성 ─► Slack 검수
                                                  │
                                                  ▼
                                          YouTube 업로드 ─► Slack 알림
```

## 사전 준비

n8n 호스트(또는 컨테이너) 안에서 `auto_editor` CLI 가 동작해야 합니다.

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
# YouTube OAuth: 첫 1회는 브라우저 인증 필요 → n8n 호스트가 GUI 가능한 환경이어야 함
# 헤드리스 서버라면 로컬에서 한 번 인증해 ~/.auto_editor/youtube_token.json 을 생성한 뒤 서버로 복사.
```

## Webhook 호출 예시

CapCut 에서 export 한 영상 경로를 POST 하면 자동 실행됩니다.

```bash
curl -X POST http://localhost:5678/webhook/video-ready \
  -H 'Content-Type: application/json' \
  -d '{
    "video_path": "/Users/me/exports/episode-12.mp4",
    "workdir": "/Users/me/exports/episode-12.work",
    "persona": "B2B SaaS 마케팅 채널, 차분하고 실용적",
    "privacy": "private",
    "slack_channel": "#youtube-publish"
  }'
```

## 검수 단계 커스터마이즈

기본 워크플로는 Slack 으로 메타데이터 미리보기를 보내고 그대로 업로드합니다.
"승인 후 업로드"로 만들고 싶으면 `Slack: 검수 요청` 다음에 다음 중 하나를 끼워넣으세요.

- **Wait for Webhook** 노드: 별도 승인 URL 클릭 시 다음 노드로 진행.
- **Slack Reaction Trigger**: ✅ 이모지 반응이 붙으면 진행.

## 메타데이터 파싱 노드 주의

`metadata.json 읽기` 다음의 `메타데이터 파싱` 노드는 n8n 의 Read/Write File 출력 형태에
따라 `binary.data` 또는 `json` 으로 들어옵니다. 환경에 따라 코드 한 줄을 조정해 주세요.

## 트러블슈팅

- **`ANTHROPIC_API_KEY` not set**: n8n 컨테이너의 환경 변수에 추가 (docker-compose `environment`).
- **YouTube quota 초과**: 기본 quota 가 일 10,000 unit. 업로드 1건 ≈ 1,600 unit → 일 6건까지.
- **OAuth 만료**: refresh_token 으로 자동 갱신되지만, 60일 미접속 시 만료. 그 경우 수동 재인증.
