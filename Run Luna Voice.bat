@echo off
title Luna Voice (OBS)
cd /d "%~dp0"
echo.
echo Luna voice window — also opens automatically with Run Luna.bat.
echo Requires: pip install edge-tts   (and ffmpeg/ffplay on PATH for sound)
echo.
python "%~dp0scripts\luna_voice_window.py"
if errorlevel 1 (
  echo.
  echo If python failed, try: pip install edge-tts
  echo.
)
pause
