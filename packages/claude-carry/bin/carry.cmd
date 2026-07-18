@echo off
REM carry.cmd - PATH-robust wrapper so `carry` works from cmd.exe and VS Code tasks
REM even though node/git are not on this machine's default PATH. Put this bin\
REM folder on your PATH to call `carry` anywhere, or VS Code tasks call it directly.
setlocal
set "PATH=C:\Program Files\nodejs;C:\Program Files\Git\cmd;%PATH%"
node "%~dp0nq.mjs" %*
