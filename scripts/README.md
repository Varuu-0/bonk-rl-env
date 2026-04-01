# Scripts

Shell scripts, PowerShell scripts, and CLI tools for managing Bonk.io RL Environment servers across Unix/macOS/Linux and Windows platforms. Includes quick-start convenience scripts, detailed server management utilities, and the DSP (Data Structure Protocol) CLI for codebase graph management.

## Files

| File | Platform | Purpose |
|------|----------|---------|
| `start.sh` | Unix/macOS/Linux | Quick start — launches the server with default settings |
| `start.bat` | Windows | Quick start — launches the server with default settings |
| `start-server.sh` | Unix/macOS/Linux | Detailed server start with port and configuration options |
| `stop-server.sh` | Unix/macOS/Linux | Stop a running Bonk RL server |
| `test-server-exit.sh` | Unix/macOS/Linux | Test server exit behavior and cleanup |
| `Start-BonkServer.ps1` | Windows (PowerShell) | Start the Bonk RL server |
| `Stop-BonkServer.ps1` | Windows (PowerShell) | Stop a running Bonk RL server |
| `dsp-cli.py` | Cross-platform | Data Structure Protocol CLI for managing the `.dsp/` graph |

## Usage

### Unix/macOS/Linux

```bash
# Make scripts executable
chmod +x start.sh start-server.sh stop-server.sh test-server-exit.sh

# Quick start (default settings)
./start.sh

# Start with options (e.g. custom port)
./start-server.sh --port 8080

# Stop the server
./stop-server.sh

# Test exit behavior
./test-server-exit.sh
```

### Windows

```batch
:: Quick start (default settings)
start.bat
```

```powershell
# Start the server (PowerShell)
.\Start-BonkServer.ps1

# Stop the server (PowerShell)
.\Stop-BonkServer.ps1
```

## DSP CLI

The Data Structure Protocol CLI manages the `.dsp/` graph — a dependency graph of project entities (modules, functions, exports, imports).

```bash
# Initialize the .dsp/ directory
python scripts/dsp-cli.py --root . init

# Search for entities by keyword
python scripts/dsp-cli.py --root . search "server"

# Read the table of contents
python scripts/dsp-cli.py --root . read-toc

# Get project graph statistics
python scripts/dsp-cli.py --root . get-stats
```

> **Note:** The DSP CLI was previously located at the project root (`dsp-cli.py`). It is now at `scripts/dsp-cli.py`. All examples in project documentation use the `scripts/` path.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5555` | The port the server listens on |
