#!/bin/sh
# Install the local tools used by the desktop app and CLI.
set -eu
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew not found. Install Homebrew before running this command."
  exit 1
fi
brew list ffmpeg >/dev/null 2>&1 || brew install ffmpeg
brew list yt-dlp >/dev/null 2>&1 || brew install yt-dlp
echo "OK: ffmpeg=$(command -v ffmpeg) yt-dlp=$(command -v yt-dlp)"
