# Uninstall @local/session-handoff from the current DSH profile.
#
# ORDER MATTERS. DSH composes the profile at boot by reading each selected
# bundle's cordis.patch.yml. If the bundle package is gone while its name is
# still listed, profile composition fails at startup. So: disable the row ->
# remove bundles/dependency entries -> pnpm install -> verify -> only then
# delete the source directory.
#
# ASCII only (PowerShell 5.1 misparses BOM-less UTF-8 as GBK).
[CmdletBinding()]
param(
    [switch]$DeleteSource
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$profileName = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }
$profileDir = Join-Path $dshHome (Join-Path 'profiles' $profileName)
$localPackages = Join-Path $dshHome 'local-packages'
$entryName = 'session-handoff-entry'
$entryDir = Join-Path $localPackages $entryName
$pkgName = '@local/session-handoff'
$rowId = 'session-handoff'
$pnpmCjs = Join-Path $dshHome 'dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs'

function Step($text) { Write-Host "== $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "   OK  $text" -ForegroundColor Green }
function Warn2($text) { Write-Host "   !!  $text" -ForegroundColor Yellow }

function Backup-File($path) {
    if (Test-Path $path) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        Copy-Item $path "$path.bak-$stamp" -Force
        Ok "backup: $path.bak-$stamp"
    }
}

Step 'Uninstall session-handoff'
if (-not (Test-Path $profileDir)) { throw "profile not found: $profileDir" }

$pkgPath = Join-Path $profileDir 'package.json'
Backup-File $pkgPath
$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json

if ($pkg.dependencies -and $pkg.dependencies.PSObject.Properties.Name -contains $pkgName) {
    $pkg.dependencies.PSObject.Properties.Remove($pkgName)
    Ok "dependency removed: $pkgName"
} else {
    Ok 'dependency entry not present'
}

if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) {
    $before = @($pkg.dsh.profile.bundles).Count
    $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne $pkgName })
    Ok "bundle entry removed (before=$before, after=$(@($pkg.dsh.profile.bundles).Count))"
}

$json = $pkg | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))

$patchPath = Join-Path $profileDir 'cordis.patch.yml'
if (Test-Path $patchPath) {
    Backup-File $patchPath
    $lines = Get-Content $patchPath -Encoding UTF8
    $kept = @()
    $skip = 0
    foreach ($line in $lines) {
        if ($skip -gt 0) { $skip--; continue }
        if ($line -match "^\s*-\s*id:\s*$rowId\s*$") { $skip = 1; continue }
        $kept += $line
    }
    [System.IO.File]::WriteAllLines($patchPath, $kept, (New-Object System.Text.UTF8Encoding($false)))
    Ok 'profile patch row removed (if it existed)'
}

Step 'pnpm install'
if (Test-Path $pnpmCjs) {
    Push-Location $profileDir
    try {
        & node $pnpmCjs install 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { Warn2 "pnpm install exit $LASTEXITCODE" } else { Ok 'pnpm install' }
    } finally {
        Pop-Location
    }
} else {
    Warn2 "pnpm not found: $pnpmCjs"
}

Step 'Verify composed profile'
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
if ($dshCmd) {
    & dsh --profile $profileName --dump-config > $null 2>&1
    if ($LASTEXITCODE -eq 0) { Ok 'dump-config ok' } else { Warn2 "dump-config exit $LASTEXITCODE - restore the .bak files before restarting" }
} else {
    Warn2 'dsh not on PATH; skipped dump-config'
}

if (Test-Path $entryDir) {
    Remove-Item $entryDir -Recurse -Force
    Ok "shim removed: $entryDir"
}

if ($DeleteSource) {
    Warn2 "Deleting source directory $here"
    Set-Location (Split-Path -Parent $here)
    Remove-Item $here -Recurse -Force
    Ok 'source removed'
} else {
    Warn2 "Source kept at $here. Generated handoff files under D:\DSH\项目\*\交接 are kept on purpose."
    Warn2 "Restart DSH and confirm: Plugins has no '$rowId' row and a new session opens normally."
    Warn2 "After that, re-run with -DeleteSource to remove the source directory."
}
