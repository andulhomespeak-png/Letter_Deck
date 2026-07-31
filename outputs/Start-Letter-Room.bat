@echo off
setlocal

set "ROOT=%~dp0"
set "NODE_EXE=C:\Users\andul\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
set "SERVER_JS=%ROOT%live-room-server.js"

if not exist "%NODE_EXE%" (
  echo Node runtime not found:
  echo %NODE_EXE%
  pause
  exit /b 1
)

if not exist "%SERVER_JS%" (
  echo Server file not found:
  echo %SERVER_JS%
  pause
  exit /b 1
)

cd /d "%ROOT%"
start "" "http://localhost:8787/"
"%NODE_EXE%" "%SERVER_JS%"

endlocal
