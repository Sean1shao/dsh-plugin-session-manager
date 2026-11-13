#Requires -Version 5.1
<#
.SYNOPSIS
把 dsh-plugin-session-manager 安装进一个 DSH profile。

.DESCRIPTION
复制包到 <profile>\node_modules，并在 <profile>\cordis.patch.yml 末尾写入一段带标记的
insert 行。两个动作都是幂等的；-Uninstall 会把它们完整撤销。

.PARAMETER Profile
目标 profile 目录，默认 %USERPROFILE%\.dsh\profiles\desktop。支持 ~ 展开。

.PARAMETER Source
包目录，默认本脚本所在目录。

.PARAMETER Uninstall
撤销安装：移除 patch 块与 node_modules 里的副本。

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile 'D:\dsh-home\profiles\web' -Uninstall

.EXAMPLE
# 脚本不在包目录里时，用 -Source 指过去
powershell -ExecutionPolicy Bypass -File C:\tools\install.ps1 -Source 'D:\work\dsh-plugin-session-manager'
#>
[CmdletBinding()]
param(
    [string]$Profile,
    [string]$Source,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$PackageName = 'dsh-plugin-session-manager'
$BeginMarker = '# >>> ' + $PackageName
$EndMarker = '# <<< ' + $PackageName

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Note([string]$Message) { Write-Host "    $Message" -ForegroundColor DarkGray }

# ── 解析参数 ────────────────────────────────────────────────────────────────────
# 注意：带 [CmdletBinding()] 的脚本里，param() 默认值求值时 $PSScriptRoot 仍是空的
# （PowerShell 5.1 的已知行为），所以路径默认值必须在脚本体内解析。
function Resolve-FullPath([string]$Value, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "$Label 为空，无法确定路径。请显式指定，例如 -$Label <绝对路径>。"
    }
    $expanded = $Value
    if ($expanded -eq '~' -or $expanded.StartsWith('~\') -or $expanded.StartsWith('~/')) {
        $rest = $expanded.Substring(1).TrimStart('\', '/')
        $expanded = if ($rest.Length -eq 0) { $HOME } else { Join-Path $HOME $rest }
    }
    try {
        return [System.IO.Path]::GetFullPath($expanded)
    }
    catch {
        throw "无法解析 $Label『$Value』：$($_.Exception.Message)"
    }
}

if ([string]::IsNullOrWhiteSpace($Profile)) {
    if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        throw '环境变量 USERPROFILE 为空，无法推断 profile 目录；请用 -Profile 指定。'
    }
    $Profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
}
if ([string]::IsNullOrWhiteSpace($Source)) {
    # -File / 点源运行时 $PSScriptRoot 已就绪；从 iex 之类的入口跑时退回到当前目录。
    $Source = if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) { (Get-Location).Path } else { $PSScriptRoot }
}

$ProfilePath = Resolve-FullPath $Profile 'Profile'
$SourcePath = Resolve-FullPath $Source 'Source'
$ManifestPath = Join-Path $ProfilePath 'package.json'
$PatchPath = Join-Path $ProfilePath 'cordis.patch.yml'
$ModulesPath = Join-Path $ProfilePath 'node_modules'
$TargetPath = Join-Path $ModulesPath $PackageName

if (-not (Test-Path -LiteralPath $ManifestPath)) {
    throw "这不是一个 DSH profile（缺少 package.json）：$ProfilePath"
}
if (-not (Test-Path -LiteralPath $PatchPath)) {
    throw "profile 缺少 cordis.patch.yml：$PatchPath"
}

Write-Step "profile: $ProfilePath"

# ── 读取 patch 并去掉旧块 ───────────────────────────────────────────────────────
function Get-PatchText {
    Get-Content -LiteralPath $PatchPath -Raw -Encoding UTF8
}

function Remove-MarkedBlock([string]$Text) {
    # A profile editor can insert other patch rows before the closing marker.
    # Remove the installer-owned row and markers while keeping those rows.
    $start = [regex]::Escape($BeginMarker)
    $end = [regex]::Escape($EndMarker)
    $name = [regex]::Escape($PackageName)
    $row = "(?m)^${start}[^\r\n]*\r?\n- insert:[ \t]*\r?\n[ \t]+- id: session-manager[ \t]*\r?\n[ \t]+name: '$name'[ \t]*\r?\n?"
    $textWithoutRow = [regex]::Replace($Text, $row, '')
    [regex]::Replace($textWithoutRow, "(?m)^${end}[ \t]*\r?\n?", '')
}

function Set-PatchText([string]$Text) {
    # 保证文件以换行结尾，避免追加块粘到最后一行上。
    $normalized = $Text.TrimEnd("`r", "`n") + "`n"
    [System.IO.File]::WriteAllText($PatchPath, $normalized, (New-Object System.Text.UTF8Encoding($false)))
}

# ── 卸载 ────────────────────────────────────────────────────────────────────────
if ($Uninstall) {
    Write-Step '卸载'

    $text = Remove-MarkedBlock (Get-PatchText)
    Set-PatchText $text
    Write-Note "已从 cordis.patch.yml 移除组合行"

    if (Test-Path -LiteralPath $TargetPath) {
        Remove-Item -LiteralPath $TargetPath -Recurse -Force
        Write-Note "已删除 $TargetPath"
    }
    else {
        Write-Note "node_modules 里没有 $PackageName，跳过"
    }

    Write-Host ''
    Write-Host '完成。重新启动 DSH 生效。' -ForegroundColor Green
    return
}

# ── 安装 ────────────────────────────────────────────────────────────────────────
Write-Step '安装'
Write-Note "源目录: $SourcePath"

if (-not (Test-Path -LiteralPath (Join-Path $SourcePath 'package.json'))) {
    throw "源目录里没有 package.json：$SourcePath"
}
if (-not (Test-Path -LiteralPath (Join-Path $SourcePath 'lib\client.js'))) {
    throw "缺少浏览器 bundle lib\client.js（是不是没构建？）：$SourcePath"
}

$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($null -ne $running) {
    Write-Host '    注意：DSH 正在运行。文件可以装进去，但要看到按钮通常需要重启 DSH。' -ForegroundColor Yellow
}

New-Item -ItemType Directory -Path $ModulesPath -Force | Out-Null
if (Test-Path -LiteralPath $TargetPath) {
    Remove-Item -LiteralPath $TargetPath -Recurse -Force
}
Copy-Item -LiteralPath $SourcePath -Destination $TargetPath -Recurse -Force
Write-Note "已复制到 $TargetPath"

$text = Remove-MarkedBlock (Get-PatchText)
# Fresh DSH profiles represent an empty patch list with a standalone [].
if ($text -match '(?m)^\s*\[\s*\]\s*(?:#.*)?$') {
    $text = $text -replace '(?m)^[ \t]*\[\s*\][ \t]*(?:#.*)?\r?\n?', ''
}
$beginNote = '(managed by install.ps1; delete this block to uninstall)'
$block = @"
$BeginMarker $beginNote
- insert:
    - id: session-manager
      name: '$PackageName'
$EndMarker
"@
Set-PatchText ($text.TrimEnd("`r", "`n") + "`n`n" + $block)
Write-Note '已在 cordis.patch.yml 写入组合行'

Write-Host ''
Write-Host '完成。下一步：完全退出 DSH 再启动（托盘菜单退出）。' -ForegroundColor Green
Write-Host '启动后在会话行「⋯」菜单的最下方就能看到「删除会话」。' -ForegroundColor Green
Write-Host '卸载：powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall' -ForegroundColor DarkGray
