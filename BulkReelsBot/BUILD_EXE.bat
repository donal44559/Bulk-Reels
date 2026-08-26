@echo off
REM ============================================================
REM  Bulk Reels Upload Pro - Windows EXE build script
REM  Double-click this file on a Windows PC to produce the
REM  standalone .exe in the .\release folder.
REM
REM  Requirements:
REM    - Node.js 18+        (https://nodejs.org)  -> include in PATH
REM    - npm (comes with Node.js)
REM    - Internet connection (downloads Electron + Chromium build)
REM  Optional: better-sqlite3 needs a working internet for its
REM  prebuilt binary (falls back to compiling with Visual Studio
REM  Build Tools if the prebuilt download is unavailable).
REM ============================================================
setlocal enabledelayedexpansion
chcp 65001 >nul

REM --- Move to this script's folder ---
cd /d "%~dp0"
if errorlevel 1 goto :fail_cd

echo.
echo ============================================================
echo   Building Bulk Reels Upload Pro (standalone EXE)
echo ============================================================
echo.

REM --- Check node / npm ---
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH.
  echo         Install Node.js 18+ from https://nodejs.org and rerun.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found in PATH.
  echo         Install Node.js 18+ from https://nodejs.org and rerun.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODE_VER=%%v
echo   Node : !NODE_VER!
echo.

echo [1/3] Installing dependencies (this downloads Electron + Chromium)...
call npm install
if errorlevel 1 (
  echo.
  echo [ERROR] npm install failed. See messages above.
  echo   Tip: better-sqlite3 may need Visual Studio Build Tools, OR
  echo   make sure you have internet so its prebuilt binary downloads.
  pause
  exit /b 1
)
echo   Dependencies installed.
echo.

echo [2/3] Building renderer + packaging Windows EXE...
call npm run pack:win
if errorlevel 1 (
  echo.
  echo [ERROR] npm run pack:win failed. See messages above.
  pause
  exit /b 1
)
echo.

echo ============================================================
echo   DONE! Your EXE is in the .\release folder:
echo     %~dp0release\BulkReelsUploadPro-1.5.0.exe
echo ============================================================
echo.
echo   First time you run it, it will show a short "First-time Setup"
echo   window that downloads the Chromium engine (~170 MB) once.
echo   This happens only once and is reused afterwards.
echo.
pause
exit /b 0

:fail_cd
echo [ERROR] Could not change to the script folder.
pause
exit /b 1
