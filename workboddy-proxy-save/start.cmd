@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem NOTE: keep this file pure ASCII. cmd.exe mis-parses .cmd files that mix
rem non-ASCII text with chcp 65001, and the lines after it silently stop running.

rem Prefer node from PATH; fall back to the node bundled with WorkBuddy.
rem (both the CN and the intl desktop app ship one under their user data dir)
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE (
  for %%h in ("%USERPROFILE%\.workbuddy" "%USERPROFILE%\.workbuddy-ai") do (
    for /d %%d in ("%%~h\binaries\node\versions\*") do (
      if not defined NODE_EXE if exist "%%d\node.exe" set "NODE_EXE=%%d\node.exe"
    )
  )
)
if not defined NODE_EXE (
  echo [ERROR] node not found. Install Node.js 18.20.8 or newer.
  pause
  exit /b 1
)

echo Using node: %NODE_EXE%
"%NODE_EXE%" "%~dp0wb-relay.js" %*
pause
