#!/bin/bash
set -e

REPO="https://raw.githubusercontent.com/Xsew074748/LineBot/master"
COMPOSE_URL="$REPO/docker-compose.linux.yml"

echo "======================================"
echo "  NetGuard AI — Installer"
echo "======================================"

# 1. ตรวจสอบ Docker
if ! command -v docker &> /dev/null; then
  echo "Docker ไม่พบ — ติดตั้ง Docker..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
  echo "✅ ติดตั้ง Docker สำเร็จ (อาจต้อง logout แล้ว login ใหม่)"
fi

if ! docker compose version &> /dev/null; then
  echo "❌ Docker Compose ไม่พบ กรุณาติดตั้ง Docker Desktop หรือ docker-compose-plugin"
  exit 1
fi

echo "✅ Docker พร้อมใช้งาน"

# 2. สร้างโฟลเดอร์
INSTALL_DIR="${1:-$HOME/netguard-ai}"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"
echo "📁 ติดตั้งที่: $INSTALL_DIR"

# 3. Download docker-compose.yml
echo "📥 ดาวน์โหลด docker-compose.yml..."
curl -fsSL "$COMPOSE_URL" -o docker-compose.yml

# 4. ถาม credentials
echo ""
echo "กรุณากรอกค่าต่อไปนี้ (กด Enter เพื่อข้ามถ้ายังไม่มี)"
echo "สามารถแก้ไขได้ภายหลังผ่านหน้า Setup UI"
echo "--------------------------------------"

read -p "LINE Channel Secret: " LINE_SECRET
read -p "LINE Channel Access Token: " LINE_TOKEN
read -p "Zabbix URL (เช่น http://192.168.1.10): " ZABBIX_URL
read -p "Zabbix API Token: " ZABBIX_TOKEN
read -p "Omada URL (เช่น https://192.168.1.10:8043): " OMADA_URL
read -p "Omada Client ID: " OMADA_CLIENT_ID
read -s -p "Omada Client Secret: " OMADA_CLIENT_SECRET; echo
read -p "Omada Omadac ID: " OMADA_OMADAC_ID
read -p "Omada Site ID: " OMADA_SITE_ID
read -p "HikCentral URL (เช่น https://192.168.1.10): " HIK_URL
read -p "HikCentral AppKey: " HIK_KEY
read -s -p "HikCentral AppSecret: " HIK_SECRET; echo
read -s -p "Anthropic API Key: " ANTHROPIC_KEY; echo
read -s -p "Cloudflare Tunnel Token: " CF_TOKEN; echo

# 5. สร้าง .env
cat > .env << ENVEOF
# LINE
LINE_CHANNEL_SECRET=${LINE_SECRET}
LINE_CHANNEL_ACCESS_TOKEN=${LINE_TOKEN}

# Zabbix
ZABBIX_URL=${ZABBIX_URL}
ZABBIX_API_TOKEN=${ZABBIX_TOKEN}

# Omada
OMADA_URL=${OMADA_URL}
OMADA_CLIENT_ID=${OMADA_CLIENT_ID}
OMADA_CLIENT_SECRET=${OMADA_CLIENT_SECRET}
OMADA_OMADAC_ID=${OMADA_OMADAC_ID}
OMADA_SITE_ID=${OMADA_SITE_ID}

# HikCentral
HIKCENTRAL_URL=${HIK_URL}
HIKCENTRAL_APP_KEY=${HIK_KEY}
HIKCENTRAL_APP_SECRET=${HIK_SECRET}

# Claude AI
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}

# Cloudflare
CLOUDFLARE_TUNNEL_TOKEN=${CF_TOKEN}
ENVEOF

chmod 600 .env
echo "✅ สร้าง .env สำเร็จ"

# 6. รัน Docker
echo ""
echo "🚀 เริ่มต้นระบบ..."
docker compose up -d

echo ""
echo "======================================"
echo "  ✅ ติดตั้งสำเร็จ!"
echo "======================================"
echo ""
echo "เปิด Setup UI ที่: http://localhost:3100/setup"
echo "หรือผ่าน Cloudflare Tunnel ที่คุณตั้งไว้"
echo ""
echo "คำสั่งที่ใช้บ่อย:"
echo "  docker compose ps          — ดูสถานะ"
echo "  docker compose logs -f     — ดู log"
echo "  docker compose down        — หยุดระบบ"
echo "  docker compose pull && docker compose up -d  — อัปเดต"
