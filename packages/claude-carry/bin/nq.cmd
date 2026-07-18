@echo off
REM nq.cmd - legacy alias for `carry` (project was renamed from NightQueue to Claude Carry).
REM Kept so existing PATH entries, VS Code tasks, and muscle memory still work.
setlocal
set "PATH=C:\Program Files\nodejs;C:\Program Files\Git\cmd;%PATH%"
node "%~dp0carry.mjs" %*
