# Mock Lab — จำลอง Zabbix + Omada + HikCentral ให้บอทจริงต่อเข้ามาทดสอบ

สร้างอุปกรณ์และสถานการณ์ด้วยไฟล์ YAML แล้วให้บอท (LineBot) ชี้ URL มาที่ mock แทนอุปกรณ์จริง — บอทเรียก API ชุดเดียวกับที่ใช้จริง
(Zabbix JSON-RPC, Omada Open API แบบ OAuth2, HikCentral artemis แบบลายเซ็น AK/SK) จึงทดสอบคำสั่ง LINE ทุกตัวได้โดยไม่ต้องมีอุปกรณ์จริง

> **ต่างจาก `mock-server/` เดิม:** `mock-server/` จำลอง API รุ่นเก่า (Omada `/api/v2` + login ด้วย username, HikCentral OAuth) ซึ่งบอทปัจจุบันไม่ได้ใช้แล้ว
> และไม่มี Zabbix; `mock-lab/` ตามรูปแบบที่บอทใช้จริงตอนนี้ (ไม่ได้แก้หรือลบ `mock-server/` เพราะ Dockerfile ยัง COPY โฟลเดอร์นั้นเข้า image)

## เริ่มใช้งาน

```bash
node mock-lab/server.js                                  # สถานการณ์ปกติ (01-baseline-office.yaml)
node mock-lab/server.js 02-floor2-switch-down.yaml       # เริ่มด้วยสถานการณ์อื่น
MOCK_PORT=4200 node mock-lab/server.js                   # เปลี่ยนพอร์ต (ค่าเริ่มต้น 4100)
```

ต้องมี `js-yaml` (ติดมากับ `npm install` ที่ root ของโปรเจกต์อยู่แล้ว เพราะเป็น dependency ของ jest)

### ตั้งบอทให้ชี้มาที่ mock

เปิด `http://localhost:4100/` จะเห็นค่า `.env` ที่ต้องใช้ (ค่าเริ่มต้นด้านล่าง ถ้าบอทรันใน Docker ให้ใช้ `host.docker.internal` แทน `localhost`):

```env
ZABBIX_URL=http://localhost:4100/api_jsonrpc.php
ZABBIX_API_TOKEN=mock-zabbix-token

OMADA_URL=http://localhost:4100
OMADA_OMADAC_ID=mock-omadac
OMADA_SITE_ID=mock-site
OMADA_CLIENT_ID=mock-client
OMADA_CLIENT_SECRET=mock-secret

HIKCENTRAL_URL=http://localhost:4100
HIKCENTRAL_APP_KEY=mock-app-key
HIKCENTRAL_APP_SECRET=mock-app-secret
```

- **ใช้ .env ของบอทจริงไม่ได้พร้อมกัน** — ทำสำเนา (เช่น `.env.mock`) หรือรันบอทตัวทดสอบแยก (เช่น container แยกพอร์ต) อย่าแก้ `.env` ของ production
- ค่า token/credential ตรวจจริง (`MOCK_STRICT_AUTH=true` เป็นค่าเริ่มต้น): ใส่ผิดจะได้ error แบบเดียวกับระบบจริง — ใช้ทดสอบปุ่ม "ทดสอบการเชื่อมต่อ" ใน Manager ได้ทั้งกรณีถูกและผิด
  ตั้ง `MOCK_STRICT_AUTH=false` ถ้าอยากให้รับค่าอะไรก็ได้ ตั้งค่าเองได้ด้วย `MOCK_ZABBIX_TOKEN`, `MOCK_OMADAC_ID`, `MOCK_OMADA_SITE_ID`, `MOCK_OMADA_CLIENT_ID/SECRET`, `MOCK_HIK_APP_KEY/SECRET`

## ไฟล์สถานการณ์ (`scenarios/*.yaml`)

