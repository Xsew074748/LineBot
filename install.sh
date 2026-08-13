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

# 3b. หา port ว่างเริ่มจาก 3100
PORT=3100
while lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1; do
  echo "Port $PORT is in use, trying $((PORT+1))..."
  PORT=$((PORT+1))
done
echo "Using port: $PORT"

# เขียน port ที่ได้ลง docker-compose.yml
sed -i "s/3100:3000/$PORT:3000/g" docker-compose.yml

# บันทึก port ไว้ใช้อ้างอิงครั้งต่อไป
echo "$PORT" > port.txt

# 4. สร้าง .env template (ค่าว่าง)
if [ -f .env ]; then
  echo "⚠️  พบ .env อยู่แล้ว — ข้ามการสร้างใหม่ (ไม่เขียนทับ)"
else
  cat > .env << 'ENVEOF'
# ── LINE ──────────────────────────────────────
LINE_CHANNEL_SECRET=
LINE_CHANNEL_ACCESS_TOKEN=

# ── Zabbix ────────────────────────────────────
ZABBIX_URL=
ZABBIX_API_TOKEN=

# ── Omada (Open API) ──────────────────────────
OMADA_URL=
OMADA_CLIENT_ID=
OMADA_CLIENT_SECRET=
OMADA_OMADAC_ID=
OMADA_SITE_ID=

# ── HikCentral (AK/SK) ────────────────────────
HIKCENTRAL_URL=
HIKCENTRAL_APP_KEY=
HIKCENTRAL_APP_SECRET=

# ── Claude AI ─────────────────────────────────
ANTHROPIC_API_KEY=

# ── Cloudflare Tunnel ─────────────────────────
CLOUDFLARE_TUNNEL_TOKEN=
ENVEOF
  chmod 600 .env
  echo "✅ สร้าง .env template สำเร็จ"
fi

echo ""
echo "📝 กรอกค่าใน .env ก่อน แล้วค่อยรัน docker compose up -d"
echo "   หรือกรอกผ่านหน้า Setup UI ที่ http://localhost:$PORT/setup"
echo ""

# 5. ถามว่าจะรันเลยไหม
read -p "รัน docker compose up -d เลยไหม? (y/N): " RUN_NOW

if [[ "$RUN_NOW" =~ ^[Yy]$ ]]; then
  echo ""
  echo "🚀 เริ่มต้นระบบ..."
  docker compose up -d

  echo ""
  echo "======================================"
  echo "  ✅ ติดตั้งสำเร็จ!"
  echo "======================================"
  echo ""
  echo "เปิด Setup UI ที่: http://localhost:$PORT/setup"
  echo "หรือผ่าน Cloudflare Tunnel ที่คุณตั้งไว้"
  echo ""
  echo "คำสั่งที่ใช้บ่อย:"
  echo "  docker compose ps          — ดูสถานะ"
  echo "  docker compose logs -f     — ดู log"
  echo "  docker compose down        — หยุดระบบ"
  echo "  docker compose pull && docker compose up -d  — อัปเดต"
else
  echo ""
  echo "ยังไม่ได้เริ่มระบบ — กรอกค่าใน $INSTALL_DIR/.env ให้ครบก่อน แล้วรัน:"
  echo ""
  echo "  cd $INSTALL_DIR"
  echo "  docker compose up -d"
fi
