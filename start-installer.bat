@echo off
title IT Monitor Bot

cd /d "%~dp0"

echo.
echo  =============================================
echo   IT Monitor Bot - Setup
echo  =============================================
echo.

where node > nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    echo  https://nodejs.org
    echo.
    pause
    exit /b 1
)

set PORT=3000
for /f "tokens=1,2 delims==" %%a in ('type .env 2^>nul ^| findstr /i "^PORT"') do set PORT=%%b

echo  Port: %PORT%
echo.

netstat -an 2>nul | find ":%PORT%" | find "LISTENING" > nul
if not errorlevel 1 (
    echo  Bot is already running on port %PORT%
    echo.
    start "" http://localhost:%PORT%/setup
    echo  Opened: http://localhost:%PORT%/setup
    echo  Settings: http://localhost:%PORT%/settings
    echo  Default password: admin
    echo.
    pause
    exit /b 0
)

if not exist logs mkdir logs

echo  Starting bot... browser will open in 3 seconds.
echo.
echo  Setup    : http://localhost:%PORT%/setup
echo  Settings : http://localhost:%PORT%/settings
echo  Password : admin
echo.

start /B cmd /c "timeout /t 3 /nobreak > nul & start http://localhost:%PORT%/setup"

node index.js

echo.
echo  [!] Bot stopped. See error above.
echo.
pause
