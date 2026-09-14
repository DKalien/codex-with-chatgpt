[CmdletBinding()]
param(
    [switch]$Test,
    [Alias("SkillDirectory")]
    [string]$InstallRoot = (Join-Path ([Environment]::GetFolderPath("UserProfile")) ".codex\skills\codex-with-chatgpt")
)

$ErrorActionPreference = "Stop"
# Node 的 JSON 使用 UTF-8；Windows PowerShell 5.1 必须用同一编码捕获中文名称。
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

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

function Invoke-NodeChecked {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $script:NodeExecutable @Arguments
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne 0) {
        throw "Node 命令失败（$($Arguments -join ' ')；退出码 $exitCode）。"
    }
}

function Resolve-CoreStateDir {
    $override = [Environment]::GetEnvironmentVariable("C2C_STATE_DIR")
    if (-not [String]::IsNullOrWhiteSpace($override)) {
        return [IO.Path]::GetFullPath($override)
    }
    $base = [Environment]::GetFolderPath("LocalApplicationData")
    if ([String]::IsNullOrWhiteSpace($base)) {
        $base = Join-Path ([Environment]::GetFolderPath("UserProfile")) "AppData\Local"
    }
    return [IO.Path]::GetFullPath((Join-Path $base "codex-with-chatgpt"))
}

