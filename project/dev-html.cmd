@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
call npm run dev:html
if errorlevel 1 pause
exit /b 0
