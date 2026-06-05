# Quick Tailscale + Minecraft reachability check (friend's shared machine "tower")
param(
    [string]$FriendTailscaleIp = "100.73.3.27",
    [int]$MinecraftPort = 0
)

$ErrorActionPreference = "Continue"
Write-Host ""
Write-Host "=== Tailscale (your PC) ===" -ForegroundColor Cyan
$svc = Get-Service -Name "Tailscale" -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Host "Tailscale service: Running"
} else {
    Write-Host "Tailscale service: NOT running — start Tailscale from the tray first." -ForegroundColor Red
}

Write-Host ""
tailscale status
$json = tailscale status --json | ConvertFrom-Json
$peerCount = if ($json.Peer) { @($json.Peer.PSObject.Properties).Count } else { 0 }
Write-Host ""
Write-Host "Peers visible: $peerCount" -ForegroundColor $(if ($peerCount -gt 0) { "Green" } else { "Yellow" })
if ($peerCount -eq 0) {
    Write-Host "tower is not listed — accept your friend's Tailscale SHARE invite (email/Discord link), then run this script again." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Ping $FriendTailscaleIp (tower) ===" -ForegroundColor Cyan
ping -n 4 $FriendTailscaleIp

Write-Host ""
Write-Host "=== Tailscale ping (works when ICMP is blocked) ===" -ForegroundColor Cyan
tailscale ping $FriendTailscaleIp 2>&1

if ($MinecraftPort -gt 0) {
    Write-Host ""
    Write-Host "=== Minecraft port $MinecraftPort on $FriendTailscaleIp ===" -ForegroundColor Cyan
    $tcp = Test-NetConnection -ComputerName $FriendTailscaleIp -Port $MinecraftPort -WarningAction SilentlyContinue
    if ($tcp.TcpTestSucceeded) {
        Write-Host "TCP ${MinecraftPort}: OPEN - try Direct Connect: ${FriendTailscaleIp}:${MinecraftPort}" -ForegroundColor Green
    } else {
        Write-Host "TCP ${MinecraftPort}: closed or filtered - friend must open LAN/server and firewall on tower." -ForegroundColor Red
    }
} else {
    Write-Host ""
    Write-Host "Tip: re-run with port when friend sends it:" -ForegroundColor DarkGray
    Write-Host "  .\scripts\test-tailscale-minecraft.ps1 -MinecraftPort 25565"
}

Write-Host ""
