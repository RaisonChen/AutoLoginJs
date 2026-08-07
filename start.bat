@echo off
setlocal

rem =====================================================================
rem  One-click launcher for MonkeyCode keep-alive (Node.js version)
rem
rem  Usage:
rem    start.bat                     Run resident keep-alive (built-in default account)
rem    start.bat EMAIL PASSWORD      Run resident keep-alive with given account
rem    start.bat EMAIL PASSWORD --test   Run once (refresh + send) then exit
rem
rem  NOTE: keep this file ASCII-only to avoid codepage/mojibake issues.
rem =====================================================================

rem Switch to the script directory so index.js / session.json resolve correctly.
cd /d "%~dp0"

rem Check that Node is available.
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node 20+ and add it to PATH.
    echo         Download: https://nodejs.org/
    pause
    exit /b 1
)

rem Check that the main script exists.
if not exist "index.js" (
    echo [ERROR] index.js not found. Keep start.bat next to index.js.
    pause
    exit /b 1
)

echo ============================================================
echo   MonkeyCode keep-alive (Node.js)
echo   Dir: %cd%
echo   Press Ctrl+C to stop.
echo ============================================================
echo.

rem Force UTF-8 output codepage so Chinese log text shows correctly.
chcp 65001 >nul

rem Pass through all CLI args to index.js (no args = built-in default account).
node index.js %*

echo.
echo [INFO] Program exited (code %errorlevel%).
pause
endlocal
