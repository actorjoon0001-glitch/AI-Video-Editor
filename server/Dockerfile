# Node + Python image so the Express server can spawn faster-whisper for
# the /api/transcribe endpoint while keeping ffmpeg-native for /api/process.
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

# Pre-download the default Whisper model so the first /api/transcribe
# request doesn't pay the ~250MB download cost. `small` is the balance
# point: noticeably better than `base`, still fits comfortably in RAM.
ENV WHISPER_MODEL=small
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')"

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
