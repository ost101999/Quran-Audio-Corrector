@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
set "VITE_DEV_SERVER_URL="
if not exist "%~dp0dist\index.html" (
  call npm run build
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0
