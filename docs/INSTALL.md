# คู่มือติดตั้ง NetGuard IT Monitor Bot

เอกสารนี้อธิบายการติดตั้งบอทบนเครื่องใหม่ในรูปแบบเดียวกับ production ปัจจุบัน คือ **container ของบอทที่ NetGuard Manager คุม** และเข้าถึงจากภายนอกผ่าน Cloudflare Tunnel เท่านั้น

> เอกสารนี้ใช้ placeholder ในรูป `<...>` ทั้งหมด ไม่มีค่าจริงของ IP, path, โดเมน, รหัสกล้อง หรือ token
> ห้ามวางค่าจริงลงในเอกสาร, commit หรือแชต

> โครงสร้างในหัวข้อ 3 สรุปจาก source code ของ Manager และเทียบกับ `docker inspect` ของ container production แล้ว
> (พอร์ต, restart policy, labels, healthcheck, mounts, network) ตรงกันทุกข้อ
> ถ้า Manager หรือ production เปลี่ยนภายหลัง ให้เทียบซ้ำตามหัวข้อ 3.3

---

## 1. ข้อกำหนดเครื่อง

| รายการ | ข้อกำหนด |
|---|---|
| OS | Linux หรือ Windows ที่ใช้ Docker Engine / Docker Desktop (Linux containers) |
| Docker | Docker Engine พร้อม Compose v2 (`docker compose version`) |
| Node.js | ไม่ต้องมีบนเครื่อง (image ใช้ `node:20-alpine`) ต้องมีเฉพาะตอนรันเทสต์หรือสคริปต์นอก container |
| พอร์ตของบอท | พอร์ตภายใน container คือ `3000` ส่วนพอร์ต host เลือกเอง (`<HOST_PORT>`, 1024-65535) และต้องไม่ซ้ำกับบอทอื่น |
| พอร์ตของ Manager | `8080` (bind ที่ loopback `127.0.0.1` เท่านั้น) |
| ขาออก | ถึง LINE Messaging API, AI provider ที่ใช้ (Anthropic เป็น fallback บังคับ) และ Cloudflare (ให้ cloudflared สร้าง tunnel) |
| ขาเข้า | ไม่ต้องเปิดพอร์ตขาเข้าสู่อินเทอร์เน็ต LINE webhook เข้าผ่าน tunnel |
| เวลา | image ตั้ง `TZ=Asia/Bangkok` แต่ log ของ container เป็นเวลา UTC (เวลาไทย = UTC+7) |

### เครือข่ายที่ container ของบอทต้องเข้าถึง

ต้องเรียกถึงระบบเหล่านี้ได้จากใน Docker network (ทดสอบจากใน container ได้ด้วย `wget` หรือ `curl`):

| ระบบ | ตัวแปรที่ชี้ | หมายเหตุ |
|---|---|---|
| Zabbix | `ZABBIX_URL` | HTTP(S) ไปยัง API (`api_jsonrpc.php`) |
| Omada Controller | `OMADA_URL` | HTTPS; ถ้า cert เป็น self-signed ให้ mount CA เข้า container แล้วตั้ง `OMADA_CA_CERT_PATH` เป็น path ภายใน container |
| HikCentral | `HIKCENTRAL_URL` | HTTPS (OpenAPI/artemis); ถ้า cert เป็น self-signed ใช้ `HIKCENTRAL_CA_CERT_PATH` ในลักษณะเดียวกัน |

ระบบเหล่านี้ส่วนใหญ่อยู่ใน LAN ภายใน ให้ติดตั้งบนเครื่องที่ route ไปถึงได้
Docker bridge network ออกไปยัง LAN ได้ตามปกติผ่าน NAT ของ host

---

## 2. Build image จากซอร์ส

`Dockerfile` ของรีโปนี้เป็น single-stage:

- base: `node:20-alpine` (เพิ่ม `tzdata`, ตั้ง `TZ=Asia/Bangkok`)
- `npm ci --omit=dev` (ต้องมี `package-lock.json`)
- COPY เฉพาะ `adapters/ middleware/ mock-server/ public/ routes/ scripts/ services/ config.js index.js`
- สร้างโฟลเดอร์ `data` และ `logs` ไว้รอ mount
- `EXPOSE 3000`
- `HEALTHCHECK` ทุก 30 วินาที (timeout 5 วินาที, start-period 10 วินาที, retries 3) ด้วย `wget -qO- http://localhost:3000/health`
- `CMD ["node", "index.js"]`

