# IT Monitor Bot

LINE Bot สำหรับ IT Monitor — แจ้งเตือน Alert จาก Zabbix, สถานะกล้อง CCTV (HikCentral),
สถานะ WiFi (TP-Link Omada) และวิเคราะห์ปัญหาด้วย Claude AI

---

## Deploy บน Linux (Ubuntu) ด้วย Docker

### 1. ติดตั้ง Docker + Docker Compose

```bash
# ติดตั้ง Docker Engine
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # ให้ user ปัจจุบันรัน docker ได้
newgrp docker                   # apply โดยไม่ต้อง logout

# ตรวจสอบ
docker --version
docker compose version
```

### 2. Clone โปรเจค

```bash
git clone https://github.com/Xsew074748/LineBot.git
cd LineBot
```

### 3. ตั้งค่า Environment

```bash
cp .env.example .env
nano .env   # หรือ vim .env
```

กรอกค่าที่จำเป็น (ดู comment ในไฟล์ `.env.example` ว่าแต่ละค่าเอามาจากไหน):

| ตัวแปร | จำเป็น | หมายเหตุ |
|--------|--------|----------|
| `LINE_CHANNEL_SECRET` | ✅ | LINE Developers Console |
| `LINE_CHANNEL_ACCESS_TOKEN` | ✅ | LINE Developers Console |
| `ZABBIX_URL` + `ZABBIX_API_TOKEN` | ✅ | ถ้าเปิดใช้ Zabbix |
| `ANTHROPIC_API_KEY` | ✅ | สำหรับ AI วิเคราะห์ |
| `CLOUDFLARE_TUNNEL_TOKEN` | ✅ | สำหรับ public webhook URL |
| `OMADA_*` | ⬜ | ถ้าเปิดใช้ Omada WiFi |
| `HIKCENTRAL_*` | ⬜ | ถ้าเปิดใช้กล้อง CCTV |

> **Setup UI:** หลัง deploy แล้วเข้า `http://<server-ip>:3000/setup`
> เพื่อตั้งค่าผ่าน UI แทนการแก้ไฟล์ (LAN only)

### 4. ตั้งค่า Cloudflare Tunnel

1. ไปที่ [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com)
2. **Access > Tunnels > Create a tunnel**
3. ตั้งชื่อ (เช่น `linebot`) > เลือก **Docker**
4. Copy token จาก command ที่แสดง ใส่ใน `.env`:
   ```
   CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoixxxxxx...
   ```
5. ตั้ง **Public Hostname**: `bot.yourdomain.com` → `http://bot:3000`
6. อัปเดต LINE Webhook URL ใน LINE Developers Console เป็น:
   `https://bot.yourdomain.com/webhook`

### 5. รัน Bot

```bash
docker compose up -d
```

### 6. ตรวจสอบสถานะ

```bash
# ดูว่า container รันอยู่ไหม
docker ps

# ดู log แบบ real-time
docker compose logs -f bot

# เช็ค health endpoint
curl http://localhost:3000/health
```

ตัวอย่าง output ปกติ:
```json
{"status":"ok","service":"IT Monitor Bot","monitorsLoaded":["zabbix","omada","hikcentral"]}
```

### 7. อัปเดตโค้ด

```bash
git pull
docker compose up -d --build   # build image ใหม่แล้ว restart
```

---

## Deploy บน Windows (PM2) — วิธีเดิม

ระบบยังรองรับการรันบน Windows ด้วย PM2 + Cloudflare Tunnel เหมือนเดิม
Docker เป็นทางเลือกสำหรับ Linux server เท่านั้น

```bash
# ติดตั้ง dependencies
npm install

# รัน Bot
npm start                  # รันตรง
npx pm2 start index.js     # รันผ่าน PM2 (background)
```

---

## โครงสร้างโปรเจค

```
LineBot/
├── index.js              # Main server + LINE webhook handler
├── config.js             # ตั้งค่า Monitor, Roles, Rate limit
├── services/
│   ├── zabbix.js         # Zabbix JSON-RPC API
│   ├── omada.js          # TP-Link Omada Controller API
│   ├── hikcentral.js     # HikCentral CCTV API
│   ├── ai.js             # Claude AI (Anthropic)
│   ├── correlate.js      # Cross-system alert correlation
│   ├── formatter.js      # LINE Flex Message builder
│   ├── auth.js           # User roles & permissions
│   ├── logger.js         # Structured logging
│   └── validator.js      # Input validation
├── adapters/             # Normalized adapter layer (สำหรับ correlation)
├── routes/               # Setup UI API routes
├── middleware/           # Auth middleware
├── public/               # Setup UI HTML
├── mock-server/          # Mock API server สำหรับทดสอบ
├── tests/                # Jest unit tests
├── data/                 # Runtime data (gitignored)
├── logs/                 # Log files (gitignored)
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## คำสั่ง LINE Bot

| คำสั่ง | สิทธิ์ | ความหมาย |
|--------|--------|----------|
| `alert` | IT_STAFF+ | Alert จาก Zabbix |
| `host` | IT_STAFF+ | สถานะ Server/Host |
| `กล้อง` | IT_STAFF+ | สถานะกล้อง CCTV แยกอาคาร |
| `กล้องดับ` | IT_STAFF+ | เฉพาะกล้องที่ Offline |
| `wifi` | IT_STAFF+ | สถานะ Access Point |
| `cross` | IT_STAFF+ | Cross-system correlation |
| `ทั้งหมด` | VIEWER+ | สรุปทุก Monitor |
| `status` | VIEWER+ | สถานะการเชื่อมต่อ Monitor |
| `วิเคราะห์ [หัวข้อ]` | IT_STAFF+ | AI วิเคราะห์ละเอียด |
| `myid` | ทุกคน | ดู LINE User ID ของตัวเอง |
| `listuser` | ADMIN | รายชื่อผู้ใช้ |
| `pending` | ADMIN | รายชื่อรออนุมัติ |
