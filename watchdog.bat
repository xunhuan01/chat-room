@echo off
setlocal

set CHATROOM_DIR=C:\Users\Administrator\chat-room

:: 检查 node server.js（检测端口3000）
netstat -ano | findstr ":3000.*LISTEN" >nul 2>&1
if %errorlevel% neq 0 (
    cd /d %CHATROOM_DIR%
    start /B node server.js
)

:: 检查 cloudflared
tasklist /FI "IMAGENAME eq cloudflared.exe" 2>nul | find /I "cloudflared.exe" >nul
if %errorlevel% neq 0 (
    cd /d %CHATROOM_DIR%
    start /B cloudflared tunnel run --credentials-file data\tunnel-creds.json ce8cebb1-e625-4422-8d07-5b5ac5ab9294
)
