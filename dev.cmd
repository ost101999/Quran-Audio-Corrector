@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
set "VITE_DEV_SERVER_URL="
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5188 -State Listen -ErrorAction SilentlyContinue) { exit 1 }"
if errorlevel 1 (
  echo Port 5188 is already in use. Close the other development session and try again.
  pause
  exit /b 1
)
call npm run dev
if errorlevel 1 pause
exit /b 0
