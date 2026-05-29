# Stop stale Luna companion/AI processes and free the bridge port.
param([int]$Port = 8787)

$envFile = Join-Path $PSScriptRoot "..\.env"
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*MC_SDK_PORT=(\d+)') {
            $Port = [int]$Matches[1]
            break
        }
    }
}

Write-Host "[luna] Cleaning up stale Luna bot/AI processes..."

$stopped = 0
try {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
        $cmd = $_.CommandLine
        if (-not $cmd) { return }
        # Only stop companion + AI workers — NOT launch-luna (the active launcher).
        if ($cmd -match 'companion\.ts|luna-ai\.ts|src\\companion|examples\\luna-ai') {
            Write-Host "[luna] Stopping node PID $($_.ProcessId)"
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            $stopped++
        }
    }
} catch {
    Write-Warning "Could not enumerate node processes: $_"
}

$pids = @()
try {
    $lines = netstat -ano | Select-String "LISTENING" | Select-String ":$Port\s"
    foreach ($line in $lines) {
        $parts = ($line.ToString().Trim() -split '\s+')
        $procId = [int]$parts[-1]
        if ($procId -gt 0) { $pids += $procId }
    }
} catch {}

$pids = $pids | Select-Object -Unique
foreach ($procId in $pids) {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($proc) {
        Write-Host "[luna] Port $Port held by $($proc.ProcessName) (PID $procId) - stopping..."
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        $stopped++
    }
}

if ($stopped -gt 0) {
    Write-Host "[luna] Waiting for Windows to release sockets..."
    Start-Sleep -Seconds 3
} else {
    Write-Host "[luna] No stale Luna processes found."
}