function ConvertTo-RolloutSummary {
    param([object[]]$Output)

    $countNames = @("current", "upgraded", "stopped", "pending_busy", "skipped_quick", "pending", "error")
    $reportedCounts = [ordered]@{}
    $payloads = @()
    $foundContract = $false
    foreach ($line in $Output) {
        try {
            # ConvertFrom-Json 的 -Depth 仅在 PowerShell 6+ 可用；开发安装脚本
            # 仍需兼容 Windows PowerShell 5.1。
            $payload = ([string]$line | ConvertFrom-Json)
        }
        catch {
            continue
        }
        if ($null -eq $payload) { continue }
        $countsProperty = $payload.PSObject.Properties | Where-Object { $_.Name -eq "counts" } | Select-Object -First 1
        $workspacesProperty = $payload.PSObject.Properties | Where-Object { $_.Name -eq "workspaces" } | Select-Object -First 1
        if ($null -eq $countsProperty -or $null -eq $workspacesProperty) { continue }
        $foundContract = $true
        foreach ($name in $countNames) {
            $property = $countsProperty.Value.PSObject.Properties | Where-Object { $_.Name -eq $name } | Select-Object -First 1
            if ($null -eq $property) { throw "rollout summary 缺少 counts.$name。" }
            $number = 0L
            if (-not [long]::TryParse(
                    [string]$property.Value,
                    [Globalization.NumberStyles]::Integer,
                    [Globalization.CultureInfo]::InvariantCulture,
                    [ref]$number
                ) -or $number -lt 0) {
                throw "rollout summary 的 counts.$name 无效。"
            }
            $reportedCounts[$name] = $number
        }
        $payloads += $payload
    }

    if (-not $foundContract) { throw "rollout 未返回有效 JSON summary。" }
    $counts = [ordered]@{}
    if ($reportedCounts.Count -ne $countNames.Count -or $payloads.Count -eq 0) {
        throw "rollout 未返回可确认的 JSON 汇总；不能把未知结果显示为全零成功。"
    }
    foreach ($name in $countNames) {
        $counts[$name] = $reportedCounts[$name]
    }
    # 只消费 rollout contract 的 workspaces 字段；不猜测旧的 results/result 形状。
    $workspaces = @()
    foreach ($payload in $payloads) {
        foreach ($item in @($payload.workspaces)) {
            if ($null -eq $item) { continue }
            $row = [ordered]@{
                workspaceId = [string]$item.workspaceId
                workspaceName = [string]$item.workspaceName
                status = [string]$item.status
            }
            $reasonProperty = $item.PSObject.Properties | Where-Object { $_.Name -eq "reason" } | Select-Object -First 1
            if ($null -ne $reasonProperty -and $reasonProperty.Value -is [string]) {
                $row.reason = [string]$reasonProperty.Value
            }
            $workspaces += $row
        }
    }
    return [ordered]@{ counts = $counts; workspaces = $workspaces }
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

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw "未找到 Node.js，无法安装稳定 C2C core。"
    }
    $script:NodeExecutable = "node"

    Push-Location $script:RepoRoot
    try {
        # 首次升级旧 v1 pointer 时先冻结原已安装 A；后续 build 失败也不会破坏 A。
        Invoke-NodeChecked -Arguments @(
            (Join-Path $script:RepoRoot "scripts\install-core.mjs"), "--protect-current", "--json"
        )
        Invoke-PnpmChecked -Arguments @("install", "--frozen-lockfile")
        Invoke-PnpmChecked -Arguments @("run", "build")
        if ($Test) {
            Invoke-PnpmChecked -Arguments @("test", "--exclude", "tests/fork-scripts.test.ts", "--maxWorkers=1", "--testTimeout=60000")
        }
        Invoke-NodeChecked -Arguments @(
            (Join-Path $script:RepoRoot "scripts\install-core.mjs"),
            "--checkout-root", $script:RepoRoot, "--json"
        )

        $script:LauncherPath = Join-Path (Resolve-CoreStateDir) "bin\c2c.js"
        if (-not (Test-Path -LiteralPath $script:LauncherPath -PathType Leaf)) {
            throw "稳定 launcher 安装后不存在：$script:LauncherPath"
        }

        $sourcePath = Join-Path $script:RepoRoot "skill\SKILL.md"
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "找不到源 Skill：$sourcePath"
        }
        $placeholder = "<C2C_LAUNCHER_PATH>"
        $sourceText = [IO.File]::ReadAllText($sourcePath)
        $placeholderCount = ([regex]::Matches($sourceText, [regex]::Escape($placeholder))).Count
        if ($placeholderCount -ne 1) {
            throw "源 Skill 中应有且仅有一个 $placeholder，占位符数量为 $placeholderCount。"
        }
        $installedText = $sourceText.Replace($placeholder, $script:LauncherPath)
    }
    finally {
        Pop-Location
    }

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

    try {
        # 不创建原生命令输出管道：后台 Bridge 可能继承它并阻止安装调用返回。
        $rolloutResultFile = Join-Path ([IO.Path]::GetTempPath()) ("c2c-rollout-" + [guid]::NewGuid().ToString("N") + ".json")
        try {
            $rolloutProcess = Start-Process -FilePath $script:NodeExecutable -ArgumentList @(
                ('"' + $script:LauncherPath + '"'), "rollout", "--json", "--result-file", ('"' + $rolloutResultFile + '"')
            ) -WorkingDirectory (Get-Location).ProviderPath -WindowStyle Hidden -PassThru
            $null = $rolloutProcess.Handle
            while (-not $rolloutProcess.WaitForExit(250)) { }
            $rolloutExitCode = $rolloutProcess.ExitCode
            $rolloutOutput = @([IO.File]::ReadAllLines($rolloutResultFile, [Text.Encoding]::UTF8))
            $rolloutProcess.Dispose()
        }
        finally {
            Remove-Item -LiteralPath $rolloutResultFile -Force -ErrorAction SilentlyContinue
        }
        $rolloutSummary = ConvertTo-RolloutSummary -Output $rolloutOutput
        $rolloutSummaryText = $rolloutSummary | ConvertTo-Json -Compress -Depth 8
        if ($rolloutExitCode -ne 0) {
            Write-Warning "stable core rollout 未成功（best effort，已保留 core 与 Skill；退出码 $rolloutExitCode）：$rolloutSummaryText"
        }
        else {
            Write-Output "✓ stable core rollout summary：$rolloutSummaryText"
        }
    }
    catch {
        Write-Warning "stable core rollout 未能启动（best effort，已保留 core 与 Skill）：$($_.Exception.Message)"
    }
}
catch {
    Write-Error "开发安装失败：$($_.Exception.Message)"
    exit 1
}