```yaml
name: "Switch ชั้น 2 ล่ม (ลูกโซ่)"
description: "..."
extends: 01-baseline-office.yaml     # ใช้ชุดอุปกรณ์จากไฟล์อื่นเป็นฐาน (เลือกได้)
generate:                            # สร้างอุปกรณ์เป็นชุดจาก template: {n} = เลขจาก from..to, {i} = ลำดับเริ่มที่ 1
  - {kind: camera, name: "HQ-CAM-{n}", from: 101, to: 116, ip: "192.168.30.{n}", location: "ชั้น 1"}
devices:                             # เพิ่ม/ทับอุปกรณ์ (ชื่อซ้ำกับฐาน = ทับทั้งตัว)
  - {name: SRV-FILE-01, kind: host, ip: 192.168.1.30, metrics: {cpu: 22, memory_used: 48, disk_used: 81}}
patch:                               # แก้เฉพาะฟิลด์ของอุปกรณ์ที่มีอยู่ (ไม่ต้องคัดลอกทั้งตัว)
  - {name: SW-FL2-01, set: {status: down, down_since: "-12m"}}
alerts:                              # trigger ของ Zabbix ที่กำหนดเอง
  - {host: SRV-DB-01, description: "Lack of available memory", priority: 5, since: "-8m", comments: "..."}
```

### ฟิลด์ของอุปกรณ์ (ทุกฟิลด์นอกจาก `name` และ `kind` เป็น optional)

| ฟิลด์ | ความหมาย |
|---|---|
| `name` | ชื่ออุปกรณ์ (ไม่ซ้ำ) — ใช้เป็น hostname ใน Zabbix / ชื่อ AP ใน Omada / cameraIndexCode ใน HikCentral |
| `kind` | `ap` · `switch` · `gateway` (Omada) · `camera` (HikCentral) · `host` (Zabbix) |
| `ip`, `mac`, `model`, `location` | ถ้าไม่ใส่ mac จะสร้างให้คงที่จากชื่อ · `location` ของกล้อง = ชื่อพื้นที่ (region) ใน HikCentral, ของ host = inventory location ใน Zabbix |
| `status` | `up` (ค่าเริ่มต้น) · `down` · `unknown` |
| `down_since` | เวลาที่เริ่มดับ: `"-15m"`, `"-4d3h"`, `"-2h30m"`, ISO เช่น `"2026-10-15T09:12:03+07:00"` หรือ epoch (ไม่ใส่ = ตอนโหลด) |
| `depends_on` | ชื่ออุปกรณ์แม่ — **แม่ down → ลูก down ตามอัตโนมัติ** (จำลองปัญหาลูกโซ่) `ignore_dependency: true` = ไม่ตามแม่ |
| `flap` | `{period_s, down_s}` — down ในช่วง `down_s` วินาทีแรกของทุกรอบ `period_s` (จำลองล่มๆ หายๆ; ลูกของมันสะดุดตามด้วย) |
| `zabbix_status` | สถานะที่ **Zabbix เห็น** ต่างจากระบบอื่น (จำลองข้อมูลขัดแย้ง เช่น ICMP ถูกบล็อกแต่เครื่องปกติ) |
| `zabbix` | `true` หรือ `{groups: [...]}` — สะท้อนอุปกรณ์ที่ไม่ใช่ host เข้า Zabbix ด้วย (กล้องจะอยู่กลุ่ม `Camera` ให้อัตโนมัติ ซึ่งบอทใช้หากล้อง) · `kind: host` อยู่ใน Zabbix เสมอ (กลุ่มตั้งด้วย `groups: [...]`) |
| `metrics` | `{cpu, memory_used, disk_used}` เป็น % — Zabbix `item.get/history.get` คืนค่าตามนี้ และ **ค่าตั้งแต่ 90% ขึ้นไปสร้าง trigger ให้เอง** |
| `clients` | จำนวน client ที่เกาะ AP (ไร้สาย) หรือ switch (สาย) — อุปกรณ์ดับแล้ว client หายไป |
| `ports` | รายการพอร์ตของ switch `[{port, name, linkStatus, linkSpeed, poe}]` (ไม่ใส่ = สร้างจากอุปกรณ์ลูกที่ `depends_on` switch นี้) |
| `alerts` | trigger ของอุปกรณ์นี้ `[{description, priority 0-5, since, comments}]` |
| `comments` | ข้อความที่ใส่ใน comments ของ trigger "Unavailable by ICMP ping" ของเครื่องนี้ |

