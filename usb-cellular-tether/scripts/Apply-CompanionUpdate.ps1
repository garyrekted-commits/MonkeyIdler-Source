# Updates Cellular USB Link binaries ONLY — never deletes logs, settings, APKs, music, or old version EXEs.
# Usage (from companion folder): .\Apply-v1.0.29.ps1
# Usage (from repo): .\scripts\Apply-CompanionUpdate.ps1 -Version 1.0.29 -CompanionDir "C:\...\UsbCellularTether-Companion" -SourceDir "...\publish-v1.0.29"
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [string]$CompanionDir = "",
    [string]$SourceDir = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($CompanionDir)) {
    $CompanionDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    if ((Split-Path -Leaf $CompanionDir) -eq "scripts") {
        throw "Run Apply-v$Version.ps1 from your Desktop UsbCellularTether-Companion folder, or pass -CompanionDir."
    }
}

if ([string]::IsNullOrWhiteSpace($SourceDir)) {
    $SourceDir = $CompanionDir
}

Write-Host "Companion folder: $CompanionDir"
Write-Host "Binary source: $SourceDir"
Write-Host "Installing v$Version (logs, settings, APKs, music, and older EXEs are preserved)."

Get-Process UsbCellularTether.Windows, tun2socks -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3

function Copy-IfExists([string]$sourceName, [string]$destName) {
    if ([string]::IsNullOrWhiteSpace($destName)) { $destName = $sourceName }
    $src = Join-Path $SourceDir $sourceName
    if (-not (Test-Path $src)) {
        $alt = Join-Path $SourceDir "native\amd64\$sourceName"
        if (Test-Path $alt) { $src = $alt }
    }
    if (-not (Test-Path $src)) {
        Write-Host "  skip (not in source): $sourceName"
        return
    }
    $dst = Join-Path $CompanionDir $destName
    Copy-Item $src $dst -Force
    Write-Host "  updated: $destName"
}

$sideBySide = "UsbCellularTether.Windows.$Version.exe"
Copy-IfExists "UsbCellularTether.Windows.exe" $sideBySide
Copy-IfExists "UsbCellularTether.Windows.dll" "UsbCellularTether.Windows.dll"
Copy-IfExists "UsbCellularTether.Windows.deps.json" "UsbCellularTether.Windows.deps.json"
Copy-IfExists "UsbCellularTether.Windows.runtimeconfig.json" "UsbCellularTether.Windows.runtimeconfig.json"
Copy-IfExists "tun2socks.exe" "tun2socks.exe"
Copy-IfExists "wintun.dll" "wintun.dll"

$nativeAmd64 = Join-Path $SourceDir "native\amd64"
if (Test-Path $nativeAmd64) {
    $destNative = Join-Path $CompanionDir "native\amd64"
    New-Item -ItemType Directory -Path $destNative -Force | Out-Null
    foreach ($name in @("tun2socks.exe", "wintun.dll")) {
        $src = Join-Path $nativeAmd64 $name
        if (Test-Path $src) {
            Copy-Item $src (Join-Path $destNative $name) -Force
            Write-Host "  updated: native\amd64\$name"
        }
    }
}

$mainExe = Join-Path $CompanionDir "UsbCellularTether.Windows.exe"
$sidePath = Join-Path $CompanionDir $sideBySide
if (Test-Path $sidePath) {
    Copy-Item $sidePath $mainExe -Force
    Write-Host "  activated: UsbCellularTether.Windows.exe <- $sideBySide"
}

Write-Host ""
Write-Host "Done. Preserved: *.log, companion-settings.json, *.apk, *.mp3, diagnostics, older UsbCellularTether.Windows.*.exe"
Write-Host "Launch UsbCellularTether.Windows.exe as Administrator."