```bash
git clone <REPO_URL> linebot
cd linebot
git status                      # ต้องสะอาด และอยู่บน commit ที่ผ่านเทสต์แล้ว

docker build -t netguard-ai:local .
docker image inspect netguard-ai:local --format '{{.Id}}'    # จด ID ไว้เทียบทีหลัง
```

> ถ้าเพิ่มโฟลเดอร์ใหม่ที่โค้ดต้องใช้ ต้องเพิ่มบรรทัด `COPY` ใน `Dockerfile` ด้วย
> เคยลืม `scripts/` มาแล้วครั้งหนึ่งจนฟีเจอร์ไม่ทำงานใน container

---

## 3. รัน container ให้เทียบเท่า production

Manager เป็นผู้สร้าง container ของบอทผ่าน Docker API (ดู `createBot` ใน `services/docker.js` ของ NetguardManager)
รูปแบบที่ได้เป็นดังนี้ ค่าที่ไม่ได้ระบุคือค่าเริ่มต้นของ Docker

### 3.1 โครงสร้างที่ต้องตรงกับ production

| หัวข้อ | ค่า |
|---|---|
| ชื่อ container | `netguard-<BOT_NAME>` |
| image | image ที่ build เอง (หัวข้อ 2) |
| network | network ภายนอกชื่อ `netguard-net` (ต้องมีก่อน ดูหัวข้อ 5) |
| พอร์ต | host `<HOST_PORT>` → container `3000/tcp` |
| restart policy | `always` |
| labels | `netguard.managed=true`, `netguard.botname=<BOT_NAME>` |
| mounts (bind) | `<BOT_DIR>/.env` → `/app/.env`, `<BOT_DIR>/data` → `/app/data`, `<BOT_DIR>/logs` → `/app/logs` |
| healthcheck | สืบทอดจาก image (`wget -qO- http://localhost:3000/health`, 30 วินาที / 5 วินาที / 3 ครั้ง) Manager ไม่กำหนดเพิ่ม |
| ตัวแปรแวดล้อม | ไม่ส่งผ่าน `-e` บอทอ่านจากไฟล์ `.env` ที่ mount เข้า `/app/.env` (ดูหัวข้อ 4) |

`<BOT_DIR>` คือโฟลเดอร์ของบอทบน host ซึ่งมี `.env`, `data/` และ `logs/` อยู่ข้างใน
ใช้ path แบบ absolute ที่ Docker daemon มองเห็น

### 3.2 คำสั่ง `docker run`

```bash
docker run -d \
  --name netguard-<BOT_NAME> \
  --restart always \
  --network netguard-net \
  --label netguard.managed=true \
  --label netguard.botname=<BOT_NAME> \
  -p <HOST_PORT>:3000 \
  -v <BOT_DIR>/.env:/app/.env \
  -v <BOT_DIR>/data:/app/data \
  -v <BOT_DIR>/logs:/app/logs \
  netguard-ai:local
```

เมื่อสร้างด้วยมือ ต้องให้ Manager มองเห็นบอท ซึ่งต้องมี label `netguard.managed=true` ครบ
ส่วน tunnel ของ production ไม่ได้เป็น container แยกต่อบอทตามรูปแบบของ Manager ดูหัวข้อ 5

### 3.3 เทียบกับ production ก่อนใช้จริง

เมื่อ Docker รันอยู่ ให้รันคำสั่งอ่านอย่างเดียวนี้ แล้วเทียบผลกับตารางหัวข้อ 3.1
(ห้ามใช้ `docker inspect` เต็มรูป เพราะส่วน `Config.Env` อาจแสดงค่าลับ ให้เลือกเฉพาะ field):

```bash
docker inspect netguard-itmonitor --format '{{json .HostConfig.PortBindings}}'
docker inspect netguard-itmonitor --format '{{json .HostConfig.RestartPolicy}}'
docker inspect netguard-itmonitor --format '{{json .Config.Labels}}'
docker inspect netguard-itmonitor --format '{{json .Config.Healthcheck}}'
docker inspect netguard-itmonitor --format '{{range .Mounts}}{{.Type}} {{.Destination}} rw={{.RW}}{{"\n"}}{{end}}'
docker inspect netguard-itmonitor --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}'
```

### 3.4 ทางเลือก: docker compose

