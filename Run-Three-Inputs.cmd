@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required for the optional command-line route.
  echo The offline browser application needs no Node.js: run Start-SongShape.cmd.
  pause
  exit /b 1
)
echo Song Shape v0.2.10 - offline CPU analysis
echo.
set /p "AUDIO=Full path to your lead WAV: "
set /p "REF=Full path to known original lyrics TXT: "
set /p "NEW=Full path to your replacement lyrics TXT: "
set /p "DEST=Full path to NEW output folder: "
if not defined AUDIO exit /b 1
if not defined REF exit /b 1
if not defined NEW exit /b 1
if not defined DEST exit /b 1
node cli\songshape.js analyze "%AUDIO:"=%" "%REF:"=%" "%NEW:"=%" -o "%DEST:"=%"
set "STATUS=%ERRORLEVEL%"
echo.
if "%STATUS%"=="0" (echo Created local report, visual map and AI text in output folder.) else (echo Analysis did not complete. Input files remain unchanged.)
pause
exit /b %STATUS%
