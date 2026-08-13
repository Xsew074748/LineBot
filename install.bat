@echo off
setlocal

set "REPO=https://raw.githubusercontent.com/Xsew074748/LineBot/master"
set "COMPOSE_URL=%REPO%/docker-compose.linux.yml"

echo ======================================
echo   NetGuard AI - Installer
echo ======================================

REM 1. ตรวจสอบ Docker
where docker >nul 2>nul
if errorlevel 1 (
  echo Docker ไม่พบ — กรุณาติดตั้ง Docker Desktop ก่อน: https://www.docker.com/products/docker-desktop
  pause
  exit /b 1
)

docker compose version >nul 2>nul
if errorlevel 1 (
  echo Docker Compose ไม่พบ — กรุณาอัปเดต Docker Desktop เป็นเวอร์ชันล่าสุด
  pause
  exit /b 1
)

echo Docker พร้อมใช้งาน

REM 2. สร้างโฟลเดอร์ติดตั้ง
set "INSTALL_DIR=%1"
if "%INSTALL_DIR%"=="" set "INSTALL_DIR=%USERPROFILE%\netguard-ai"
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
cd /d "%INSTALL_DIR%"
echo ติดตั้งที่: %INSTALL_DIR%

REM 3. ดาวน์โหลด docker-compose.yml
echo กำลังดาวน์โหลด docker-compose.yml...
curl -fsSL "%COMPOSE_URL%" -o docker-compose.yml
if errorlevel 1 (
  echo ดาวน์โหลด docker-compose.yml ไม่สำเร็จ
  pause
  exit /b 1
)

REM 4. ถาม credentials
echo.
echo กรุณากรอกค่าต่อไปนี้ ^(กด Enter เพื่อข้ามถ้ายังไม่มี^)
echo สามารถแก้ไขได้ภายหลังผ่านหน้า Setup UI
echo --------------------------------------

set /p LINE_SECRET="LINE Channel Secret: "
set /p LINE_TOKEN="LINE Channel Access Token: "
set /p ZABBIX_URL="Zabbix URL (เช่น http://192.168.1.10): "
set /p ZABBIX_TOKEN="Zabbix API Token: "
set /p OMADA_URL="Omada URL (เช่น https://192.168.1.10:8043): "
set /p OMADA_CLIENT_ID="Omada Client ID: "
set /p OMADA_CLIENT_SECRET="Omada Client Secret: "
set /p OMADA_OMADAC_ID="Omada Omadac ID: "
set /p OMADA_SITE_ID="Omada Site ID: "
set /p HIK_URL="HikCentral URL (เช่น https://192.168.1.10): "
set /p HIK_KEY="HikCentral AppKey: "
set /p HIK_SECRET="HikCentral AppSecret: "
set /p ANTHROPIC_KEY="Anthropic API Key: "
set /p CF_TOKEN="Cloudflare Tunnel Token: "

REM 5. สร้าง .env
(
  echo # LINE
  echo LINE_CHANNEL_SECRET=%LINE_SECRET%
  echo LINE_CHANNEL_ACCESS_TOKEN=%LINE_TOKEN%
  echo.
  echo # Zabbix
  echo ZABBIX_URL=%ZABBIX_URL%
  echo ZABBIX_API_TOKEN=%ZABBIX_TOKEN%
  echo.
  echo # Omada
  echo OMADA_URL=%OMADA_URL%
  echo OMADA_CLIENT_ID=%OMADA_CLIENT_ID%
  echo OMADA_CLIENT_SECRET=%OMADA_CLIENT_SECRET%
  echo OMADA_OMADAC_ID=%OMADA_OMADAC_ID%
  echo OMADA_SITE_ID=%OMADA_SITE_ID%
  echo.
  echo # HikCentral
  echo HIKCENTRAL_URL=%HIK_URL%
  echo HIKCENTRAL_APP_KEY=%HIK_KEY%
  echo HIKCENTRAL_APP_SECRET=%HIK_SECRET%
  echo.
  echo # Claude AI
  echo ANTHROPIC_API_KEY=%ANTHROPIC_KEY%
  echo.
  echo # Cloudflare
  echo CLOUDFLARE_TUNNEL_TOKEN=%CF_TOKEN%
) > .env

echo สร้าง .env สำเร็จ

REM 6. รัน Docker
echo.
echo กำลังเริ่มต้นระบบ...
docker compose up -d

echo.
echo ======================================
echo   ติดตั้งสำเร็จ!
echo ======================================
echo.
echo เปิด Setup UI ที่: http://localhost:3100/setup
echo.
echo คำสั่งที่ใช้บ่อย:
echo   docker compose ps          - ดูสถานะ
echo   docker compose logs -f     - ดู log
echo   docker compose down        - หยุดระบบ
echo   docker compose pull ^&^& docker compose up -d  - อัปเดต

start http://localhost:3100/setup

pause