> ⚠️ **ตัวอย่างนี้ยังไม่ได้ทดสอบ และไม่ใช่ไฟล์ของ production** — production สร้างโดย Manager (หัวข้อ 3.2) ตัวอย่างนี้เขียนให้เทียบเท่ากับ 3.2 จากโครงสร้างที่ตรวจแล้วเท่านั้น ทดลองบนเครื่องทดสอบ/พอร์ตอื่นก่อนใช้จริง และอย่ารันคู่กับบอทตัวเดิมบน LINE channel เดียวกัน

ใช้เมื่อไม่ต้องการให้ Manager เป็นผู้สร้างบอท (ไม่มี Manager คุม) ตัวอย่างนี้เทียบเท่าหัวข้อ 3.2:

```yaml
services:
  bot:
    image: netguard-ai:local
    container_name: netguard-<BOT_NAME>
    restart: always
    ports:
      - "<HOST_PORT>:3000"
    volumes:
      - <BOT_DIR>/.env:/app/.env
      - <BOT_DIR>/data:/app/data
      - <BOT_DIR>/logs:/app/logs
    labels:
      netguard.managed: "true"
      netguard.botname: "<BOT_NAME>"
    networks:
      - netguard-net

networks:
  netguard-net:
    external: true
```

---

## 4. ไฟล์ `.env`

เริ่มจาก `.env.example` ในรีโป คัดลอกเป็น `<BOT_DIR>/.env` แล้วกรอกค่าเอง
(ตัวอย่างค่าใน `.env.example` เป็นแค่ตัวอย่างรูปแบบ อย่านำไปใช้จริง)

- บอทอ่านค่าจากไฟล์ที่ **mount เข้า container** ไม่ใช่ `.env` ในโฟลเดอร์ซอร์ส
- `.env` ถูก mount เป็น **ไฟล์เดี่ยว** ถ้าแก้ด้วยวิธี "เขียนไฟล์ชั่วคราวแล้ว rename" container จะยังเห็นไฟล์เก่า จนกว่าจะ `docker restart`
- สำรองไฟล์ก่อนแก้ทุกครั้ง และอย่าพิมพ์ค่าลับออกจอหรือลงแชต

### 4.1 คีย์ที่จำเป็น

| คีย์ | ใช้ทำอะไร |
|---|---|
| `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` | เชื่อม LINE Messaging API (ตรวจลายเซ็น webhook และส่งข้อความ) |
| `ANTHROPIC_API_KEY` | AI provider หลัก และเป็น fallback บังคับของ provider อื่นทุกตัว |
| `ZABBIX_WEBHOOK_SECRET` | ยืนยัน webhook จาก Zabbix (ต้องตั้ง header `x-zabbix-secret` ฝั่ง Zabbix ให้ตรงกัน) |

### 4.2 คีย์ของแต่ละระบบที่เฝ้า (ไม่ครบ = ระบบนั้นถูกข้าม)

บอทเปิดแต่ละระบบเมื่อมีคีย์ครบเท่านั้น ถ้าขาดจะแจ้ง `ขาด env vars ... — ข้ามไป` ใน log แล้วไม่โหลด monitor นั้น ต้องมีอย่างน้อยหนึ่งระบบ

| กลุ่ม | คีย์ที่บังคับเมื่อจะใช้ระบบนั้น | คีย์เสริม |
|---|---|---|
| Zabbix | `ZABBIX_URL`, `ZABBIX_API_TOKEN` | - |
| Omada | `OMADA_URL`, `OMADA_OMADAC_ID`, `OMADA_SITE_ID`, `OMADA_CLIENT_ID`, `OMADA_CLIENT_SECRET` | `OMADA_CA_CERT_PATH`, `OMADA_TLS_SKIP_HOSTNAME`, `OMADA_USERNAME` / `OMADA_PASSWORD` (legacy เก็บไว้เผื่อ rollback) |
| HikCentral | `HIKCENTRAL_URL`, `HIKCENTRAL_APP_KEY`, `HIKCENTRAL_APP_SECRET` | `HIKCENTRAL_CA_CERT_PATH`, `HIKCENTRAL_TLS_SKIP_HOSTNAME`, `HIKCENTRAL_EVENT_TYPES`, `HIKCENTRAL_BREAKER_THRESHOLD`, `HIKCENTRAL_BREAKER_COOLDOWN_MS`, `HIKCENTRAL_TIMEOUT_MS` |

### 4.3 คีย์ไม่จำเป็น (ปิดหรือใช้ค่าเริ่มต้นถ้าไม่ตั้ง)

