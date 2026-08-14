<#
.SYNOPSIS
    Windows PowerShell entry point for the Bonk-RL-Env local CI/CD engine.

.DESCRIPTION
    Forwards all arguments to scripts/local-ci.ts via npx tsx.
    Run .\scripts\Invoke-LocalCI.ps1 -Args @('--quick') or use the npm
    aliases: npm run ci, npm run ci:quick, npm run ci:full, npm run ci:bench.

.EXAMPLE
    .\scripts\Invoke-LocalCI.ps1 --quick
    .\scripts\Invoke-LocalCI.ps1 --standard --verbose
    .\scripts\Invoke-LocalCI.ps1 --bench --layer7
#>

[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    & npx tsx scripts/local-ci.ts @RemainingArgs
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
