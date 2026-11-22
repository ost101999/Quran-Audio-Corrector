@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
set "VITE_DEV_SERVER_URL="
taskkill /F /IM "المصحح الصوتي.exe" >nul 2>&1
call npm run electron:build
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)
set "SETUP_EXE="
for /f "delims=" %%F in ('dir /b /o:-d "dist_electron\المصحح الصوتي Setup *.exe"') do (
  set "SETUP_EXE=dist_electron\%%F"
  goto :install_now
)
echo Installer exe not found.
pause
exit /b 1

:install_now
echo Installing "%SETUP_EXE%" ...
start /wait "" "%SETUP_EXE%" /S
if errorlevel 1 (
  echo Install failed.
  pause
  exit /b 1
)
start "" "%LOCALAPPDATA%\Programs\quran-audio-corrector\المصحح الصوتي.exe"
echo Built, installed, and launched successfully!
pause
exit /b 0
