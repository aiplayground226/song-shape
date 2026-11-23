@echo off
rem Drag a video (mp4, mkv, mov, webm...) or a song onto this file: audio, then the vocal stem, in a *_songshape folder next to it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rip_video_to_vocals.ps1" %*
pause
