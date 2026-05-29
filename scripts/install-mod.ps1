param(
    [Parameter(Mandatory = $true)]
    [string]$CurseForgeModsFolder
)

$jar = Get-ChildItem -Path "$PSScriptRoot\..\forge-bridge\build\libs" -Filter "luna_companion_bridge-*.jar" |
    Where-Object { $_.Name -notmatch "sources|javadoc" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $jar) {
    Write-Error "Mod jar not found. Run: cd forge-bridge; .\gradlew.bat build"
    exit 1
}

if (-not (Test-Path $CurseForgeModsFolder)) {
    Write-Error "Mods folder not found: $CurseForgeModsFolder"
    exit 1
}

Copy-Item -Path $jar.FullName -Destination (Join-Path $CurseForgeModsFolder $jar.Name) -Force
Write-Host "Installed $($jar.Name) to $CurseForgeModsFolder"
