$ErrorActionPreference = 'Stop'
$tools = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$root = [IO.Path]::GetFullPath((Split-Path -Parent $tools))
$repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $root))
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\quran-audio-corrector'
$appExe = Join-Path $installDir 'المصحح الصوتي.exe'

try {
    Set-Location -LiteralPath $root

    Write-Host '[1/4] Closing running app...' -ForegroundColor Cyan
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*المصحح*' -or $_.Path -like '*quran-audio-corrector*' } | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*المصحح الصوتي*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1

    $gitDirRoot = if (Test-Path (Join-Path $root '.git')) { $root } elseif (Test-Path (Join-Path $repoRoot '.git')) { $repoRoot } else { $null }
    if ($gitDirRoot) {
        Set-Location -LiteralPath $gitDirRoot
        $dirty = (& git status --porcelain 2>$null | Out-String).Trim()
        if ([string]::IsNullOrEmpty($dirty)) {
            Write-Host 'Checking for latest commits from GitHub...' -ForegroundColor Cyan
            $prevPref = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                & git pull --ff-only 2>&1 | ForEach-Object { Write-Host "$_" }
                $gitExit = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $prevPref
            }
            if ($gitExit -ne 0) { throw "Git pull failed (exit code $gitExit)." }
        }
        Set-Location -LiteralPath $root
    }

    Write-Host '[2/4] Cleaning previous build files and building...' -ForegroundColor Cyan
    if (Test-Path (Join-Path $root 'dist_electron')) { Remove-Item -LiteralPath (Join-Path $root 'dist_electron') -Recurse -Force }
    if (Test-Path (Join-Path $root 'dist')) { Remove-Item -LiteralPath (Join-Path $root 'dist') -Recurse -Force }

    & npm.cmd install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }

    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Application build failed.' }

    & node (Join-Path $root 'build-with-version.cjs') --win --publish never
    if ($LASTEXITCODE -ne 0) { throw 'Installer build failed.' }

    $installer = Get-ChildItem -LiteralPath (Join-Path $root 'dist_electron') -File -Filter '*Setup*.exe' |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $installer) { throw 'Installer was not found in dist_electron.' }

    Write-Host '[3/4] Removing old installed files and installing new build...' -ForegroundColor Cyan
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*المصحح*' -or $_.Path -like '*quran-audio-corrector*' } | Stop-Process -Force -ErrorAction SilentlyContinue
    if (Test-Path $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }

    $proc = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -PassThru -Wait
    if ($proc.ExitCode -ne 0) { throw "Installer exited with code $($proc.ExitCode)." }

    Write-Host '[4/4] Launching updated app and cleaning old installer files...' -ForegroundColor Cyan
    if (Test-Path $appExe) {
        Start-Process -FilePath $appExe
        Start-Sleep -Seconds 1
    }
    if (Test-Path (Join-Path $root 'dist_electron')) { Remove-Item -LiteralPath (Join-Path $root 'dist_electron') -Recurse -Force }

    Write-Host ''
    Write-Host 'Done! Updated, installed, launched, and cleaned up.' -ForegroundColor Green
    Write-Host 'Press any key to close...' -ForegroundColor DarkGray
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
} catch {
    Write-Host "`n$($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Press any key to close...' -ForegroundColor DarkGray
    try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Read-Host 'Press Enter to close' | Out-Null }
    exit 1
}
