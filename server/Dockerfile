# Node + Python image so the Express server can spawn faster-whisper for
# the /api/transcribe endpoint while keeping ffmpeg-native for /api/process.
#
# Render Free 환경에서 venv 의 Python 이 실제로 import 가능한지 끝에서 검증해
# 빌드가 조용히 실패하는 케이스를 차단한다. 모델은 첫 transcribe 요청 시 lazy
# 다운로드 (Dockerfile 안에서 모델 받지 않음).
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        python3-pip \
        python3-venv \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# venv 격리 — 시스템 python 과 분리.
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHON_BIN="/opt/venv/bin/python3"

# pip 업그레이드 → faster-whisper 설치 → 즉시 import 검증.
# 빌드 단계에서 import 가 실패하면 도커 빌드가 즉시 중단되므로 옛 컨테이너가
# 살아남을 일이 없다.
#
# requests 를 명시적으로 같이 설치한다 — faster-whisper 1.0.3 의 utils.py 가
# 모듈 최상단에서 `import requests` 를 하지만, 자기 install_requires 에는 넣지
# 않았다. 옛 huggingface-hub 가 transitive 로 끌어오던 시절엔 우연히 동작했지만,
# 최신 huggingface-hub(1.x) 는 httpx 로 옮겨가서 requests 를 안 끌어오니까
# `ModuleNotFoundError: No module named 'requests'` 가 import 시점에 터진다.
RUN /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/venv/bin/pip install --no-cache-dir faster-whisper==1.0.3 requests \
 && /opt/venv/bin/python3 -c "from faster_whisper import WhisperModel; print('faster-whisper import OK')"

# 모델은 lazy download — small(~250MB) 프리다운로드는 Render Free 빌드/메모리에
# 부담이라 첫 요청 시 받게 둔다. 기본은 tiny(~75MB).
ENV WHISPER_MODEL=tiny

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
