[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

function Invoke-GitRaw {
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
    return [pscustomobject]@{
        ExitCode = $exitCode
        Output   = (@($output) -join [Environment]::NewLine)
    }
}

function Invoke-GitChecked {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $result = Invoke-GitRaw -Arguments $Arguments
    if ($result.ExitCode -ne 0) {
        $detail = $result.Output.Trim()
        if ([string]::IsNullOrWhiteSpace($detail)) { $detail = "无错误输出" }
        throw "Git 命令失败（git $($Arguments -join ' ')；退出码 $($result.ExitCode)）：$detail"
    }
    return $result.Output
}

function Get-OptionalConfig {
    param([Parameter(Mandatory)][string]$Name)

    $result = Invoke-GitRaw -Arguments @("config", "--local", "--get", $Name)
    if ($result.ExitCode -eq 0) { return $result.Output.Trim() }
    if ($result.ExitCode -eq 1) { return $null }
    throw "读取 Git 配置 $Name 失败（退出码 $($result.ExitCode)）：$($result.Output.Trim())"
}

function Assert-UpstreamMainNotCheckedOut {
    $worktreeText = Invoke-GitChecked -Arguments @("worktree", "list", "--porcelain")
    if (@($worktreeText -split "`r?`n" | Where-Object { $_.Trim() -eq "branch refs/heads/upstream-main" }).Count -gt 0) {
        throw "upstream-main 已在当前或其他 linked worktree 中 checkout，拒绝移动。"
    }
}

try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "未找到 Git，无法同步 upstream/main。"
    }

    $script:RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
    if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRoot ".git") -PathType Container) -and
        -not (Test-Path -LiteralPath (Join-Path $script:RepoRoot ".git") -PathType Leaf)) {
        throw "脚本所在目录的上一级不是有效 Git 仓库：$script:RepoRoot"
    }

    # 先确认目标分支没有被任何 worktree 使用，避免移动正在使用的分支。
    Assert-UpstreamMainNotCheckedOut

    # 只有此人工同步命令访问 upstream；不改变当前分支和工作区。
    $fetch = Invoke-GitRaw -Arguments @(
        "fetch",
        "upstream",
        "refs/heads/main:refs/remotes/upstream/main",
        "--refmap=",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head"
    )
    if ($fetch.ExitCode -ne 0) {
        $detail = $fetch.Output.Trim()
        if ([string]::IsNullOrWhiteSpace($detail)) { $detail = "无错误输出" }
        throw "获取 upstream/main 失败（退出码 $($fetch.ExitCode)）：$detail"
    }

    $remoteSha = (Invoke-GitChecked -Arguments @("rev-parse", "--verify", "refs/remotes/upstream/main")).Trim()
    if ($remoteSha -notmatch "^[0-9a-fA-F]{40,}$") {
        throw "refs/remotes/upstream/main 不是有效提交引用。"
    }

    $localResult = Invoke-GitRaw -Arguments @("show-ref", "--verify", "--quiet", "refs/heads/upstream-main")
    if ($localResult.ExitCode -eq 1) {
        Assert-UpstreamMainNotCheckedOut
        $zeroSha = "0" * $remoteSha.Length
        Invoke-GitChecked -Arguments @("update-ref", "--no-deref", "refs/heads/upstream-main", $remoteSha, $zeroSha) | Out-Null
        Invoke-GitChecked -Arguments @("config", "--local", "branch.upstream-main.remote", "upstream") | Out-Null
        Invoke-GitChecked -Arguments @("config", "--local", "branch.upstream-main.merge", "refs/heads/main") | Out-Null
        Write-Output "✓ 已创建 upstream-main，并设置 tracking 为 upstream/main。"
        exit 0
    }
    if ($localResult.ExitCode -ne 0) {
        throw "读取 refs/heads/upstream-main 失败（退出码 $($localResult.ExitCode)）：$($localResult.Output.Trim())"
    }

    $symbolicResult = Invoke-GitRaw -Arguments @("symbolic-ref", "--quiet", "refs/heads/upstream-main")
    if ($symbolicResult.ExitCode -eq 0) {
        throw "refs/heads/upstream-main 是 symbolic ref，拒绝移动。"
    }
    if ($symbolicResult.ExitCode -ne 1) {
        throw "检查 refs/heads/upstream-main 类型失败（退出码 $($symbolicResult.ExitCode)）：$($symbolicResult.Output.Trim())"
    }

    $localSha = (Invoke-GitChecked -Arguments @("rev-parse", "--verify", "refs/heads/upstream-main")).Trim()
    if ($localSha -notmatch "^[0-9a-fA-F]{40,}$") {
        throw "refs/heads/upstream-main 不是有效提交引用。"
    }

    $trackingRemote = Get-OptionalConfig "branch.upstream-main.remote"
    $trackingMerge = Get-OptionalConfig "branch.upstream-main.merge"
    if ($null -ne $trackingRemote -and $trackingRemote -ne "upstream") {
        throw "upstream-main 的 tracking remote 为 $trackingRemote，拒绝覆盖；必须是 upstream/main。"
    }
    if ($null -ne $trackingMerge -and $trackingMerge -ne "refs/heads/main") {
        throw "upstream-main 的 tracking 分支为 $trackingMerge，拒绝覆盖；必须是 upstream/main。"
    }
    if ($null -eq $trackingRemote) {
        Invoke-GitChecked -Arguments @("config", "--local", "branch.upstream-main.remote", "upstream") | Out-Null
    }
    if ($null -eq $trackingMerge) {
        Invoke-GitChecked -Arguments @("config", "--local", "branch.upstream-main.merge", "refs/heads/main") | Out-Null
    }

    if ($localSha -eq $remoteSha) {
        Write-Output "✓ upstream-main 已与 upstream/main 一致，无需更新。"
        exit 0
    }

    $localAncestor = Invoke-GitRaw -Arguments @("merge-base", "--is-ancestor", $localSha, $remoteSha)
    if ($localAncestor.ExitCode -eq 0) {
        Assert-UpstreamMainNotCheckedOut
        Invoke-GitChecked -Arguments @("update-ref", "--no-deref", "refs/heads/upstream-main", $remoteSha, $localSha) | Out-Null
        Write-Output "✓ 已将 upstream-main 快进到 upstream/main。"
        exit 0
    }
    if ($localAncestor.ExitCode -ne 1) {
        throw "检查 upstream-main 是否可快进失败（退出码 $($localAncestor.ExitCode)）：$($localAncestor.Output.Trim())"
    }

    $remoteAncestor = Invoke-GitRaw -Arguments @("merge-base", "--is-ancestor", $remoteSha, $localSha)
    if ($remoteAncestor.ExitCode -eq 0) {
        throw "upstream-main 含有本地独有提交（local-ahead），已停止，不覆盖本地引用。"
    }
    if ($remoteAncestor.ExitCode -ne 1) {
        throw "检查 upstream/main 是否为本地祖先失败（退出码 $($remoteAncestor.ExitCode)）：$($remoteAncestor.Output.Trim())"
    }
    throw "upstream-main 与 upstream/main 已分叉（diverged），已停止，不覆盖本地引用。"
}
catch {
    Write-Error "同步 upstream-main 失败：$($_.Exception.Message)"
    exit 1
}
