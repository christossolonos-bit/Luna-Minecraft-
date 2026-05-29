@echo off
title Stop Luna
cd /d "%~dp0"
echo.
echo Stopping stale Luna processes on the bridge port...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\free-bridge-port.ps1"
echo.
echo Done. Close any remaining "Luna Minecraft" terminal windows manually if needed.
echo.
pause
