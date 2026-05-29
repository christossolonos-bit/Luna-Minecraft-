# Copies Luna's skin + CustomSkinLoader config (local skin only — no random "Luna" skins online).
param(
    [string]$MinecraftFolder = "$env:APPDATA\.minecraft"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root "assets\skins\luna.png"
$configSource = Join-Path $root "assets\CustomSkinLoader.json"

if (-not (Test-Path $source)) {
    $envPath = Join-Path $root ".env"
    if (Test-Path $envPath) {
        $line = Get-Content $envPath | Where-Object { $_ -match '^MC_SKIN_PATH=' } | Select-Object -First 1
        if ($line) {
            $custom = $line.Split('=', 2)[1].Trim()
            if (Test-Path $custom) { $source = $custom }
        }
    }
}

if (-not (Test-Path $source)) {
    Write-Error "Luna skin not found. Expected: $source"
}

$cslRoot = Join-Path $MinecraftFolder "CustomSkinLoader"
$targetDir = Join-Path $cslRoot "LocalSkin\skins"
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
Copy-Item -Path $source -Destination (Join-Path $targetDir "Luna.png") -Force
Copy-Item -Path $configSource -Destination (Join-Path $cslRoot "CustomSkinLoader.json") -Force

Write-Host "Installed:"
Write-Host "  Skin:  $(Join-Path $targetDir 'Luna.png')"
Write-Host "  Config: $(Join-Path $cslRoot 'CustomSkinLoader.json')"
Write-Host ""
Write-Host "Restart Minecraft (Fabric profile). Rejoin world so Luna reloads."
Write-Host "If skin is still wrong, run: npm run companion (after restart)"
