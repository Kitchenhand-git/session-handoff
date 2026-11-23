# Install @local/session-handoff into the current DSH profile as a shim package.
#
# Why a shim: the profile's pnpm prunes node_modules directories that no
# package.json dependency points at, which is how earlier local plugins
# disappeared. The shim is a tiny package that forwards to this checkout.
#
# ASCII only. Windows PowerShell 5.1 parses BOM-less UTF-8 as GBK and dies on
# Chinese characters in .ps1 files.
[CmdletBinding()]
param(
    [switch]$Update,
    [switch]$Uninstall
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

function Read-Json($path) {
    Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Write-Json($path, $object) {
    $json = $object | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-PnpmInstall {
    if (-not (Test-Path $pnpmCjs)) { Warn2 "pnpm not found: $pnpmCjs"; return $false }
    Push-Location $profileDir
    try {
        & node $pnpmCjs install --prod=false 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { Warn2 "pnpm install exit $LASTEXITCODE"; return $false }
        Ok 'pnpm install'
        return $true
    } finally {
        Pop-Location
    }
}

function Remove-BundleRow {
    $patchPath = Join-Path $profileDir 'cordis.patch.yml'
    if (-not (Test-Path $patchPath)) { return }
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

if ($Uninstall) {
    Step 'Uninstall session-handoff'
    $pkgPath = Join-Path $profileDir 'package.json'
    Backup-File $pkgPath
    $pkg = Read-Json $pkgPath
    if ($pkg.dependencies.PSObject.Properties.Name -contains $pkgName) {
        $pkg.dependencies.PSObject.Properties.Remove($pkgName)
        Ok "dependency removed: $pkgName"
    }
    if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) {
        $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne $pkgName })
        Ok "bundle entry removed: $pkgName"
    }
    Write-Json $pkgPath $pkg
    Remove-BundleRow
    Invoke-PnpmInstall | Out-Null
    Warn2 "Source directory kept: $here (delete it manually only after a successful restart)"
    exit 0
}

Step 'Install session-handoff'
if (-not (Test-Path $profileDir)) { throw "profile not found: $profileDir" }

$rev = Get-Date -Format 'yyyyMMdd-HHmmss'
$index = Get-Content (Join-Path $here 'index.js') -Raw -Encoding UTF8
$match = [regex]::Match($index, "HOST_REV\s*=\s*'([^']+)'")
$hostRev = if ($match.Success) { $match.Groups[1].Value } else { $rev }
Ok "HOST_REV: $hostRev"

Step "Write shim package $entryName"
New-Item -ItemType Directory -Force -Path $entryDir | Out-Null
$shimPkg = [ordered]@{
    name = $pkgName
    version = '0.1.0'
    private = $true
    type = 'module'
    description = 'Session handoff: refresh a handoff document at the end of every turn'
    exports = [ordered]@{ '.' = './index.js'; './locale/*.json' = './locale/*.json'; './icon' = './icon.svg' }
    files = @('index.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg')
    dsh = [ordered]@{ bundle = [ordered]@{ patch = './cordis.patch.yml' } }
}
Write-Json (Join-Path $entryDir 'package.json') $shimPkg

$forward = ($here -replace '\\', '/')
$shimIndex = @"
const mod = await import('file:///$forward/index.js?v=$hostRev')

export const name = mod.name
export const inject = mod.inject
export const apply = mod.apply
"@
[System.IO.File]::WriteAllText((Join-Path $entryDir 'index.js'), $shimIndex, (New-Object System.Text.UTF8Encoding($false)))
Copy-Item (Join-Path $here 'cordis.patch.yml') (Join-Path $entryDir 'cordis.patch.yml') -Force
New-Item -ItemType Directory -Force -Path (Join-Path $entryDir 'locale') | Out-Null
Copy-Item (Join-Path $here 'locale\*.json') (Join-Path $entryDir 'locale') -Force
Copy-Item (Join-Path $here 'icon.svg') (Join-Path $entryDir 'icon.svg') -Force
Ok "shim written: $entryDir"

Step 'Register dependency and bundle in profile'
$pkgPath = Join-Path $profileDir 'package.json'
Backup-File $pkgPath
$pkg = Read-Json $pkgPath
if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force }
$depSpec = "file:../../local-packages/$entryName"
if ($pkg.dependencies.PSObject.Properties.Name -contains $pkgName) {
    $pkg.dependencies.$pkgName = $depSpec
} else {
    $pkg.dependencies | Add-Member -NotePropertyName $pkgName -NotePropertyValue $depSpec -Force
}
Ok "dependency: $pkgName -> $depSpec"

if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }
$bundles = @()
if ($pkg.dsh.profile.bundles) { $bundles = @($pkg.dsh.profile.bundles) }
if ($bundles -notcontains $pkgName) { $bundles += $pkgName }
$pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
Write-Json $pkgPath $pkg
Ok 'profile package.json updated'

Step 'pnpm install'
Invoke-PnpmInstall | Out-Null

Step 'Verify composed profile'
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
if ($dshCmd) {
    & dsh --profile $profileName --dump-config > $null 2>&1
    if ($LASTEXITCODE -eq 0) { Ok 'dump-config ok' } else { Warn2 "dump-config exit $LASTEXITCODE" }
} else {
    Warn2 'dsh not on PATH; skipped dump-config'
}

Ok "install finished. Restart DSH, then check Plugins for row '$rowId'."
