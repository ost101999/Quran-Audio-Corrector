#!/bin/bash

# Build المصحح الصوتي, safely install/replace /Applications/المصحح الصوتي.app, and launch it.
set -euo pipefail

unset ELECTRON_RUN_AS_NODE
unset VITE_DEV_SERVER_URL

root_dir="$(cd "$(dirname "$0")" && pwd)"
project_dir="$root_dir/project"
app_name="المصحح الصوتي.app"
bundle_id="com.quran.audiocorrector"
installed_app="/Applications/$app_name"
stage_app="/Applications/.$app_name.new"
old_app="/Applications/.$app_name.old"

if [[ ! -d "$project_dir" ]]; then
  echo "Project folder not found: $project_dir"
  read -r -p "Press Enter to close..."
  exit 1
fi

[[ -e "$stage_app" ]] && rm -rf "$stage_app"
if [[ -e "$old_app" ]]; then
  if [[ ! -e "$installed_app" ]]; then
    mv "$old_app" "$installed_app"
  else
    osascript -e 'tell application "Finder" to delete POSIX file "'"$old_app"'"' >/dev/null 2>&1 || rm -rf "$old_app"
  fi
fi

echo "Closing running copies of المصحح الصوتي..."
osascript -e 'tell application id "'"$bundle_id"'" to quit' >/dev/null 2>&1 || true
pkill -f "$project_dir/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" >/dev/null 2>&1 || true
sleep 1

cd "$project_dir"
npm install --no-audit --no-fund
npm run electron:build

case "$(uname -m)" in
  arm64) source_app="$project_dir/dist_electron/mac-arm64/$app_name" ;;
  x86_64) source_app="$project_dir/dist_electron/mac/$app_name" ;;
  *) echo "Unsupported Mac architecture."; exit 1 ;;
esac

if [[ ! -d "$source_app" ]]; then
  echo "The macOS application was not created: $source_app"
  read -r -p "Press Enter to close..."
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

env -u ELECTRON_RUN_AS_NODE open "$installed_app"
echo "Installed and opened: $installed_app"

sleep 2
tty_name="$(tty 2>/dev/null || true)"
if [[ -n "$tty_name" && "$tty_name" != "not a tty" ]]; then
  (
    sleep 1
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
    delay 0.5
    repeat with w in (every window)
      try
        set t to selected tab of w
        if (busy of t) is false then
          set c to contents of t
          if c starts with "Last login" then
            set n to (do shell script "printf %s " & quoted form of c & " | grep -c '[^[:space:]]' || true") as integer
            if n <= 2 then close w saving no
          end if
        end if
      end try
    end repeat
    if (count of windows) is 0 then quit
  end tell
end run
APPLESCRIPT
  ) &
  disown
fi
exit 0