**alert ที่กำหนดเองแทนที่ trigger อัตโนมัติชนิดเดียวกัน:** ถ้าอุปกรณ์มี `alerts` ที่ชื่อเข้ากับ ICMP/CPU/memory/disk อยู่แล้ว mock จะไม่สร้างตัวอัตโนมัติชนิดนั้นซ้ำ (เขียน priority/comments เองได้)

**trigger ที่ mock สร้างให้เอง** (ตรงกับที่ Zabbix template มาตรฐานสร้าง): อุปกรณ์ที่อยู่ใน Zabbix และ down → `Unavailable by ICMP ping` (priority 4);
`cpu ≥ 90` → `High CPU utilization (over 90% for 5m)`; `memory_used ≥ 90` → `Lack of available memory (<10% of total)`; `disk_used ≥ 90` → `Free disk space is less than 10% on volume /`

### สถานการณ์ที่มีมาให้

| ไฟล์ | สถานการณ์ | เคสที่เกี่ยวข้องในชุดเปรียบเทียบ AI |
|---|---|---|
| `01-baseline-office.yaml` | สำนักงาน 3 ชั้น ปกติทั้งหมด (27 อุปกรณ์: gateway 1, switch 4, AP 6, กล้อง 12, server 4) — ใช้เป็นฐาน | — |
| `02-floor2-switch-down.yaml` | switch ชั้น 2 ล่ม → AP 2 + กล้อง 5 หลุดตาม | CAS-01 |
| `03-nvr-down.yaml` | NVR ล่ม → กล้องชั้น 1 หายทั้งกลุ่ม | CAS-04 |
| `04-db-memory-exhausted.yaml` | DB หน่วยความจำหมด (OOM) | HOST-02 |
| `05-raid-degraded.yaml` | file server ดิสก์เสื่อม RAID degraded | HOST-05 |
| `06-uplink-flapping.yaml` | uplink switch ชั้น 2 สะดุดเป็นรอบ | FLAP-01 |
| `07-conflict-icmp-blocked.yaml` | Zabbix เห็น web server ล่มจาก ICMP แต่เครื่องปกติ | CON-02 |
| `08-gateway-down.yaml` | gateway ล่ม LAN ปกติ | NET-02 |

### สถานการณ์สำหรับชุดเปรียบเทียบ AI (`cmp-<เคส>.yaml`, 34 ไฟล์)

หนึ่งไฟล์ต่อเคสใน `ai-comparison/scenarios/` (เช่น `cmp-CAS-01.yaml`) แต่ละไฟล์อิสระ (ไม่ extends) และมีหมายเหตุที่หัวไฟล์ว่าเส้นทางในบอทที่ใช้และส่วนใดต้องพึ่ง comments — ใช้ผ่าน `ai-comparison/tools/run-comparison.js` (ดู `ai-comparison/README.md`) ไม่ได้มีไว้ให้รันบอทเล่นเอง (ชื่ออุปกรณ์บางเคสถูกตั้งให้ตรงตรรกะจัดกลุ่ม zone ของบอท)

## เปลี่ยนสถานการณ์/สร้าง-แก้-ลบอุปกรณ์ขณะรัน (ไม่ต้อง restart)

```bash
curl localhost:4100/mock/state                                   # สรุปทุกระบบ + สถานะทุกอุปกรณ์ (own_status / effective ต่อระบบ)
curl localhost:4100/mock/scenarios                               # ไฟล์สถานการณ์ที่มี
curl -X POST localhost:4100/mock/scenario/load -H "Content-Type: application/json" -d '{"file":"03-nvr-down.yaml"}'
curl -X POST localhost:4100/mock/scenario/load -H "Content-Type: application/json" -d '{"yaml":"name: t\ndevices:\n  - {name: A, kind: switch}"}'

# สร้างอุปกรณ์ (ฟิลด์เดียวกับไฟล์ YAML)
curl -X POST localhost:4100/mock/devices -H "Content-Type: application/json" \
  -d '{"name":"HQ-CAM-999","kind":"camera","ip":"192.168.90.9","location":"ชั้น 9","depends_on":"SW-FL1-01","zabbix":true}'
# แก้บางฟิลด์ / สั่งดับ-กลับมา / ลบ
curl -X PATCH  localhost:4100/mock/devices/SRV-DB-01 -H "Content-Type: application/json" -d '{"metrics":{"cpu":96}}'
curl -X POST   localhost:4100/mock/devices/SW-FL2-01/down          # หรือ /up
curl -X DELETE localhost:4100/mock/devices/HQ-CAM-999

curl -X POST localhost:4100/mock/reset                           # กลับไปสถานการณ์ที่โหลดล่าสุด (ล้างสิ่งที่แก้ผ่าน API)
curl "localhost:4100/mock/requests?limit=20"                     # บอทเรียก API ไหนบ้าง (ไม่เก็บ header/secret)
```

