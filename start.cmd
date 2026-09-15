@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem Prefer node from PATH; fall back to the node bundled with WorkBuddy.
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE (
  for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if exist "%%d\node.exe" set "NODE_EXE=%%d\node.exe"
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
