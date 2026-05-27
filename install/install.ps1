param(
  [string]$Version = $env:MANGO_LSP_VERSION,
  [string]$Tag = $env:MANGO_LSP_TAG,
  [string]$InstallDir = $(Join-Path $env:LOCALAPPDATA "Programs\mango-lsp"),
  [string]$Repo = $(if ($env:MANGO_LSP_REPO) { $env:MANGO_LSP_REPO } else { "juliopolycarpo/mango-lsp-proxy" })
)

$ErrorActionPreference = "Stop"

function Get-MangoArch {
  if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
    return "arm64"
  }
  if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") {
    return "arm64"
  }
  return "x64"
}

function Get-MangoLatestTag {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
  return $release.tag_name
}

$Version = $Version -replace "^v", ""

if (-not $Tag) {
  if (-not $Version) {
    $Tag = Get-MangoLatestTag
    $Version = $Tag -replace "^v", ""
  } else {
    $Tag = "v$Version"
  }
} else {
  if (-not $Version) {
    $Version = $Tag -replace "^v", ""
  }
}

$arch = Get-MangoArch
$asset = "mango-lsp-$Version-windows-$arch.exe"
$url = "https://github.com/$Repo/releases/download/$Tag/$asset"
$binaryPath = Join-Path $InstallDir "mango-lsp.exe"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Invoke-WebRequest -Uri $url -OutFile $binaryPath

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$paths = $userPath -split ";" | Where-Object { $_ }
if ($paths -notcontains $InstallDir) {
  $newPath = (@($paths) + $InstallDir) -join ";"
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  Write-Host "Added $InstallDir to the user PATH. Open a new terminal to use it."
}

Write-Host "Installed mango-lsp to $binaryPath"
