@echo off
chcp 65001 > nul
title Kotonoha Launcher

echo.
echo ===============================================
echo   Kotonoha - Auto Launcher
echo ===============================================
echo.

set "APP_DIR=%USERPROFILE%\OneDrive\デスクトップ\kotonoha-app"
set "OLLAMA_PATH=%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
set "PORT=8000"
set "URL=http://localhost:%PORT%"

REM ===========================================
REM Step 1: Check if Ollama is running
REM ===========================================
echo [1/4] Checking Ollama status...
tasklist /FI "IMAGENAME eq ollama app.exe" 2>NUL | find /I /N "ollama app.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo       OK: Ollama is running
) else (
    echo       Starting Ollama...
    if exist "%OLLAMA_PATH%" (
        start "" "%OLLAMA_PATH%"
        timeout /t 3 /nobreak > nul
        echo       OK: Ollama started
    ) else (
        echo       Warning: Ollama not found, skipping
    )
)

REM ===========================================
REM Step 2: Move to app directory
REM ===========================================
echo [2/4] Moving to app directory...
if exist "%APP_DIR%" (
    cd /d "%APP_DIR%"
    echo       OK: %APP_DIR%
) else (
    echo       ERROR: App directory not found
    echo       Expected: %APP_DIR%
    pause
    exit /b 1
)

REM ===========================================
REM Step 3: Start local server in background
REM ===========================================
echo [3/4] Starting local server on port %PORT%...

REM Check if port is already in use
netstat -an | find "LISTENING" | find ":%PORT%" >nul
if "%ERRORLEVEL%"=="0" (
    echo       OK: Server already running on port %PORT%
) else (
    REM Try Python first
    where python >nul 2>nul
    if "%ERRORLEVEL%"=="0" (
        start "Kotonoha Server" /MIN cmd /c "python -m http.server %PORT%"
        echo       OK: Python server starting...
        timeout /t 2 /nobreak > nul
    ) else (
        REM Try Node.js npx serve
        where npx >nul 2>nul
        if "%ERRORLEVEL%"=="0" (
            start "Kotonoha Server" /MIN cmd /c "npx serve -p %PORT%"
            echo       OK: Node.js server starting...
            timeout /t 3 /nobreak > nul
        ) else (
            echo       ERROR: No web server found
            echo       Please install Python or Node.js
            pause
            exit /b 1
        )
    )
)

REM ===========================================
REM Step 4: Open browser
REM ===========================================
echo [4/4] Opening browser...
timeout /t 1 /nobreak > nul
start "" "%URL%"
echo       OK: Browser opening %URL%

echo.
echo ===============================================
echo   Kotonoha is ready!
echo ===============================================
echo.
echo   App URL: %URL%
echo   Server: Running in background
echo   Ollama: Running
echo.
echo   To stop the server, run: stop-kotonoha.bat
echo.

REM Auto-close after 5 seconds (optional)
timeout /t 5 > nul
exit
