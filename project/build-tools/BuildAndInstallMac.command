#!/bin/bash

# Pull the latest code, build المصحح الصوتي and replace the installed macOS app cleanly.
set -euo pipefail

tools_dir="$(cd "$(dirname "$0")" && pwd)"
project_dir="$(cd "$tools_dir/.." && pwd)"
repo_dir="$(cd "$project_dir/.." && pwd)"
app_name="المصحح الصوتي.app"
installed_app="/Applications/$app_name"
stage_app="/Applications/.$app_name.new"
old_app="/Applications/.$app_name.old"

[[ -e "$stage_app" ]] && rm -rf "$stage_app"
if [[ -e "$old_app" ]]; then
  if [[ ! -e "$installed_app" ]]; then
    mv "$old_app" "$installed_app"
  else
    rm -rf "$old_app"
  fi
fi

echo "Closing المصحح الصوتي if running..."
osascript -e 'tell application id "com.quran.audiocorrector" to quit' >/dev/null 2>&1 || true
sleep 1

cd "$repo_dir"
if [[ -d "$repo_dir/.git" ]]; then
  echo "Checking for latest commits from GitHub..."
  git fetch origin main
  if [[ -z "$(git status --porcelain)" ]]; then
    git pull --ff-only
  elif ! git merge-base --is-ancestor origin/main HEAD; then
    echo "Local changes exist and repo is behind GitHub. Save/commit first."
    exit 1
  fi
fi

cd "$project_dir"
npm install --no-audit --no-fund
npm run electron:build

case "$(uname -m)" in
  arm64) source_app="$project_dir/dist_electron/mac-arm64/$app_name" ;;
  x86_64) source_app="$project_dir/dist_electron/mac/$app_name" ;;
  *) echo "Unsupported Mac architecture."; exit 1 ;;
esac
if [[ ! -d "$source_app" ]]; then
  echo "The macOS application was not created."
  exit 1
fi

ditto "$source_app" "$stage_app"
[[ -e "$installed_app" ]] && mv "$installed_app" "$old_app"
if ! mv "$stage_app" "$installed_app"; then
  [[ -e "$old_app" && ! -e "$installed_app" ]] && mv "$old_app" "$installed_app"
  exit 1
fi

if [[ -e "$old_app" ]]; then
  osascript -e 'tell application "Finder" to delete POSIX file "'"$old_app"'"' >/dev/null 2>&1 || rm -rf "$old_app"
fi

rm -rf "$project_dir/dist_electron"
env -u ELECTRON_RUN_AS_NODE open "$installed_app"
echo "Installed and opened: $installed_app"
