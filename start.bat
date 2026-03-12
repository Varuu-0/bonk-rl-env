@echo off
REM start.bat - Non-blocking start script for Windows
REM Usage: start.bat [port]
REM 
REM This script starts the Bonk RL server in a new window without blocking the terminal.
REM For background operation with PID tracking, use: .\scripts\Start-BonkServer.ps1

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
