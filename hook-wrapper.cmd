@echo off
rem Stop-hook entry point. Keeps a stable path so hook configs never need to know
rem which Node binary to use, then hands over to tools\hook-handler.js which
rem detects whether Codex or DSH invoked us.
rem
rem ASCII only on purpose: cmd.exe parses .cmd files in the OEM code page, so
rem non-ASCII comments here can corrupt the batch parsing.
setlocal DisableDelayedExpansion
set "NODE_BIN=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_BIN%" set "NODE_BIN=node"
"%NODE_BIN%" "%~dp0tools\hook-handler.js" %*
rem Always 0: a "block" result (exit 2) would force another model turn.
exit /b 0
