@echo off
chcp 65001 > nul
title Kotonoha Stopper

echo.
echo ===============================================
echo   Kotonoha - Stop Server
echo ===============================================
echo.

REM Kill the server window
echo Stopping local server...
taskkill /FI "WINDOWTITLE eq Kotonoha Server*" /F >nul 2>&1
if "%ERRORLEVEL%"=="0" (
    echo OK: Server stopped
) else (
    echo Server was not running
)

echo.
echo ===============================================
echo   Done. Ollama keeps running in background.
echo   To stop Ollama, right-click tray icon.
echo ===============================================
echo.

timeout /t 3 > nul
exit
