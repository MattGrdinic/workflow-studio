#Requires -Version 5.1
<#
.SYNOPSIS
    Installs workflow-studio on Windows.
.DESCRIPTION
    One-liner: irm https://raw.githubusercontent.com/MattGrdinic/workflow-studio/main/install.ps1 | iex
#>

$ErrorActionPreference = "Stop"

$Repo = "MattGrdinic/workflow-studio"
$InstallDir = if ($env:WORKFLOW_STUDIO_INSTALL_DIR) { $env:WORKFLOW_STUDIO_INSTALL_DIR } else { "$env:LOCALAPPDATA\workflow-studio" }
$BinDir = "$env:LOCALAPPDATA\Microsoft\WindowsApps"

function Write-Info($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Err($msg) { Write-Host "Error: $msg" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------------------
# Check for Node.js >= 20
# ---------------------------------------------------------------------------
function Test-Node {
    try {
        $ver = (node -v) -replace '^v', ''
        $major = [int]($ver.Split('.')[0])
        if ($major -ge 20) {
            Write-Info "Node.js v$ver detected"
            return $true
        }
        Write-Info "Node.js v$ver found, but v20+ is required"
        return $false
    } catch {
        Write-Info "Node.js not found"
        return $false
    }
}

function Install-Node {
    Write-Info "Installing Node.js 20..."

    # Try winget first
    $hasWinget = Get-Command winget -ErrorAction SilentlyContinue
    if ($hasWinget) {
        Write-Info "Using winget to install Node.js..."
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        # Refresh PATH
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
        return
    }

    # Fallback: direct MSI download
    $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
    $nodeUrl = "https://nodejs.org/dist/v20.18.1/node-v20.18.1-$arch.msi"
    $msiPath = "$env:TEMP\node-install.msi"

    Write-Info "Downloading Node.js installer..."
    Invoke-WebRequest -Uri $nodeUrl -OutFile $msiPath -UseBasicParsing

    Write-Info "Running installer (may require elevation)..."
    Start-Process msiexec.exe -ArgumentList "/i", $msiPath, "/qn" -Wait -Verb RunAs

    Remove-Item $msiPath -Force -ErrorAction SilentlyContinue

    # Refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
}

if (-not (Test-Node)) {
    Install-Node
    if (-not (Test-Node)) {
        Write-Err "Failed to install Node.js >= 20. Please install manually: https://nodejs.org"
    }
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Err "'npm' not found. Please ensure Node.js is installed correctly."
}

# ---------------------------------------------------------------------------
# Determine latest release
# ---------------------------------------------------------------------------
Write-Info "Fetching latest release..."

try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing
    $tag = $release.tag_name
    Write-Info "Latest release: $tag"
    $zipUrl = "https://github.com/$Repo/archive/refs/tags/$tag.zip"
} catch {
    Write-Info "No releases found, using main branch"
    $tag = $null
    $zipUrl = "https://github.com/$Repo/archive/refs/heads/main.zip"
}

# ---------------------------------------------------------------------------
# Download and extract
# ---------------------------------------------------------------------------
$tmpZip = "$env:TEMP\workflow-studio.zip"
$tmpDir = "$env:TEMP\workflow-studio-extract"

Write-Info "Downloading..."
Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip -UseBasicParsing

if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
Write-Info "Extracting..."
Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force

# Find the inner directory
$srcDir = Get-ChildItem -Path $tmpDir -Directory | Select-Object -First 1

if (-not $srcDir) {
    Write-Err "Failed to extract archive"
}

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
Write-Info "Installing to $InstallDir..."

if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
Copy-Item -Path $srcDir.FullName -Destination $InstallDir -Recurse

Push-Location $InstallDir
try {
    Write-Info "Installing dependencies..."
    npm install --omit=dev 2>$null
    if (-not $?) { npm install --omit=dev }

    if (-not (Test-Path "$InstallDir\dist")) {
        Write-Info "Building from source..."
        npm install
        npm run build
    }
} finally {
    Pop-Location
}

# ---------------------------------------------------------------------------
# Create launcher script in PATH
# ---------------------------------------------------------------------------
$launcherPath = "$InstallDir\workflow-studio.cmd"
$launcherContent = "@echo off`r`nnode `"$InstallDir\dist\cli.js`" %*"
Set-Content -Path $launcherPath -Value $launcherContent -Encoding ASCII

# Add to user PATH if not already there
$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($userPath -notlike "*$InstallDir*") {
    Write-Info "Adding workflow-studio to PATH..."
    [Environment]::SetEnvironmentVariable("PATH", "$InstallDir;$userPath", "User")
    $env:PATH = "$InstallDir;$env:PATH"
}

# Cleanup
Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Host ""
Write-Info "workflow-studio installed successfully!"
Write-Host ""
Write-Host "  Run it with:"
Write-Host "    workflow-studio" -ForegroundColor White
Write-Host ""
Write-Host "  Or with options:"
Write-Host "    workflow-studio --help" -ForegroundColor White
Write-Host ""
Write-Host "  NOTE: You may need to restart your terminal for PATH changes to take effect." -ForegroundColor Yellow
Write-Host ""