| กลุ่ม | คีย์ | ใช้ทำอะไร |
|---|---|---|
| Server | `PORT` | พอร์ตภายใน container ค่าเริ่มต้น `3000` (`config.js`) — Dockerfile (`EXPOSE` และ HEALTHCHECK) และตัวอย่างในเอกสารนี้ใช้ 3000 จึงไม่ควรเปลี่ยนถ้าไม่จำเป็น |
| ค่าปรับแต่ง | `ZABBIX_TIMEOUT_MS`, `AI_TIMEOUT_MS`, `AI_RETRY_BASE_MS`, `GEMINI_MODEL` | timeout คำขอ Zabbix (ค่าเริ่มต้น 15000 ms), timeout ต่อ 1 ครั้งของ AI (45000 ms), backoff เริ่มต้นเมื่อ AI ตอบ 503/429 (2000 ms เป็นสองเท่าต่อครั้ง), ชื่อรุ่น Gemini (`gemini-3.8-flash`) |
| สรุปประจำวัน | `DAILY_SUMMARY_ENABLED` | ตั้งเป็น `false` เพื่อปิดสรุป 08:00/17:00 (ไม่ตั้ง = เปิด) |
| AI provider อื่น | `AI_PROVIDER`, `GEMINI_API_KEY`, `OPENAI_API_KEY` | เลือก claude / gemini / openai (ไม่มี key ของเจ้านั้น = fallback ไป claude) |
| AI quota | `AI_DAILY_QUOTA` | จำนวนครั้งที่ผู้ใช้แต่ละคนใช้ AI ได้ต่อวัน (ค่าเริ่มต้น 20) |
| ความปลอดภัย Setup UI | `ALLOWED_IP_PREFIX`, `SETUP_PASSWORD_HASH` | จำกัด IP ที่เข้า Setup UI และรหัสผ่านของมัน |
| แจ้งเตือนอุณหภูมิ (HikCentral) | `HIKCENTRAL_TEMP_ALARM_ENABLED`, `_DRYRUN`, `_TYPES`, `_CAMERAS`, `_INTERVAL_SEC`, `_LOOKBACK_MIN`, `_COOLDOWN_MIN`, `_SEVERITY` | ปิดเป็นค่าเริ่มต้น และเมื่อเปิดจะเริ่มที่ DRYRUN (log อย่างเดียว) ต้องตั้ง `_CAMERAS` ด้วยจึงจะทำงาน |
| แจ้งเตือน Omada traffic | `OMADA_TRAFFIC_ALERT_DOWN_MBPS`, `_UP_MBPS`, `_SUSTAIN`, `_COOLDOWN_MIN`, `_INTERVAL_MIN`, `_SEVERITY`, `_DRYRUN` | ไม่ตั้ง DOWN/UP = ไม่ทำงาน; DRYRUN เริ่มต้นเป็น true |
| แจ้ง ADMIN เมื่อบอทล้ม | `OPS_CRASH_NOTIFY`, `OPS_CRASH_NOTIFY_COOLDOWN_MIN` | ค่าเริ่มต้น log อย่างเดียว ไม่ส่ง LINE |
| `/health/deep` | `HEALTH_DEEP_TOKEN`, `HEALTH_DEEP_LINE_FAIL_THRESHOLD`, `HEALTH_DEEP_LINE_FAIL_WINDOW_MIN` | ไม่ตั้ง token = endpoint ตอบ 404 (ปิด) |
| Cloudflare | `CLOUDFLARE_TUNNEL_TOKEN` | ใช้เมื่อ tunnel เป็นแบบ token |

> หลักปฏิบัติของฟีเจอร์ที่ส่ง LINE จริง: เปิดด้วย `ENABLED=true` และ `DRYRUN=true` ก่อน เทียบผลใน log
> แล้วค่อยปิด DRYRUN หลังตรวจแล้ว
>
> สร้างค่าลับแบบสุ่มด้วยคำสั่งที่ไม่พิมพ์ค่าออกจอ เช่น `node -e "..."` แล้วเขียนลงไฟล์โดยตรง

---

## 5. ติดตั้ง Manager และ cloudflared (สรุป)

### 5.1 NetGuard Manager

ใช้ `docker-compose.yml` ของรีโป NetguardManager สรุปโครงสร้าง:

