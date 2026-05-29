$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$forgeDir = Join-Path $root "forge-bridge"

function Get-JavaMajorVersion {
    $output = & java -version 2>&1 | Out-String
    if ($output -match 'version "1\.(\d+)') {
        return [int]$Matches[1]
    }
    if ($output -match 'version "(\d+)') {
        return [int]$Matches[1]
    }
    return 0
}

if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
    Write-Error @"
Java not found on PATH.

Install JDK 17 (required for Minecraft 1.20.1 Forge mods):
  https://adoptium.net/temurin/releases/?version=17

Then set JAVA_HOME to the JDK folder and reopen your terminal.
"@
}

$major = Get-JavaMajorVersion
if ($major -lt 17) {
    Write-Error @"
Found Java $major, but JDK 17+ is required.

Install JDK 17:
  https://adoptium.net/temurin/releases/?version=17

Set JAVA_HOME, for example:
  setx JAVA_HOME "C:\Program Files\Eclipse Adoptium\jdk-17.0.13.11-hotspot"

Reopen terminal, then run this script again.
"@
}

Write-Host "Using Java $major"
Write-Host "Building Forge mod (first run may take 10-20 minutes while dependencies download)..."
Push-Location $forgeDir
try {
    & .\gradlew.bat build --no-daemon --console=plain
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}

$jar = Get-ChildItem (Join-Path $forgeDir "build\libs") -Filter "luna_companion_bridge-*.jar" |
    Where-Object { $_.Name -notmatch "sources|javadoc" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if ($jar) {
    Write-Host ""
    Write-Host "Built:" $jar.FullName
} else {
    Write-Error "Build finished but jar was not found."
}
