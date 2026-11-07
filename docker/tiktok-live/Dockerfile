# Always-on TikTok LIVE recorder for ViktorychApp.
#
# Self-contained: the image clones the public repository, so a Hugging Face
# Docker Space needs only this file and the README in docker/tiktok-live/space/.
# The same image runs on any Docker host (Oracle Cloud Always Free, a home
# server, Koyeb, Fly.io).
#
#   docker build -t viktorych-tiktok-live docker/tiktok-live
#   docker run --env-file tiktok-live.env -p 7860:7860 viktorych-tiktok-live
FROM python:3.12-slim-bookworm

ARG VIKTORYCH_REPO=https://github.com/ViktorychGroup/ViktorychApp.git
ARG VIKTORYCH_REF=main
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PORT=7860 \
    TIKTOK_RUNNER=always-on \
    VIKTORYCH_REPO=${VIKTORYCH_REPO} \
    VIKTORYCH_REF=${VIKTORYCH_REF}

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git nodejs xz-utils \
    && rm -rf /var/lib/apt/lists/*

# The same static ffmpeg build the Actions recorder installs. Stream copy only.
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      arm64) build=linuxarm64 ;; \
      *) build=linux64 ;; \
    esac; \
    curl -fsSL --retry 5 --retry-all-errors -o /tmp/ffmpeg.tar.xz \
      "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${build}-gpl.tar.xz"; \
    tar -xJf /tmp/ffmpeg.tar.xz -C /tmp; \
    install -m 755 "$(find /tmp -type f -path '*/bin/ffmpeg' | head -n 1)" /usr/local/bin/ffmpeg; \
    install -m 755 "$(find /tmp -type f -path '*/bin/ffprobe' | head -n 1)" /usr/local/bin/ffprobe; \
    rm -rf /tmp/ffmpeg*; \
    ffmpeg -version | head -n 1

RUN pip install --no-cache-dir "yt-dlp>=2026.10.26" "telethon==1.45.0" "cryptg==0.6.1"

# Hugging Face runs the container as uid 1000.
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    TIKTOK_KEEP_DIR=/home/user/keep
WORKDIR /home/user
RUN git clone --quiet --depth 1 --branch "${VIKTORYCH_REF}" "${VIKTORYCH_REPO}" app \
    && mkdir -p /home/user/keep
WORKDIR /home/user/app

EXPOSE 7860
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["sh", "docker/tiktok-live/start.sh"]
