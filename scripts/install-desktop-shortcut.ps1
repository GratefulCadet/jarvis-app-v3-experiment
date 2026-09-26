# JARVIS 바탕화면 바로가기 + 전역 단축키(Ctrl+Alt+J) 설치
# 실행: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-desktop-shortcut.ps1
$ErrorActionPreference = 'Stop'

$desktop  = [Environment]::GetFolderPath('Desktop')
$appDir   = Join-Path $env:USERPROFILE 'Documents\JARVIS\jarvis-app-v3-harness'
$launcher = Join-Path $appDir 'scripts\jarvis-launcher.cmd'
$electron = Join-Path $appDir 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path $launcher)) { throw "launcher 없음: $launcher" }
if (-not (Test-Path $electron)) { throw "electron.exe 없음: $electron" }

$ws  = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $desktop 'JARVIS.lnk'))
$lnk.TargetPath      = $launcher
$lnk.WorkingDirectory = $appDir
$lnk.Description     = 'JARVIS Assistant (Ctrl+Alt+J)'
$lnk.Hotkey          = 'Ctrl+Alt+J'
$lnk.WindowStyle     = 7   # 최소화로 실행 — 콘솔 깜빡임 최소화
$lnk.IconLocation    = "$electron,0"
$lnk.Save()

Write-Output "생성됨: $(Join-Path $desktop 'JARVIS.lnk')"
Write-Output "단축키: Ctrl+Alt+J (Desktop/시작메뉴에 있을 때만 작동)"
