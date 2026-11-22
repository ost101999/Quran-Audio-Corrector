@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
set "VITE_DEV_SERVER_URL="
set "AUTO_CLOSE=%~1"
set "INSTALL_DIR=%LOCALAPPDATA%\Programs\quran-audio-corrector"
set "APP_EXE=%INSTALL_DIR%\المصحح الصوتي.exe"

echo [1/4] Closing running app...
taskkill /F /IM "المصحح الصوتي.exe" /T >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*المصحح الصوتي*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
ping -n 2 127.0.0.1 >nul

echo [2/4] Cleaning previous build files and building...
if exist "dist_electron" rmdir /s /q "dist_electron"
if exist "dist" rmdir /s /q "dist"
call npm run electron:build
if errorlevel 1 (
  echo.
  echo Build failed.
  if /i not "%AUTO_CLOSE%"=="--auto-close" (
    echo Press any key to close...
    pause >nul
  )
  exit /b 1
)

set "SETUP_EXE="
for /f "delims=" %%F in ('dir /b /o:-d "dist_electron\المصحح الصوتي Setup *.exe" 2^>nul') do (
  set "SETUP_EXE=dist_electron\%%F"
  goto :install_now
)
echo.
echo Installer exe not found.
if /i not "%AUTO_CLOSE%"=="--auto-close" (
  echo Press any key to close...
  pause >nul
)
exit /b 1

:install_now
echo [3/4] Removing old installed files and installing new build...
taskkill /F /IM "المصحح الصوتي.exe" /T >nul 2>&1
if exist "%INSTALL_DIR%" rmdir /s /q "%INSTALL_DIR%"
start /wait "" "%SETUP_EXE%" /S
if errorlevel 1 (
  echo.
  echo Install failed.
  if /i not "%AUTO_CLOSE%"=="--auto-close" (
    echo Press any key to close...
    pause >nul
  )
  exit /b 1
)

if not exist "%APP_EXE%" (
  echo.
  echo Installed app exe not found at "%APP_EXE%".
  if /i not "%AUTO_CLOSE%"=="--auto-close" (
    echo Press any key to close...
    pause >nul
  )
  exit /b 1
)

echo [4/4] Launching app and removing old installer files...
start "" "%APP_EXE%"
ping -n 2 127.0.0.1 >nul
if exist "dist_electron" rmdir /s /q "dist_electron"

echo.
echo ===================================================
echo  Done! Built, installed, launched, and cleaned up.
echo  Press any key or number to close...
echo ===================================================
if /i not "%AUTO_CLOSE%"=="--auto-close" pause >nul
exit /b 0
