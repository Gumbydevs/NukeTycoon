# Dev helper: start server + static frontend for local testing
# Usage: Right-click -> Run with PowerShell, or run in PowerShell: .\dev-start.ps1

# Recommended: run from repo root
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "Starting dev environment from: $root"

# Dev environment variables
$localAdminKey = 'dev_admin'

# Ensure Node deps installed for server
Write-Host 'Installing server dependencies (if needed)...'
Push-Location (Join-Path $root 'server')
if (Test-Path 'package.json') {
    npm install
} else {
    Write-Host 'server/package.json not found — aborting.' -ForegroundColor Red
    Pop-Location
    exit 1
}
Pop-Location

# Launch server in new PowerShell window
# Build the command string WITHOUT expanding $env variables in this script.
$serverPath = Join-Path $root 'server'
$escapedAdminKey = $localAdminKey -replace "'","''"
$serverCmd = '$env:LOCAL_DEV = "true"; $env:ADMIN_KEY = ''' + $escapedAdminKey + '''; Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue; Set-Location "' + $serverPath + '"; npm run dev'
Write-Host "Launching server (LOCAL_DEV mode) in new window..."
Start-Process powershell -ArgumentList ('-NoExit','-Command', $serverCmd)

# Launch static server for frontend in new PowerShell window
$frontendCmd = 'Set-Location "' + $root + '"; npx serve -s . -l 8080'
Write-Host "Launching static frontend server on http://localhost:8080 in new window..."
Start-Process powershell -ArgumentList ('-NoExit','-Command', $frontendCmd)

Write-Host "\nDev startup launched."
Write-Host "Browse the game at: http://localhost:8080" -ForegroundColor Green
Write-Host "Admin UI: http://localhost:3001/admin (use header/query/body key = $localAdminKey)" -ForegroundColor Yellow
Write-Host "Note: LOCAL_DEV uses an in-memory stub DB (development only)." -ForegroundColor Cyan

# End of script
