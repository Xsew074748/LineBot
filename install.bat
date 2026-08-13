@echo off
setlocal

set "REPO=https://raw.githubusercontent.com/Xsew074748/LineBot/master"
set "COMPOSE_URL=%REPO%/docker-compose.linux.yml"

echo ======================================
echo   NetGuard AI - Installer
echo ======================================

REM 1. Check Docker
where docker >nul 2>nul
if errorlevel 1 (
  echo Docker not found - please install Docker Desktop first: https://www.docker.com/products/docker-desktop
  pause
  exit /b 1
)

docker compose version >nul 2>nul
if errorlevel 1 (
  echo Docker Compose not found - please update Docker Desktop to the latest version
  pause
  exit /b 1
)

echo Docker is ready

REM 2. Create install folder
set "INSTALL_DIR=%1"
if "%INSTALL_DIR%"=="" set "INSTALL_DIR=%USERPROFILE%\netguard-ai"
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
cd /d "%INSTALL_DIR%"
echo Installing to: %INSTALL_DIR%

:: 3. ตรวจหา container NetGuard ที่รันอยู่
set EXISTING=0
docker ps 2>nul | findstr /i "netguard line-bot it-monitor" >nul
if not errorlevel 1 set EXISTING=1

if "%EXISTING%"=="1" (
  echo.
  echo WARNING: Found existing NetGuard AI installation running
)
if "%EXISTING%"=="0" goto :no_existing

:: ถาม outside ของ if block
set /p ans=Update/restart it? ^(y/N^):
if /i "%ans%"=="y" goto :do_update
echo Cancelled. Existing installation unchanged.
exit /b 0

:do_update
echo Stopping existing containers...
docker compose down 2>nul
goto :no_existing

:no_existing

:: 4. ตรวจ port 3100
netstat -ano | findstr ":3100" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo ERROR: Port 3100 is still in use by another process
  echo Please free port 3100 first then run again
  pause
  exit /b 1
)

REM 5. Download docker-compose.yml
echo Downloading docker-compose.yml...
curl -fsSL "%COMPOSE_URL%" -o docker-compose.yml
if errorlevel 1 (
  echo Failed to download docker-compose.yml
  pause
  exit /b 1
)

REM 6. Create .env template (empty values)
if exist .env (
  echo Found existing .env - skipping template creation ^(not overwritten^)
) else (
  (
    echo # ---- LINE ----------------------------------------
    echo LINE_CHANNEL_SECRET=
    echo LINE_CHANNEL_ACCESS_TOKEN=
    echo.
    echo # ---- Zabbix ---------------------------------------
    echo ZABBIX_URL=
    echo ZABBIX_API_TOKEN=
    echo.
    echo # ---- Omada ^(Open API^) ------------------------------
    echo OMADA_URL=
    echo OMADA_CLIENT_ID=
    echo OMADA_CLIENT_SECRET=
    echo OMADA_OMADAC_ID=
    echo OMADA_SITE_ID=
    echo.
    echo # ---- HikCentral ^(AK/SK^) -----------------------------
    echo HIKCENTRAL_URL=
    echo HIKCENTRAL_APP_KEY=
    echo HIKCENTRAL_APP_SECRET=
    echo.
    echo # ---- Claude AI --------------------------------------
    echo ANTHROPIC_API_KEY=
    echo.
    echo # ---- Cloudflare Tunnel -------------------------------
    echo CLOUDFLARE_TUNNEL_TOKEN=
  ) > .env
  echo .env template created
)

echo.
echo Fill in .env first, then run docker compose up -d
echo Or fill via Setup UI at http://localhost:3100/setup
echo.

REM 7. Ask whether to run now
set /p "RUN_NOW=Run docker compose up -d now? (y/N): "

if /i "%RUN_NOW%"=="y" (
  echo.
  echo Starting services...
  docker compose up -d

  echo.
  echo ======================================
  echo   Install complete!
  echo ======================================
  echo.
  echo Open Setup UI at: http://localhost:3100/setup
  echo.
  echo Common commands:
  echo   docker compose ps          - show status
  echo   docker compose logs -f     - view logs
  echo   docker compose down        - stop services
  echo   docker compose pull ^&^& docker compose up -d  - update

  start http://localhost:3100/setup
) else (
  echo.
  echo Services not started yet. Fill in %INSTALL_DIR%\.env first, then run:
  echo.
  echo   cd /d "%INSTALL_DIR%"
  echo   docker compose up -d
)

pause
