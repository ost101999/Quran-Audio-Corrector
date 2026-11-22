#!/bin/bash

# Build المصحح الصوتي, install/replace /Applications/المصحح الصوتي.app, launch it, clean old build files, and wait for any key to close.
set -uo pipefail

unset ELECTRON_RUN_AS_NODE
unset VITE_DEV_SERVER_URL

root_dir="$(cd "$(dirname "$0")" && pwd)"
project_dir="$root_dir/project"
app_name="المصحح الصوتي.app"
bundle_id="com.quran.audiocorrector"
installed_app="/Applications/$app_name"
stage_app="/Applications/.$app_name.new"
old_app="/Applications/.$app_name.old"

close_terminal_tab() {
  local tty_name
  tty_name="$(tty 2>/dev/null || true)"
  if [[ -n "$tty_name" && "$tty_name" != "not a tty" ]]; then
    (
      osascript - "$tty_name" >/dev/null 2>&1 <<'APPLESCRIPT'
on run argv
  set myTTY to item 1 of argv
  tell application "Terminal"
    repeat with w in (every window)
      try
        repeat with t in (tabs of w)
          if (tty of t) is myTTY then
            close w saving no
            exit repeat
          end if
        end repeat
      end try
    end repeat
    if (count of windows) is 0 then quit
  end tell
end run
APPLESCRIPT
    ) >/dev/null 2>&1 &
    disown || true
  fi
}

pause_and_exit() {
  local code="${1:-0}"
  echo ""
  echo "Press any key or number to close..."
  if [[ -t 0 ]]; then
    read -r -n 1 -s || true
  fi
  close_terminal_tab
  exit "$code"
}

if [[ ! -d "$project_dir" ]]; then
  echo "Project folder not found: $project_dir"
  pause_and_exit 1
fi

[[ -e "$stage_app" ]] && rm -rf "$stage_app"
if [[ -e "$old_app" ]]; then
  if [[ ! -e "$installed_app" ]]; then
    mv "$old_app" "$installed_app"
  else
    rm -rf "$old_app"
  fi
fi

echo "[1/4] Closing running app..."
osascript -e 'tell application id "'"$bundle_id"'" to quit' >/dev/null 2>&1 || true
pkill -f "$installed_app/Contents/MacOS/" >/dev/null 2>&1 || true
pkill -f "$project_dir/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" >/dev/null 2>&1 || true
sleep 1

echo "[2/4] Cleaning previous build files and building..."
cd "$project_dir" || pause_and_exit 1
rm -rf "$project_dir/dist" "$project_dir/dist_electron"

if ! npm install --no-audit --no-fund; then
  echo "npm install failed."
  pause_and_exit 1
fi

if ! npm run electron:build; then
  echo "Build failed."
  pause_and_exit 1
fi

case "$(uname -m)" in
  arm64) source_app="$project_dir/dist_electron/mac-arm64/$app_name" ;;
  x86_64) source_app="$project_dir/dist_electron/mac/$app_name" ;;
  *) echo "Unsupported Mac architecture."; pause_and_exit 1 ;;
esac

if [[ ! -d "$source_app" ]]; then
  echo "The macOS application was not created: $source_app"
  pause_and_exit 1
fi

echo "[3/4] Removing old installed app and installing new build..."
pkill -f "$installed_app/Contents/MacOS/" >/dev/null 2>&1 || true
ditto "$source_app" "$stage_app" || { echo "Failed to stage new app."; pause_and_exit 1; }
if [[ -e "$installed_app" ]]; then
  mv "$installed_app" "$old_app" || { echo "Failed to move old app."; pause_and_exit 1; }
fi
if ! mv "$stage_app" "$installed_app"; then
  [[ -e "$old_app" && ! -e "$installed_app" ]] && mv "$old_app" "$installed_app"
  echo "Failed to install new app."
  pause_and_exit 1
fi
[[ -e "$old_app" ]] && rm -rf "$old_app"

echo "[4/4] Launching app and removing old installer files..."
env -u ELECTRON_RUN_AS_NODE open "$installed_app"
sleep 1
rm -rf "$project_dir/dist_electron"

echo ""
echo "==================================================="
echo " Done! Built, installed, launched, and cleaned up."
echo "==================================================="
pause_and_exit 0
