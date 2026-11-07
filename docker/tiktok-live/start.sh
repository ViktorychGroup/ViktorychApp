#!/bin/sh
# Start the always-on TikTok LIVE recorder.
# With TIKTOK_AUTO_UPDATE=1 (the default) a restart picks up the newest
# commit of $VIKTORYCH_REF, so a Space restart is enough to update it.
set -eu
cd "$(dirname "$0")/../.."
if [ "${TIKTOK_AUTO_UPDATE:-1}" = "1" ] && [ -d .git ]; then
  ref="${VIKTORYCH_REF:-main}"
  if git fetch --quiet --depth 1 origin "$ref" 2>/dev/null; then
    git reset --quiet --hard FETCH_HEAD || true
  else
    echo "[tiktok-live] update check failed; starting the copy in the image"
  fi
fi
VIKTORYCH_VERSION="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
export VIKTORYCH_VERSION
export TIKTOK_RUNNER=always-on
exec python3 docker/tiktok-live/server.py
