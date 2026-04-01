# .githooks

Custom Git hooks for DSP (Data Structure Protocol) maintenance and code quality enforcement.

| File | Description |
|------|-------------|
| `pre-commit` | Runs DSP consistency checks on staged files before commit |
| `pre-push` | Performs full graph integrity check (orphans, cycles) before push |
| `dsp-agent-review.ps1` | PowerShell script to generate DSP review context for agent-assisted review |
| `dsp-agent-review.sh` | Bash script to generate DSP review context for agent-assisted review |
| `dsp-check-staged.ps1` | PowerShell script to check staged files against the DSP graph |
| `dsp-check-staged.sh` | Bash script to check staged files against the DSP graph |
| `install-hooks.ps1` | PowerShell installer to copy hooks into `.git/hooks/` |
| `install-hooks.sh` | Bash installer to copy hooks into `.git/hooks/` |

## Installation

### Bash / macOS / Linux

```bash
./.githooks/install-hooks.sh
```

### PowerShell / Windows

```powershell
.\.githooks\install-hooks.ps1
```

## Configuration

Hooks are controlled via environment variables:

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `DSP_PRECOMMIT_MODE` | `warn`, `block` | `warn` | Whether pre-commit should block on DSP errors |
| `DSP_SKIP_PATTERNS` | glob patterns | `*.md,*.txt,*.json,...` | File patterns to skip in DSP checks |
