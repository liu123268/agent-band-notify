@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
set "APP_ROOT=%~dp0"
if exist "%~dp0app\notify.js" set "APP_ROOT=%~dp0app\"
set "NODE_BIN=%APP_ROOT%runtime\node.exe"
if exist "%NODE_BIN%" goto run
set "NODE_BIN=node"
where.exe node >nul 2>nul
if errorlevel 1 goto missing
:run
"%NODE_BIN%" "%APP_ROOT%tools\quickstart.js" start
set "RESULT=%ERRORLEVEL%"
goto finish
:missing
echo Node.js was not found. Download AgentBandNotify-Windows-x64.zip from:
echo https://github.com/liu123268/agent-band-notify/releases/latest
echo Extract the ENTIRE ZIP before starting. Do not move this file alone.
set "RESULT=1"
:finish
if not "%BAND_NOTIFY_NO_PAUSE%"=="1" pause
exit /b %RESULT%
