@echo off
rem Song Shape v0.2.11: the one launcher. Checks the shared tools in SongShape_Tools, starts the local
rem helper (127.0.0.1 only) and opens the app. Without the tools it opens the app alone.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\launch\Start-SongShape.ps1"
pause
