param(
  [switch]$Force,
  [string]$FfmpegPath = "",
  [ValidateRange(100, 200)][int]$ScalePercent = 125,
  [ValidateRange(0, 40)][int]$Crf = 18,
  [switch]$NoUpscale
)

$ErrorActionPreference = "Stop"

function Resolve-FfmpegExe {
  param([string]$Explicit)
  if ($Explicit -and (Test-Path $Explicit)) {
    return (Resolve-Path $Explicit).Path
  }

  $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -and (Test-Path $cmd.Source)) {
    return $cmd.Source
  }

  $wingetRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  if (Test-Path $wingetRoot) {
    $pkgDirs = Get-ChildItem -Path $wingetRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like "Gyan.FFmpeg*" }
    foreach ($d in $pkgDirs) {
      $exe = Get-ChildItem -Path $d.FullName -Recurse -Filter "ffmpeg.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($exe) { return $exe.FullName }
    }
  }

  return $null
}

function Pick-FirstExisting {
  param([string[]]$Candidates)
  foreach ($p in $Candidates) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

function Convert-IfNeeded {
  param(
    [string]$Src,
    [string]$Out,
    [string]$Ffmpeg,
    [int]$Scale,
    [int]$Vp9Crf,
    [bool]$UpscaleEnabled
  )

  if ((-not $Force) -and (Test-Path $Out) -and ((Get-Item $Out).Length -gt 1024)) {
    Write-Host "Skip existing: $Out"
    return
  }

  $vf = "format=rgba,format=yuva420p"
  if ($UpscaleEnabled) {
    $factor = [Math]::Round(($Scale / 100.0), 3)
    $vf = "format=rgba,scale=iw*${factor}:ih*${factor}:flags=lanczos,format=yuva420p"
  }

  Write-Host "Converting: $Src -> $Out"
  Write-Host "  Quality: CRF=$Vp9Crf, Scale=${Scale}%, Upscale=$UpscaleEnabled"

  & $Ffmpeg -y `
    -i "$Src" `
    -an `
    -vf "$vf" `
    -c:v libvpx-vp9 `
    -pix_fmt yuva420p `
    -auto-alt-ref 0 `
    -row-mt 1 `
    -tile-columns 2 `
    -deadline good `
    -cpu-used 0 `
    -crf $Vp9Crf `
    -b:v 0 `
    "$Out"
  if ($LASTEXITCODE -ne 0) {
    throw "ffmpeg failed for: $Out"
  }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path
$outDir = Join-Path $scriptDir "renderer/assets"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$ffmpegExe = Resolve-FfmpegExe -Explicit $FfmpegPath
if (-not $ffmpegExe) {
  Write-Host "ffmpeg.exe not found." -ForegroundColor Red
  Write-Host "Install via winget or pass a direct path:" -ForegroundColor Yellow
  Write-Host '  .\convert-walk-to-webm.ps1 -FfmpegPath "C:\path\to\ffmpeg.exe"' -ForegroundColor Yellow
  exit 1
}

Write-Host "Using FFmpeg: $ffmpegExe" -ForegroundColor Cyan

$srcBruce = Pick-FirstExisting -Candidates @(
  (Join-Path $repoRoot "LilAgents/walk-bruce-01.mov"),
  (Join-Path $repoRoot "Sounds/LilAgents_walk-bruce-01.mov"),
  (Join-Path $repoRoot "Sounds/walk-bruce-01.mov")
)
$srcJazz = Pick-FirstExisting -Candidates @(
  (Join-Path $repoRoot "LilAgents/walk-jazz-01.mov"),
  (Join-Path $repoRoot "Sounds/walk-jazz-01.mov")
)

if (-not $srcBruce) { throw "Source video missing: Bruce" }
if (-not $srcJazz) { throw "Source video missing: Jazz" }

$outBruce = Join-Path $outDir "walk-bruce-01.webm"
$outJazz = Join-Path $outDir "walk-jazz-01.webm"

$upscaleEnabled = (-not $NoUpscale)
Convert-IfNeeded -Src $srcBruce -Out $outBruce -Ffmpeg $ffmpegExe -Scale $ScalePercent -Vp9Crf $Crf -UpscaleEnabled $upscaleEnabled
Convert-IfNeeded -Src $srcJazz -Out $outJazz -Ffmpeg $ffmpegExe -Scale $ScalePercent -Vp9Crf $Crf -UpscaleEnabled $upscaleEnabled

Write-Host "Done. Restart app with: pnpm exec electron ." -ForegroundColor Green
