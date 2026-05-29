@echo off
title Luna Minecraft
cd /d "%~dp0"
echo.
echo Starting Luna (companion + AI + voice)...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\free-bridge-port.ps1"
call npm run luna
echo.
pause
