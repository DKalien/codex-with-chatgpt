[CmdletBinding()]
param(
    [switch]$Test,
    [string]$SkillDirectory = (Join-Path ([Environment]::GetFolderPath("UserProfile")) ".codex\skills\codex-with-chatgpt")
)

$ErrorActionPreference = "Stop"
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

function Invoke-Checked {
    param([Parameter(Mandatory)][string]$Description, [Parameter(Mandatory)][scriptblock]$Command)
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Description 失败（退出码 $LASTEXITCODE）。" }
}

# 与 src/config/paths.ts 一致：C2C_STATE_DIR 优先，否则 %LOCALAPPDATA%\codex-with-chatgpt
$stateDir = $env:C2C_STATE_DIR
if ([string]::IsNullOrWhiteSpace($stateDir)) {
    $stateDir = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "codex-with-chatgpt"
}
$stateDir = [IO.Path]::GetFullPath($stateDir)
$app = Join-Path $stateDir "app"
$staging = "$app.new"
$previous = "$app.old"
$launcher = Join-Path $stateDir "bin\c2c.mjs"

Push-Location $repo
try {
    Invoke-Checked "pnpm install" { pnpm install --frozen-lockfile }
    Invoke-Checked "pnpm run build" { pnpm run build }
    if ($Test) { Invoke-Checked "pnpm test" { pnpm test } }

    # 暂存目录：dist + package.json + 生产依赖，装好后再整体替换 app
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    Copy-Item (Join-Path $repo "dist") (Join-Path $staging "dist") -Recurse
    foreach ($f in "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml") {
        Copy-Item (Join-Path $repo $f) $staging
    }
    Push-Location $staging
    try { Invoke-Checked "安装生产依赖" { pnpm install --prod --frozen-lockfile } }
    finally { Pop-Location }

    if (Test-Path $previous) { Remove-Item $previous -Recurse -Force }
    try {
        if (Test-Path $app) { Move-Item $app $previous }
        Move-Item $staging $app
    }
    catch {
        if (-not (Test-Path $app) -and (Test-Path $previous)) { Move-Item $previous $app }
        throw "替换 $app 失败（Gateway 是否仍在运行？请先执行 c2c gateway stop）：$($_.Exception.Message)"
    }

    # 稳定 launcher：始终指向当前 app
    New-Item -ItemType Directory -Path (Split-Path $launcher) -Force | Out-Null
    $launcherSource = 'const { runCli } = await import(new URL("../app/dist/cli/index.js", import.meta.url).href); process.exitCode = await runCli(process.argv);' + "`n"
    [IO.File]::WriteAllText($launcher, $launcherSource, [Text.UTF8Encoding]::new($false))

    # Skill：替换唯一占位符
    $placeholder = "<C2C_LAUNCHER_PATH>"
    $skillText = [IO.File]::ReadAllText((Join-Path $repo "skill\SKILL.md"))
    if (([regex]::Matches($skillText, [regex]::Escape($placeholder))).Count -ne 1) {
        throw "源 Skill 中应有且仅有一个 $placeholder。"
    }
    New-Item -ItemType Directory -Path $SkillDirectory -Force | Out-Null
    $skillPath = Join-Path $SkillDirectory "SKILL.md"
    [IO.File]::WriteAllText($skillPath, $skillText.Replace($placeholder, $launcher), [Text.UTF8Encoding]::new($false))
}
finally {
    Pop-Location
}

Write-Output "已安装：$app"
Write-Output "launcher：$launcher"
Write-Output "Skill：$skillPath"
Write-Output ""
Write-Output "下一步："
Write-Output "  node `"$launcher`" gateway status"
Write-Output "  若 Gateway 正在运行，执行 gateway stop 再 gateway start 以加载新构建（确认没有正在执行的任务）。"
Write-Output "  首次使用见 README 的 Setup 一节。"