- build จาก `Dockerfile` ของ Manager (`node:22-alpine` + toolchain สำหรับ `better-sqlite3`)
- container ชื่อ `netguard-manager`, `restart: always`
- พอร์ต `127.0.0.1:8080:8080` (bind loopback เท่านั้น ห้ามเปลี่ยนเป็น bind IP อื่นตรงๆ)
- mount `/var/run/docker.sock` (เพื่อให้ Manager สร้าง/คุม container), `${BOTS_HOST_PATH}:/bots`, และ named volume `manager-data` → `/app/data` (เก็บ `stats.db`)
- สร้าง network ชื่อ `netguard-net` (driver bridge) ซึ่งบอทและ cloudflared ต้องเข้าร่วม
- `.env` ของ Manager มีคีย์: `PORT`, `MANAGER_PASSWORD_HASH`, `NODE_ENV`, `BOTS_HOST_PATH`, `BOT_NETWORK`

```bash
cd <MANAGER_REPO>
cp .env.example .env          # กรอก BOTS_HOST_PATH = <BOTS_ROOT> บน host, BOT_NETWORK=netguard-net
docker compose up -d --build
```

ติดตั้ง Manager ก่อน เพื่อให้ network `netguard-net` ถูกสร้างขึ้นก่อนสร้างบอท
`<BOTS_ROOT>` คือโฟลเดอร์แม่ที่เก็บโฟลเดอร์ของแต่ละบอท (`<BOTS_ROOT>/<BOT_NAME>/{.env,data,logs}`)

### 5.2 cloudflared

- image `cloudflare/cloudflared:latest`, `restart: always`
- ต้องอยู่ใน `netguard-net` เพื่อเรียกบอทด้วยชื่อ container (`http://netguard-<BOT_NAME>:3000`) ไม่ต้องใช้พอร์ต host
- มี 2 แบบ:
  1. **token mode ผ่าน Dashboard**: `tunnel --no-autoupdate run --token <TUNNEL_TOKEN>` และตั้ง public hostname ที่ Dashboard ชี้ไป `http://netguard-<BOT_NAME>:3000`
  2. **locally-managed (config.yml)**: mount โฟลเดอร์ `<CLOUDFLARED_DIR>` แบบอ่านอย่างเดียวเข้า `/etc/cloudflared` แล้วรัน `tunnel --no-autoupdate --config /etc/cloudflared/config.yml run ...` โดย `ingress` ใน `config.yml` ชี้ `<TUNNEL_HOSTNAME>` → `http://netguard-<BOT_NAME>:3000`
- ที่ตั้ง LINE Webhook URL ใน LINE Developers Console เป็น `https://<TUNNEL_HOSTNAME>/webhook` (route `POST /webhook` ใน `index.js`)
- **ห้ามรัน cloudflared ของ tunnel เดียวกันสองตัวพร้อมกัน** (เช่น ตัวเดิมที่เป็น service บน host กับ container ใหม่)

---

## 6. ตรวจหลังติดตั้ง

### 6.1 สถานะ container

```bash
docker ps --filter name=netguard-<BOT_NAME> --format '{{.Names}}  {{.Status}}'   # ต้องเป็น (healthy)
docker inspect netguard-<BOT_NAME> --format 'RestartCount={{.RestartCount}}'      # ควรเป็น 0
```

### 6.2 Endpoint

| Endpoint | การเข้าถึง | ผลที่ถูกต้อง |
|---|---|---|
| `GET /health` | ไม่ต้อง auth | `{"status":"ok","service":...,"monitorsLoaded":[...]}` และ `monitorsLoaded` ตรงกับระบบที่ตั้งค่าไว้ |
| `GET /health/deep` | header `x-health-token` เท่านั้น | `200` = ปกติ, `503` = ส่ง LINE ล้มติดกัน/checker มีปัญหา, `404` = ยังไม่เปิด (ไม่ได้ตั้ง `HEALTH_DEEP_TOKEN`), `401` = token ไม่ตรง |
| `GET /stats` | ไม่ต้อง auth | JSON จำนวนอุปกรณ์รวม ต้องไม่มี `partial: true` และ `breakers` ของ HikCentral เป็น `closed` |
| `GET /stats/detail` | เฉพาะ LAN/Docker network | ใช้โดย Manager เรียกจากภายใน; เรียกผ่านโดเมน tunnel จะได้ `403` (ตั้งใจ) |

```bash
curl -s http://localhost:<HOST_PORT>/health
curl -s http://localhost:<HOST_PORT>/stats

# ทดสอบ /health/deep โดยไม่แสดง token บนจอ
read -rs T && curl -s -o /dev/null -w "%{http_code}\n" -H "x-health-token: $T" https://<TUNNEL_HOSTNAME>/health/deep; unset T
```

