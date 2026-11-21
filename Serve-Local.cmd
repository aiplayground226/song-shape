@echo off
rem Optional: open Song Shape over http://127.0.0.1 so a local Ollama accepts it with default settings.
cd /d "%~dp0"
echo Starting Song Shape on http://127.0.0.1:8765/ (this computer only). Press Ctrl+C to stop.
start "" http://127.0.0.1:8765/
node tools\serve-local.js 8765
