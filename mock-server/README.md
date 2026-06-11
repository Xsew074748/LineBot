# Mock Server – IT Monitor Bot

จำลอง Omada Controller API และ HikCentral OpenAPI สำหรับทดสอบ Bot
โดยไม่ต้องต่ออุปกรณ์จริง

## ข้อมูลจำลองเริ่มต้น

| ระบบ | จำนวน | Online | Offline |
|------|--------|--------|---------|
| กล้อง CCTV | 500 ตัว | 480 | 20 |
| Access Point | 50 ตัว | 45 | 5 |

- กล้อง: **CAM-001 – CAM-500** กระจายใน อาคาร A–E ชั้น 1–5 (อาคารละ 100 ตัว, ชั้นละ 20 ตัว)
- AP: **AP-001 – AP-050** กระจายในอาคาร A–E ชั้น 1–5 (อาคารละ 10 ตัว, ชั้นละ 2 ตัว)

## วิธีรัน

```bash
# จาก root ของโปรเจกต์
node mock-server/index.js

# หรือกำหนด port เอง
MOCK_PORT=5000 node mock-server/index.js
```

Server รันที่ **http://localhost:4000** (ค่าเริ่มต้น)

## ตั้งค่า .env ให้ Bot ชี้มาที่ Mock Server

```env
OMADA_URL=http://localhost:4000
OMADA_USERNAME=admin
OMADA_PASSWORD=admin
OMADA_SITE_ID=default

HIKCENTRAL_URL=http://localhost:4000
HIKCENTRAL_CLIENT_ID=mock-client
HIKCENTRAL_CLIENT_SECRET=mock-secret
```

---

## Omada API Endpoints

### `POST /api/v2/hotspot/login`
Login และรับ token

```bash
curl -X POST http://localhost:4000/api/v2/hotspot/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}'
```

Response: `{ "errorCode": 0, "result": { "token": "MOCK-OMADA-TOKEN-..." } }`

---

### `GET /api/v2/:siteId/eaps`
รายการ Access Point ทั้งหมด

```bash
curl http://localhost:4000/api/v2/default/eaps \
  -H "Csrf-Token: MOCK-OMADA-TOKEN-xxx"
```

---

### `GET /api/v2/:siteId/clients`
จำนวน Client (wireless/wired)

```bash
curl http://localhost:4000/api/v2/default/clients \
  -H "Csrf-Token: MOCK-OMADA-TOKEN-xxx"
```

---

### `GET /api/v2/:siteId/events`
Alert จาก AP ที่ offline (`?pageSize=10`)

```bash
curl "http://localhost:4000/api/v2/default/events?pageSize=10" \
  -H "Csrf-Token: MOCK-OMADA-TOKEN-xxx"
```

---

## HikCentral API Endpoints

### `POST /api/v1/oauth/token`
OAuth2 client_credentials

```bash
curl -X POST http://localhost:4000/api/v1/oauth/token \
  -d "grant_type=client_credentials&client_id=mock-client&client_secret=mock-secret"
```

Response: `{ "access_token": "MOCK-HIK-TOKEN-...", "expires_in": 7200 }`

---

### `GET /api/v1/cameras`
กล้องทั้งหมด (รองรับ pagination และ filter ตามอาคาร)

```bash
# หน้าแรก 100 ตัว
curl "http://localhost:4000/api/v1/cameras?pageNo=1&pageSize=100" \
  -H "Authorization: Bearer MOCK-HIK-TOKEN-xxx"

# filter เฉพาะอาคาร A
curl "http://localhost:4000/api/v1/cameras?areaId=A" \
  -H "Authorization: Bearer MOCK-HIK-TOKEN-xxx"
```

---

### `GET /api/v1/cameras/:id/status`
สถานะกล้องตาม ID

```bash
curl http://localhost:4000/api/v1/cameras/CAM-001/status \
  -H "Authorization: Bearer MOCK-HIK-TOKEN-xxx"
```

---

### `GET /api/v1/events`
Event ล่าสุดจากกล้องที่ offline

```bash
curl "http://localhost:4000/api/v1/events?pageSize=20" \
  -H "Authorization: Bearer MOCK-HIK-TOKEN-xxx"
```

---

## Control Endpoints (จำลองสถานการณ์)

### `GET /mock/status`
ดูสถานะปัจจุบันทั้งหมด

```bash
curl http://localhost:4000/mock/status
```

---

### `POST /mock/camera/outage`
ทำให้กล้อง offline — ทดสอบ outage ใหญ่

```bash
# กล้องใน อาคาร A offline 50 ตัว
curl -X POST http://localhost:4000/mock/camera/outage \
  -H "Content-Type: application/json" \
  -d '{"building":"A","count":50}'

# กล้องออฟไลน์ 300 ตัวข้ามทุกอาคาร
curl -X POST http://localhost:4000/mock/camera/outage \
  -H "Content-Type: application/json" \
  -d '{"count":300}'

# ทำทุกตัวในอาคาร B ออฟไลน์ (ไม่ระบุ count)
curl -X POST http://localhost:4000/mock/camera/outage \
  -H "Content-Type: application/json" \
  -d '{"building":"B"}'
```

---

### `POST /mock/camera/reset`
คืนกล้องทุกตัวกลับ online

```bash
curl -X POST http://localhost:4000/mock/camera/reset
```

---

### `POST /mock/ap/outage`
ทำให้ AP offline

```bash
# AP offline 10 ตัว
curl -X POST http://localhost:4000/mock/ap/outage \
  -H "Content-Type: application/json" \
  -d '{"count":10}'

# AP ใน อาคาร C offline ทั้งหมด
curl -X POST http://localhost:4000/mock/ap/outage \
  -H "Content-Type: application/json" \
  -d '{"building":"C"}'
```

---

### `POST /mock/reset`
Reset ทุกอย่างกลับสู่สถานะเริ่มต้น

```bash
curl -X POST http://localhost:4000/mock/reset
```

---

## ตัวอย่าง Test Scenario

### Scenario 1: กล้องในอาคาร A ล้มทั้งหมด (100 ตัว)
```bash
curl -X POST http://localhost:4000/mock/camera/outage -H "Content-Type: application/json" -d '{"building":"A"}'
# → ทดสอบว่า Bot แจ้งเตือน "กล้องออฟไลน์ 100 ตัวในอาคาร A" ถูกต้อง
```

### Scenario 2: Network outage ใหญ่ กล้อง 400 ตัว offline
```bash
curl -X POST http://localhost:4000/mock/camera/outage -H "Content-Type: application/json" -d '{"count":400}'
# → ทดสอบ message truncation และ grouping ของ Bot
```

### Scenario 3: AP ล้มครึ่ง
```bash
curl -X POST http://localhost:4000/mock/ap/outage -H "Content-Type: application/json" -d '{"count":25}'
# → ทดสอบว่า Bot รายงาน AP offline และ client ที่หายไป
```

### Reset หลังทดสอบ
```bash
curl -X POST http://localhost:4000/mock/reset
```
