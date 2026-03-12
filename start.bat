@echo off
REM start.bat - Start the Bonk RL server
REM Usage: start.bat [port]
REM 
REM This script starts the Bonk RL server.
REM For non-blocking operation with PID tracking, use: .\scripts\Start-BonkServer.ps1
REM For background operation on Unix, use: ./scripts/start-server.sh

if "%1"=="" (
    set PORT=5555
) else (
    set PORT=%1
)

echo Starting Bonk RL server on port %PORT%...
echo Use the scripts in the scripts\ folder for background operation with PID tracking.
echo Or press Ctrl+C in this window to stop the server.

REM Run npm start (blocking)
npm run start