ตรวจเพิ่ม: ผ่าน tunnel ต้องได้ `/health` เหมือนกัน (`curl -s https://<TUNNEL_HOSTNAME>/health`)

### 6.3 Log

```bash
docker logs --tail 100 netguard-<BOT_NAME>
```

ที่ควรเห็น: `Monitors loaded` ตรงกับระบบที่ตั้งไว้, ไม่มีข้อความ `ขาด env vars`, ไม่มี error ต่อเนื่อง,
ฟีเจอร์แจ้งเตือนที่เปิดอยู่ขึ้นสถานะ DRYRUN ตามที่ตั้ง
เวลาใน log เป็น UTC

### 6.4 Rollback

ก่อน deploy ทุกครั้ง:

```bash
docker tag netguard-ai:local netguard-ai:prev-<LABEL>-<DATE>     # เก็บไว้ ห้าม push
cp <BOT_DIR>/.env <BOT_DIR>/.env.bak-<TIMESTAMP>
cmp <BOT_DIR>/.env <BOT_DIR>/.env.bak-<TIMESTAMP>               # ต้องเหมือนกัน
```

ย้อนกลับ:

1. **ย้อน config**: คืน `.env` จากไฟล์สำรอง (หรือตั้ง `*_DRYRUN=true`) แล้ว `docker restart netguard-<BOT_NAME>`
2. **ย้อน image**: ติด tag สำรองกลับเป็น tag ที่ใช้อยู่ (`docker tag netguard-ai:prev-<LABEL>-<DATE> netguard-ai:local`)
   แล้ว recreate container ด้วยพารามิเตอร์เดิมตามหัวข้อ 3 (ชื่อ/พอร์ต/label/network/mount เท่าเดิม)
3. หลังย้อน ตรวจตามหัวข้อ 6.1-6.3 ซ้ำ

---

## 7. ข้อควรระวัง

1. **ห้ามรันบอทสองเครื่อง/สอง container พร้อมกันบน LINE channel เดียวกัน**
   webhook และสรุปประจำวัน (daily summary) จะซ้ำ ถ้าจะสลับไปใช้อีกตัว ให้ `docker stop` ตัวเดิมก่อนเสมอ
   และอย่าให้ tunnel ตัวเดียวกันรันสองตัว
2. **ห้ามกดปุ่ม "อัปเดต Image" ใน Manager**
   ปุ่มนี้ `pull` image `:latest` จาก Docker Hub โดยไม่ส่ง registry auth
   ถ้า image รุ่นใหม่ยังไม่ได้ push จะดึงรุ่นเก่าทับ tag ในเครื่อง และ recreate ครั้งถัดไปจะกลับไปใช้รุ่นเก่า
   ให้ build / tag / recreate เองตามหัวข้อ 2-3 แล้วตรวจ `docker images` ก่อนและหลังเสมอ
3. **ห้ามใช้ image จาก Docker Hub จนกว่าจะมีการ push release ที่มี `/health/deep` (และ crash guard) ขึ้นไปแล้ว**
   image ที่ค้างอยู่บน Hub เป็นรุ่นก่อนหน้า release นั้น ให้ build จากซอร์สในเครื่องแทน
   เมื่อ push แล้ว ตรวจรุ่นที่จะ pull ก่อนใช้: `docker run --rm --entrypoint grep <IMAGE> -c "health/deep" /app/index.js` ต้องได้ตัวเลขมากกว่า 0 (ถ้าเป็น 0 = ยังเป็นรุ่นเก่า อย่าใช้)
4. "บันทึกและ Restart" ใน Manager restart บอทจริงทันที ใช้ด้วยความระมัดระวัง
5. หลีกเลี่ยง restart/recreate ช่วงที่บอทส่งสรุปประจำวัน (08:00 และ 17:00 เวลาไทย ±10 นาที)
6. ห้ามลบบอทผ่าน Manager เพื่อ "สร้างใหม่" ถ้า cloudflared ที่ชี้มาที่บอทนั้นไม่ได้เป็น container ที่ Manager สร้างให้ เพราะบอทจะหายจาก Manager ทันทีแต่ tunnel ยังชี้ไปที่ชื่อเดิม
7. อย่า commit `.env`, `data/`, `logs/`, ไฟล์ credentials ของ cloudflared (รีโปมี `.gitignore` กันไว้แล้ว แต่ตรวจก่อน commit ทุกครั้ง)
