[CmdletBinding()]
param(
    [switch]$Test,
    [Alias("SkillDirectory")]
    [string]$InstallRoot = (Join-Path ([Environment]::GetFolderPath("UserProfile")) ".codex\skills\codex-with-chatgpt")
)

$ErrorActionPreference = "Stop"

function Invoke-GitChecked {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = @(& git -C $script:RepoRoot @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne 0) {
        $detail = (@($output) -join [Environment]::NewLine).Trim()
        if ([string]::IsNullOrWhiteSpace($detail)) { $detail = "无错误输出" }
        throw "Git 命令失败（git $($Arguments -join ' ')；退出码 $exitCode）：$detail"
    }
    return (@($output) -join [Environment]::NewLine)
}

function Invoke-PnpmChecked {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $allArguments = @($script:PnpmPrefix) + @($Arguments)
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $script:PnpmExecutable @allArguments
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne 0) {
        throw "pnpm 命令失败（$($Arguments -join ' ')；退出码 $exitCode）。"
    }
}

try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "未找到 Git，无法检查当前分支。"
    }

    $script:RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
    if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRoot "package.json") -PathType Leaf)) {
        throw "脚本所在目录的上一级不是有效仓库：$script:RepoRoot"
    }

    $currentBranch = (Invoke-GitChecked -Arguments @("branch", "--show-current")).Trim()
    if ($currentBranch -eq "upstream-main") {
        throw "当前已 checkout upstream-main，拒绝执行开发安装。"
    }

    $pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($pnpmCommand) {
        $script:PnpmExecutable = "pnpm"
        $script:PnpmPrefix = @()
    }
    elseif (Get-Command corepack -ErrorAction SilentlyContinue) {
        $script:PnpmExecutable = "corepack"
        $script:PnpmPrefix = @("pnpm")
    }
    else {
        throw "未找到 pnpm 或 corepack，无法安装依赖。"
    }

    Push-Location $script:RepoRoot
    try {
        Invoke-PnpmChecked -Arguments @("install", "--frozen-lockfile")
        Invoke-PnpmChecked -Arguments @("run", "build")
        if ($Test) {
            Invoke-PnpmChecked -Arguments @("test", "--", "--exclude", "tests/fork-scripts.test.ts")
        }
    }
    finally {
        Pop-Location
    }

    $sourcePath = Join-Path $script:RepoRoot "skill\SKILL.md"
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "找不到源 Skill：$sourcePath"
    }
    $placeholder = "<ACTUAL_CHECKOUT_PATH>"
    $sourceText = [IO.File]::ReadAllText($sourcePath)
    $placeholderCount = ([regex]::Matches($sourceText, [regex]::Escape($placeholder))).Count
    if ($placeholderCount -ne 1) {
        throw "源 Skill 中应有且仅有一个 $placeholder，占位符数量为 $placeholderCount。"
    }
    $installedText = $sourceText.Replace($placeholder, $script:RepoRoot)

    $installDirectory = [IO.Path]::GetFullPath($InstallRoot)
    if (Test-Path -LiteralPath $installDirectory -PathType Leaf) {
        throw "Skill 安装路径不是目录：$installDirectory"
    }
    $destinationPath = Join-Path $installDirectory "SKILL.md"
    if (Test-Path -LiteralPath $destinationPath -PathType Leaf) {
        if ([IO.File]::ReadAllText($destinationPath) -eq $installedText) {
            Write-Output "✓ Skill 内容未变化，跳过写入：$destinationPath"
        }
        else {
            [IO.File]::WriteAllText($destinationPath, $installedText, [Text.UTF8Encoding]::new($false))
            Write-Output "✓ 已更新 Skill：$destinationPath"
        }
    }
    else {
        New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
        [IO.File]::WriteAllText($destinationPath, $installedText, [Text.UTF8Encoding]::new($false))
        Write-Output "✓ 已安装 Skill：$destinationPath"
    }
}
catch {
    Write-Error "开发安装失败：$($_.Exception.Message)"
    exit 1
}
