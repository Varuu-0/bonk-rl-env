#!/usr/bin/env bash
# start-server.sh - Start the Bonk RL server in background
# Usage: ./start-server.sh [port]
#
# This script starts the Bonk.io RL server as a background process.
# It creates a PID file for tracking and cleanup.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$SCRIPT_DIR/server.pid"
LOG_FILE="$SCRIPT_DIR/server.log"

# Default port
PORT="${1:-5555}"

# Validate port is a number
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
    echo "Error: Port must be a number, got: $PORT"
    exit 1
fi

if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo "Error: Port must be between 1 and 65535, got: $PORT"
    exit 1
fi

# Check if server is already running
if [ -f "$PID_FILE" ]; then
    EXISTING_PID=$(cat "$PID_FILE")
    if kill -0 "$EXISTING_PID" 2>/dev/null; then
        echo "Server is already running with PID $EXISTING_PID"
        exit 1
    else
        echo "Removing stale PID file..."
        rm -f "$PID_FILE"
    fi
fi

echo "Starting Bonk RL server on port $PORT..."
cd "$PROJECT_DIR"

# Export PORT for the npm process
export PORT

# Start server in background with nohup
nohup npm start > "$LOG_FILE" 2>&1 &
SERVER_PID=$!

# Save PID
echo "$SERVER_PID" > "$PID_FILE"

# Wait for server to start
sleep 2

# Check if server started successfully
if kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server started successfully (PID: $SERVER_PID)"
    echo "Log file: $LOG_FILE"
    echo "To stop: ./stop-server.sh or kill $SERVER_PID"
else
    echo "Server failed to start. Check log: $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
fi
