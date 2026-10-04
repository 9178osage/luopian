#!/bin/sh
set -eu
cd /workspace
node scripts/preview.mjs stop || true
if ! PYTHONPATH=/workspace/vendor/ytdlp /usr/bin/python3.11 -c "import yt_dlp, gallery_dl" >/dev/null 2>&1; then
  mkdir -p /workspace/vendor/ytdlp
  if ! PYTHONPATH=/workspace/vendor/ytdlp /usr/bin/python3.11 -m pip --version >/dev/null 2>&1; then
    curl -fsSL https://bootstrap.pypa.io/get-pip.py | /usr/bin/python3.11 - --target /workspace/vendor/ytdlp
  fi
  PYTHONPATH=/workspace/vendor/ytdlp /usr/bin/python3.11 -m pip install --target /workspace/vendor/ytdlp --upgrade "yt-dlp[default]" "curl_cffi" "gallery-dl"
fi
if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  exit 0
fi
npm run dev >>/tmp/app-startup.log 2>&1 &
