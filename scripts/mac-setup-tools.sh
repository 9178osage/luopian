#!/bin/sh
# Optional helper: ensure Homebrew ffmpeg / yt-dlp / gallery-dl are present.
set -eu
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew not found. Install from https://brew.sh then re-run."
  exit 1
fi
brew list ffmpeg >/dev/null 2>&1 || brew install ffmpeg
brew list yt-dlp >/dev/null 2>&1 || brew install yt-dlp
brew list gallery-dl >/dev/null 2>&1 || brew install gallery-dl
echo "OK: ffmpeg=$(command -v ffmpeg) yt-dlp=$(command -v yt-dlp) gallery-dl=$(command -v gallery-dl)"
