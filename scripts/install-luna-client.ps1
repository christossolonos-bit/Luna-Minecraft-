# Installs CustomSkinLoader + Luna skin for Minecraft 1.21.1 (Fabric) and CurseForge Fabric profiles.
param(
    [string]$MinecraftFolder = "$env:APPDATA\.minecraft",
    [switch]$SkipFabricInstall
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$modsCache = Join-Path $root ".cache\mods"
$skinScript = Join-Path $PSScriptRoot "setup-luna-skin.ps1"

$customSkinLoaderUrl = "https://cdn.modrinth.com/data/idMHQ4n2/versions/2C8mIbK2/CustomSkinLoader_Fabric-14.28.jar"
$fabricApiUrl = "https://cdn.modrinth.com/data/P7dR8mSH/versions/Lwt6YYHL/fabric-api-0.116.12%2B1.21.1.jar"
$fabricInstallerUrl = "https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar"

function Ensure-Dir($path) {
    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Force -Path $path | Out-Null
    }
}

function Download-File($url, $dest) {
    if (Test-Path $dest) {
        Write-Host "  cached: $(Split-Path $dest -Leaf)"
        return
    }
    Write-Host "  downloading: $(Split-Path $dest -Leaf)"
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
}

function Install-ModsTo($modsDir, [switch]$IncludeFabricApi) {
    Ensure-Dir $modsDir
    Download-File $customSkinLoaderUrl (Join-Path $modsCache "CustomSkinLoader_Fabric-14.28.jar")
    Copy-Item (Join-Path $modsCache "CustomSkinLoader_Fabric-14.28.jar") (Join-Path $modsDir "CustomSkinLoader_Fabric-14.28.jar") -Force

    if ($IncludeFabricApi) {
        Download-File $fabricApiUrl (Join-Path $modsCache "fabric-api-0.116.12+1.21.1.jar")
        Copy-Item (Join-Path $modsCache "fabric-api-0.116.12+1.21.1.jar") (Join-Path $modsDir "fabric-api-0.116.12+1.21.1.jar") -Force
    }

    Write-Host "  mods installed in: $modsDir"
}

Write-Host "=== Luna client installer ==="

Ensure-Dir $modsCache

if (-not $SkipFabricInstall) {
    $installerJar = Join-Path $modsCache "fabric-installer-1.0.1.jar"
    Download-File $fabricInstallerUrl $installerJar

    Write-Host "Installing Fabric loader for Minecraft 1.21.1..."
    $java = Get-Command java -ErrorAction SilentlyContinue
    if (-not $java) {
        Write-Warning "Java not on PATH. Install JDK 17+ or launch Minecraft once, then re-run this script."
    } else {
        & java -jar $installerJar client -dir $MinecraftFolder -mcversion 1.21.1 -loader 0.16.14
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Fabric installer exited with code $LASTEXITCODE. You may already have Fabric 1.21.1."
        } else {
            Write-Host "Fabric 1.21.1 profile created. In your launcher, select: fabric-loader-0.16.14-1.21.1"
        }
    }
}

Write-Host "Installing mods into .minecraft/mods ..."
Install-ModsTo (Join-Path $MinecraftFolder "mods") -IncludeFabricApi

$curseInstances = Join-Path $env:USERPROFILE "curseforge\minecraft\Instances"
if (Test-Path $curseInstances) {
    Get-ChildItem $curseInstances -Directory | ForEach-Object {
        $modsDir = Join-Path $_.FullName "mods"
        if (-not (Test-Path $modsDir)) {
            return
        }
        Write-Host "Installing CustomSkinLoader into CurseForge profile: $($_.Name)"
        Install-ModsTo $modsDir
    }
}

Write-Host "Installing Luna skin for CustomSkinLoader..."
& $skinScript -MinecraftFolder $MinecraftFolder

Write-Host ""
Write-Host "Done. Next steps:"
Write-Host "  1) Launch Minecraft with Fabric 1.21.1 (not plain vanilla 1.21.1)"
Write-Host "  2) npm run companion (with world Open to LAN)"
Write-Host "  3) Luna should appear with the crystal fox skin"
