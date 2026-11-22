#!/bin/bash

# Start المصحح الصوتي in live development mode (Vite + Electron).
set -euo pipefail

unset ELECTRON_RUN_AS_NODE
unset VITE_DEV_SERVER_URL

root_dir="$(cd "$(dirname "$0")" && pwd)"
project_dir="$root_dir/project"
bundle_id="com.quran.audiocorrector"

if [[ ! -d "$project_dir" ]]; then
  echo "Project folder not found: $project_dir"
  read -r -p "Press Enter to close..."
  exit 1
fi

if lsof -iTCP:5188 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "Development mode is already running on port 5188."
  open -a Electron >/dev/null 2>&1 || true
  exit 0
fi

# Close any other instance so single-instance lock lets the dev session open.
osascript -e 'tell application id "'"$bundle_id"'" to quit' >/dev/null 2>&1 || true
pkill -f "$project_dir/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" >/dev/null 2>&1 || true
sleep 1

cd "$project_dir"
if [[ ! -d "node_modules" ]]; then
  npm install --no-audit --no-fund
fi

echo "Starting المصحح الصوتي in development mode (port 5188)..."
npm run dev
