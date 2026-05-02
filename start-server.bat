@echo off
cd /d "%~dp0"
echo.
echo ================================================
echo  Kotonoha - Local Dev Server
echo ================================================
echo.

REM Python (python)
where python >nul 2>nul
if %errorlevel%==0 (
    echo [Python] Starting http.server on port 8000...
    echo  Open http://localhost:8000  ^(Ctrl+C to stop^)
    echo.
    start "" "http://localhost:8000"
    python -m http.server 8000
    exit /b 0
)

REM Python (py launcher)
where py >nul 2>nul
if %errorlevel%==0 (
    echo [Python via py] Starting http.server on port 8000...
    echo  Open http://localhost:8000  ^(Ctrl+C to stop^)
    echo.
    start "" "http://localhost:8000"
    py -m http.server 8000
    exit /b 0
)

REM Node.js (npx serve)
where npx >nul 2>nul
if %errorlevel%==0 (
    echo [Node.js] Starting npx serve on port 8000...
    echo  Open http://localhost:8000  ^(Ctrl+C to stop^)
    echo.
    start "" "http://localhost:8000"
    npx --yes serve -l 8000
    exit /b 0
)

echo.
echo ERROR: Python nor Node.js was found.
echo.
echo Please install one of:
echo   - Python:  https://www.python.org/downloads/
echo   - Node.js: https://nodejs.org/
echo.
pause
exit /b 1