ข้อมูลอยู่ในหน่วยความจำ — restart แล้วกลับไปที่ไฟล์เริ่มต้น

## endpoint ที่จำลอง (เฉพาะที่ service ของบอทเรียกใช้จริง)

- **Zabbix** `POST /api_jsonrpc.php` (Bearer token): `apiinfo.version`, `hostgroup.get`, `host.get`, `trigger.get`, `problem.get`, `item.get`, `history.get`
- **Omada** `POST /openapi/authorize/token` และ `GET /openapi/v1/:omadacId/sites[/:siteId/devices|clients|alerts|switches/:mac/ports]` (header `Authorization: AccessToken=…`; ผิด → `errorCode` แบบ Omada) + `dashboard/overview-diagram`, `dashboard/traffic-activities?start&end` (วินาที) และ `clientStat` ใน result ของ `clients` — ใช้กับ `/stats/detail`; ค่า traffic ของ client โตตามเวลาที่ mock รัน
- **HikCentral** `POST /artemis/api/resource/v1/cameras`, `/cameras/indexCode`, `/regions`, `/artemis/api/eventService/v1/eventRecords/page` (ตรวจลายเซ็น `X-Ca-Signature` ด้วยสูตรเดียวกับบอท; ผิด → HTTP 401); `eventRecords/page` ถ้าส่ง `startTime`/`eventTypes` จะตรวจเหมือนของจริง (ขาด/ผิด → `code 2` "parameter error") แล้วสร้าง event จำลองคงที่ตามกล้อง+นาที — รหัสที่รู้จักใน mock: 131329 offline, 131330 motion, 131331 video loss, 131332 tampering (ของจริงยังไม่ยืนยันรหัส)

เรียก method/endpoint ที่ยังไม่ได้จำลอง → Zabbix ตอบ `Method not found`, endpoint อื่นได้ 404 — ถ้าบอทเพิ่ม API ใหม่ต้องเพิ่มใน `routes/` แล้วเพิ่มเทสใน `tests/mock-lab.test.js`

## ทดสอบ

```bash
npx jest tests/mock-lab.test.js
```

เทสไม่ได้ทดสอบแค่ตัว mock — **ให้ service ของบอทจริง** (`services/zabbix.js`, `omada.js`, `hikcentral.js`) ยิงเข้า mock ที่เปิดพอร์ตสุ่ม เพื่อยืนยันว่ารูปแบบคำตอบตรงกับที่บอทอ่านได้

## ข้อจำกัด

- จำลองพฤติกรรมที่บอทใช้เท่านั้น ไม่ใช่การจำลอง Zabbix/Omada/HikCentral เต็มรูปแบบ (เช่น ไม่มี history ย้อนหลัง, trigger ไม่มี dependency ของ Zabbix, ไม่มีการเปลี่ยนค่า metrics ตามเวลา)
- เมื่อกล้องอยู่ทั้งใน HikCentral และ Zabbix (`zabbix: true`) บอทจะนับกล้องซ้ำสองแหล่ง (พฤติกรรมของบอทจริงที่ผสมสองระบบโดยไม่ตัดซ้ำ) — ตัวเลขในคำสั่ง "กล้อง" จึงเป็นสองเท่าของจำนวนกล้องจริง
- ใช้ HTTP (ไม่มี TLS) — บอทรองรับ URL แบบ `http://` อยู่แล้ว
- ข้อมูลทั้งหมดเป็นข้อมูลสมมติ ไม่มีข้อมูลจริงของลูกค้า
