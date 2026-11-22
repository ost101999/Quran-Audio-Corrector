#!/bin/bash
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")"
unset ELECTRON_RUN_AS_NODE
unset VITE_DEV_SERVER_URL
if [ ! -f "dist/index.html" ]; then
  npm run build || exit 1
fi
nohup ./node_modules/.bin/electron . >/dev/null 2>&1 &
disown || true
