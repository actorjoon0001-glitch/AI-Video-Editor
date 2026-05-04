# Node + Python image so the Express server can spawn faster-whisper for
# the /api/transcribe endpoint while keeping ffmpeg-native for /api/process.
#
# 가벼운 빌드 우선 — 모델은 첫 요청 시 lazy 다운로드. Render Free 빌드 환경의
# 메모리/시간 제약을 피하고, 어떤 모델을 받을지는 런타임에 WHISPER_MODEL 로 결정.
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        python3-pip \
        python3-venv \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Isolated venv keeps Python deps off the system path.
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# faster-whisper pulls in ctranslate2 with prebuilt CPU wheels.
# Pinning here so deploys are reproducible.
RUN pip install --no-cache-dir \
        faster-whisper==1.0.3

# 모델 프리다운로드는 의도적으로 하지 않는다 — Render Free 빌드/런타임에서 ~250MB
# small 모델은 OOM 위험. 기본을 tiny(~75MB)로 두고 첫 요청 시 lazy download.
# 더 큰 모델이 필요하면 Render 대시보드에서 WHISPER_MODEL=base/small 환경변수.
ENV WHISPER_MODEL=tiny

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
