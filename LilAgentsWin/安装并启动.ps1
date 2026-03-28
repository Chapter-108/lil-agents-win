# LilAgentsWin：绕过损坏的全局 npm，使用用户目录下的 pnpm；并确保下载 Electron 运行时。
$ErrorActionPreference = "Stop"

$pnpmRoot = "$env:LOCALAPPDATA\pnpm"
if (Test-Path "$pnpmRoot\pnpm.exe") {
    $env:Path = "$pnpmRoot;$env:Path"
} else {
    Write-Host "未找到 pnpm。请在 PowerShell 中执行（仅需一次）："
    Write-Host '  Invoke-WebRequest -Uri "https://get.pnpm.io/install.ps1" -UseBasicParsing | Invoke-Expression'
    Write-Host "然后关闭并重新打开本终端，再运行本脚本。"
    exit 1
}

Set-Location $PSScriptRoot

Write-Host ">> pnpm install"
pnpm install

Write-Host ">> 下载 Electron 二进制（pnpm 10 可能跳过依赖脚本，此处补跑）"
node .\node_modules\electron\install.js

Write-Host ">> 启动桌宠"
pnpm exec electron .
