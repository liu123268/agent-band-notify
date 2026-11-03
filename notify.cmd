@echo off
rem Stable launcher for Codex / DSH / any hook that needs a plain command.
rem Edit NODE_BIN if you move Node.
rem
rem Set BAND_NOTIFY_TRACE=1 (or create logs\trace-on.flag) to record every
rem invocation into logs\invocations.log - used to see how Codex's computer-use
rem wrapper mangles our arguments.
setlocal DisableDelayedExpansion
set "NODE_BIN=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_BIN%" set "NODE_BIN=node"
if not defined BAND_NOTIFY_TRACE if exist "%~dp0logs\trace-on.flag" set "BAND_NOTIFY_TRACE=1"
"%NODE_BIN%" "%~dp0notify.js" %*
exit /b 0
