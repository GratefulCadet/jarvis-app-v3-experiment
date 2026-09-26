@echo off
setlocal
set "APP_DIR=%USERPROFILE%\Documents\JARVIS\jarvis-app-v3-harness"

REM ============================================================
REM  JARVIS one-click launcher
REM  - dev server (Vite :5173) 가 꺼져 있으면 먼저 띄운다
REM  - 항상 Electron 앱을 연다
REM  - 바탕화면 JARVIS.lnk (Ctrl+Alt+J) 로 실행된다
REM ============================================================

REM 1) 서버 생존 확인 — 살아 있으면 그대로 재사용한다
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  start "jarvis-vite" /min cmd /c "cd /d %APP_DIR% && node node_modules\vite\bin\vite.js --host localhost --port 5173 --strictPort"
  powershell -NoProfile -Command "$deadline=(Get-Date).AddSeconds(30); while((Get-Date) -lt $deadline){ if(Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue){ exit 0 }; Start-Sleep -Milliseconds 300 }; exit 1"
)

REM 2) 앱 열기 — 이 콘솔은 즉시 닫힌다
start "" "%APP_DIR%\node_modules\electron\dist\electron.exe" "%APP_DIR%"
exit /b 0
