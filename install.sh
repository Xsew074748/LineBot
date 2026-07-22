#!/bin/bash
echo "=== NetGuard AI — Install ==="

# ตรวจ Docker
if ! command -v docker &> /dev/null; then
  echo "กรุณาติดตั้ง Docker ก่อน"
  exit 1
fi

# Download docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/Xsew074748/LineBot/master/docker-compose.yml -o docker-compose.yml

# สร้าง .env
echo "กรอก credentials:"
read -p "LINE_CHANNEL_ACCESS_TOKEN: " LINE_TOKEN
read -p "LINE_CHANNEL_SECRET: " LINE_SECRET
read -p "ZABBIX_URL: " ZABBIX_URL
read -p "ZABBIX_API_TOKEN: " ZABBIX_TOKEN
read -p "OMADA_URL: " OMADA_URL
read -p "OMADA_CLIENT_ID: " OMADA_ID
read -p "OMADA_CLIENT_SECRET: " OMADA_SECRET
read -p "OMADA_OMADAC_ID: " OMADA_CID
read -p "OMADA_SITE_ID: " OMADA_SITE
read -p "HIKCENTRAL_URL: " HIK_URL
read -p "HIKCENTRAL_APP_KEY: " HIK_KEY
read -p "HIKCENTRAL_APP_SECRET: " HIK_SECRET
read -p "ANTHROPIC_API_KEY: " ANTHROPIC_KEY

cat > .env << EOF
LINE_CHANNEL_ACCESS_TOKEN=${LINE_TOKEN}
LINE_CHANNEL_SECRET=${LINE_SECRET}
ZABBIX_URL=${ZABBIX_URL}
ZABBIX_API_TOKEN=${ZABBIX_TOKEN}
OMADA_URL=${OMADA_URL}
OMADA_CLIENT_ID=${OMADA_ID}
OMADA_CLIENT_SECRET=${OMADA_SECRET}
OMADA_OMADAC_ID=${OMADA_CID}
OMADA_SITE_ID=${OMADA_SITE}
HIKCENTRAL_URL=${HIK_URL}
HIKCENTRAL_APP_KEY=${HIK_KEY}
HIKCENTRAL_APP_SECRET=${HIK_SECRET}
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
EOF

echo "ติดตั้งเสร็จแล้ว รัน: docker compose up -d"
