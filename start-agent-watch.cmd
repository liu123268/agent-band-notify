@echo off
rem Manual / fallback launcher for the generic agent watcher. It watches every
rem adapter registered in src\agents\ (WorkBuddy, ZCode, Codex, DSH, and any
rem adapter added later) and starts agent-watch.js invisibly in the background.
rem
rem NOTE: the logon autostart does NOT run this file. Autostart is the registered
rem plan task "band-notify-watchers" (see taskschd.msc), which calls
rem tools\watchdog.vbs once a minute; that watchdog restarts agent-watch.js only
rem when it is actually missing. This .cmd exists as the manual fallback used by
rem the Startup route, and no second autostart route may be added: two routes each
rem start a watcher at the same second, and then every notification is sent twice.
rem
rem CAUTION: `start /b` below shares this console window, so closing the window can
rem take the watcher with it. The supported user entry point is the .vbs in the
rem project root: it detaches properly, and it re-reads the process table to
rem confirm the watcher really started before telling you so.
rem
rem ASCII only on purpose: cmd.exe parses .cmd files in the OEM code page, so
rem non-ASCII text in here can corrupt the batch parsing.
setlocal DisableDelayedExpansion

rem Prefer the DSH runtime node, then any WorkBuddy-managed node.
rem NEVER hardcode a versioned WorkBuddy path (..\node\versions\22.22.2-3\node.exe):
rem a WorkBuddy update repoints it, and the entry then fails silently at every logon
rem with no window and no log - which looks exactly like "no AI activity at all".
set "NODE_BIN=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if exist "%NODE_BIN%" goto havenode
set "NODE_BIN="
for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if exist "%%D\node.exe" set "NODE_BIN=%%D\node.exe"
if defined NODE_BIN goto havenode
set "NODE_BIN=node"
:havenode

rem Stay idempotent. This is reachable twice (double-click AND the Startup fallback),
rem and TWO watchers would send every notification twice. --status --quiet prints
rem nothing and answers only through the exit code, so nothing here has to parse
rem Chinese console text under the OEM code page.
"%NODE_BIN%" "%~dp0tools\agent-watch.js" --status --quiet
if not errorlevel 1 exit /b 0

start "" /b "%NODE_BIN%" "%~dp0tools\agent-watch.js"
exit /b 0
