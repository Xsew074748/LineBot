# PROJECT SPEC — IT Monitor LINE Bot (+ NetGuard Manager)

> เอกสารนี้รวบรวมจาก **โค้ดจริง** ในโปรเจกต์ `D:\Project Code\RealCode\LineBot` (และ `NetguardManager` ในส่วนที่เกี่ยวข้อง) เพื่อใช้อ้างอิงเขียนเล่มโครงงานบทที่ 3-4
> อ่านอย่างเดียว — ไม่มีการแก้ไขไฟล์ใดๆ ระหว่างรวบรวมข้อมูล
> ทุกจุดระบุ `path:line` เท่าที่ตรวจสอบได้จริง จุดใดไม่พบในโค้ดจะระบุว่า **"ไม่พบ"**

---

## ส่วนที่ 1: เวอร์ชันเครื่องมือ

### 1.1 Dependencies — `package.json`

**Declared (package.json:11-23)**

| Package | Version (declared) | Version (installed จริง — `npm ls --depth=0`) |
|---|---|---|
| `@anthropic-ai/sdk` | `^0.36.3` | `0.36.3` |
| `@line/bot-sdk` | `^9.4.0` | `9.9.0` |
| `@modelcontextprotocol/sdk` | `^1.12.0` | `1.29.0` |
| `axios` | `^1.7.9` | `1.16.1` |
| `dotenv` | `^16.4.7` | `16.6.1` |
| `express` | `^4.21.2` | `4.22.2` |
| `express-rate-limit` | `^7.5.0` | `7.5.1` |
| `zod` | `^3.24.0` | `3.25.76` |
| `jest` (devDependency) | `^29.7.0` | `29.7.0` |

### 1.2 Node.js version

- **Dockerfile** (`Dockerfile:2`): `FROM node:20-alpine`
- **package.json engines** (`package.json:24-26`): `"node": ">=18.0.0"`

### 1.3 Claude Model ที่ใช้จริง — `services/ai.js`

```js
// services/ai.js:7
const MODEL = 'claude-haiku-4-5';
```

| พารามิเตอร์ | ค่า | อ้างอิง |
|---|---|---|
| model | `claude-haiku-4-5` | `services/ai.js:7` |
| max_tokens (default) | `500` | `services/ai.js:33, 62` |
| max_tokens (`analyzeAlert`) | `600` | `services/ai.js:81` |
| max_tokens (`summarize`) | `600` | `services/ai.js:121` |
| max_tokens (`analyzeCorrelation`) | `600` | `services/ai.js:151` |
| max_tokens (postback `handleAnalyze` ใน index.js) | `800` | `index.js:329` (2-layer context ยาวกว่า chat ปกติ) |
| temperature | **ไม่พบ** — ไม่มีการตั้งค่าใน `client.messages.create()` (`services/ai.js:37-42`) ใช้ค่า default ของ Anthropic API | — |
| retry | ลอง 2 ครั้ง (attempt 1 ล้มเหลว → retry อัตโนมัติ, ล้มเหลวทั้ง 2 ครั้ง → throw) | `services/ai.js:33-58` |

### 1.4 LINE SDK version + API

- `@line/bot-sdk` — declared `^9.4.0`, ติดตั้งจริง `9.9.0`
- ใช้ `line.messagingApi.MessagingApiClient` (`index.js:32-34`) — เป็น client สำหรับ **LINE Messaging API** (REST API เวอร์ชันปัจจุบันของ LINE, endpoint `getProfile`, `replyMessage`, `pushMessage`)
- Auth: `channelAccessToken` จาก env `LINE_CHANNEL_ACCESS_TOKEN`

---

## ส่วนที่ 2: การเชื่อมต่อแต่ละระบบ

### 2.1 Zabbix — `services/zabbix.js`

**โปรโตคอล**: JSON-RPC 2.0 ผ่าน HTTP POST ไปยัง URL เดียว (`ZABBIX_URL`, ไม่มี path แยกตาม method) — body รูปแบบ `{ jsonrpc: '2.0', method, params, id: 1 }`

**Auth**: Zabbix 7.x API token ส่งเป็น HTTP header `Authorization: Bearer <ZABBIX_API_TOKEN>` (`zabbix.js:27`) — ยกเว้น `apiinfo.version` ที่เรียกแบบ `auth:false` (ส่ง header แล้วจะ error `-32600`)

**Function กลาง**: `rpc(method, params, {auth=true})` (`zabbix.js:23-44`) — มี timeout (`ZABBIX_TIMEOUT_MS`, default 15000ms, `zabbix.js:8`) แต่ไม่มี retry ในตัวมันเอง (error → log แล้ว throw ต่อ)

**Method ที่เรียกทั้งหมด**

| Method | บรรทัด | Params/Fields สำคัญ |
|---|---|---|
| `trigger.get` | `zabbix.js:48` | `filter:{value:'1'}`, `selectHosts`, `output:[triggerid,description,priority,lastchange,comments]`, `sortfield:lastchange` |
| `host.get` (getHosts) | `zabbix.js:100` | `output:[hostid,host,name,status]`, `selectInterfaces:[ip,available,main]` |
| `host.get` (getCameras) | `zabbix.js:126` | เหมือนบน + `groupids` ของกลุ่มกล้อง |
| `hostgroup.get` | `zabbix.js:151` | หากลุ่มที่ชื่อเข้าเกณฑ์ `camera/กล้อง/cctv/nvr/dvr/ipcam` |
| `host.get` (fetchOfflineCamerasRaw) | `zabbix.js:186` | เพิ่ม `selectInventory:[location]` |
| `problem.get` | `zabbix.js:214` | เฉพาะเมื่อกล้องดับ ≤ 30 ตัว (`CAMERA_MASS_FAIL`) |
| `host.get` (findHosts) | `zabbix.js:279` | `search:{host,name}`, `searchByAny:1` |
| `item.get` | `zabbix.js:324` | metric keys (CPU/Memory/Disk) |
| `history.get` | `zabbix.js:307` | fallback ไป `item.lastvalue` ถ้า history ว่าง |
| `apiinfo.version` | `zabbix.js:360` | health check |

**Metric keys** (`zabbix.js:298-303`): CPU=`system.cpu.util`, Memory=`vm.memory.size[pavailable]` (invert เป็น % used), Disk=`vfs.fs.size[/,pused]` / `vfs.fs.size[C:,pused]`

**module.exports** (`zabbix.js:367`): `getProblems, getHosts, getCameras, getSummary, healthCheck, fetchOfflineCamerasRaw, pageOfflineCameras, findHosts, getHostMetrics`

### 2.2 Omada — `services/omada.js`

**Auth**: OAuth2 **client_credentials grant** (Omada Open API) — `POST /openapi/authorize/token?grant_type=client_credentials` (`omada.js:52-55`), body `{omadacId, client_id, client_secret}`

- Token เก็บใน module-level variable (in-memory เท่านั้น, ไม่ persist) — `omada.js:45-46`
- ส่ง token แบบ header เฉพาะของ Omada: `Authorization: AccessToken=<token>` (`omada.js:86`, **ไม่ใช่** `Bearer`)
- Refresh: proactive ล่วงหน้า 5 นาทีก่อนหมดอายุ (`getToken()`, `omada.js:75-78`); ถ้าได้ 401 ระหว่างเรียก API จะ clear token แล้ว retry 1 ครั้ง (`omada.js:98-102`)
- อายุ token: อ่านจาก response `expiresIn`, default 2 ชั่วโมงถ้าไม่ได้ส่งมา (`omada.js:65`)

**Endpoint ทั้งหมด**

| Endpoint | บรรทัด | หน้าที่ |
|---|---|---|
| `POST /openapi/authorize/token` | 52-55, 250-254 | ขอ/ทดสอบ token |
| `GET /openapi/v1/{omadacId}/sites/{siteId}/devices` | 132-133 | AP/switch/gateway (getAPs) |
| `GET /openapi/v1/{omadacId}/sites/{siteId}/clients` | 160-161 | client ที่เชื่อมต่อ |
| `GET /openapi/v1/{omadacId}/sites/{siteId}/switches/{mac}/ports` | 197-199 | สถานะ port switch |
| `GET /openapi/v1/{omadacId}/sites/{siteId}/alerts` | 222 | **endpoint ยังไม่ยืนยันกับ controller จริง** (comment `omada.js:217-219`) — ล้มเหลวแล้ว fallback คืน `[]` |
| `GET /openapi/v1/{omadacId}/sites` | 237 | health check |

**Pagination**: `omadaGetAll()` วนหน้าละ 100 (`OMADA_PAGE_SIZE`) สูงสุด 50 หน้า (`omada.js:116-126`)

**ข้อมูลที่ดึงได้**: AP/Switch/Gateway (`{name, ip, status, mac, model, type}`), Client (`{name, ip, mac, ssid, ap, signal, traffic}`), Switch ports (`{portId, name, status, speed, poeStatus, clientMac}`)

**module.exports** (`omada.js:272`): `getToken, getAPs, getClients, getSwitchPorts, getAlerts, healthCheck, testConnection, http`

### 2.3 HikCentral — `services/hikcentral.js`

**AK/SK Signature — คำนวณจากโค้ดจริง (`buildSignedHeaders`, `hikcentral.js:46-74`)**

```js
function buildSignedHeaders(method, path) {
  const timestamp   = Date.now().toString();
  const accept      = '*/*';
  const contentType = 'application/json';

  const stringToSign = [
    method.toUpperCase(),
    accept,
    contentType,
    `x-ca-key:${APP_KEY}`,
    `x-ca-timestamp:${timestamp}`,
    path,
  ].join('\n');

  const signature = crypto
    .createHmac('sha256', APP_SECRET)
    .update(stringToSign, 'utf8')
    .digest('base64');

  return {
    Accept:                   accept,
    'Content-Type':           contentType,
    'X-Ca-Key':               APP_KEY,
    'X-Ca-Signature':         signature,
    'X-Ca-Signature-Headers': 'x-ca-key,x-ca-timestamp',
    'X-Ca-Timestamp':         timestamp,
    'X-Ca-Nonce':             crypto.randomUUID(),
  };
}
```

- **String-to-sign** ตามสเปก HikCentral (`METHOD\nAccept\nContent-MD5\nContent-Type\nDate\nx-ca-key\nx-ca-timestamp\npath`) — โค้ดจริง **ข้าม** บรรทัด `Content-MD5` และ `Date` ไปเลย (ไม่ใส่บรรทัดว่าง) ตามคอมเมนต์ที่เตือนไว้ชัดเจน (`hikcentral.js:42-44`)
- **HMAC algorithm**: HMAC-SHA256 (`hikcentral.js:61`)
- **Encoding**: Base64 (`hikcentral.js:63`)
- **Headers ที่ส่งจริง 7 ตัว**: `Accept`, `Content-Type`, `X-Ca-Key`, `X-Ca-Signature`, `X-Ca-Signature-Headers` (ค่าตายตัว `x-ca-key,x-ca-timestamp`), `X-Ca-Timestamp`, `X-Ca-Nonce` (UUID สุ่ม ไม่ได้อยู่ใน signature)
- ทุก endpoint เรียกผ่าน `POST` เท่านั้น (`hikPost()`, `hikcentral.js:76-95`); HTTP status เป็น 200 เสมอ ผลสำเร็จ/ล้มเหลวดูจาก field `code` ในตัว body (`'0'` = success)

**Endpoint ทั้งหมด** (prefix `/artemis/api/...`)

| Endpoint | บรรทัด | หน้าที่ |
|---|---|---|
| `resource/v1/regions` | 107 | รายการโซน/พื้นที่ (cache 10 นาที) |
| `resource/v1/cameras` | 146 | รายการกล้องทั้งหมด (paginate, max 500/หน้า) |
| `resource/v1/cameras/indexCode` | 159 | สถานะกล้องรายตัว |
| `resource/v1/cameras` (filter by region) | 171 | กล้องตามโซน |
| `eventService/v1/eventRecords/page` | 182-185 | เหตุการณ์ล่าสุด |
| `resource/v1/cameras` (pageSize 1) | 222 | health check |

**module.exports** (`hikcentral.js:229-236`): `getCameras, getCameraStatus, getCamerasByArea, getRegions, getEvents, healthCheck`

### สรุป env vars ต่อระบบ — `config.js:8-29`

| ระบบ | requiredEnv |
|---|---|
| Zabbix | `ZABBIX_URL`, `ZABBIX_API_TOKEN` (+ optional `ZABBIX_TIMEOUT_MS`) |
| Omada | `OMADA_URL`, `OMADA_OMADAC_ID`, `OMADA_CLIENT_ID`, `OMADA_CLIENT_SECRET`, `OMADA_SITE_ID` (+ optional `OMADA_CA_CERT_PATH`, `OMADA_TLS_SKIP_HOSTNAME`) |
| HikCentral | `HIKCENTRAL_URL`, `HIKCENTRAL_APP_KEY`, `HIKCENTRAL_APP_SECRET` (+ optional `HIKCENTRAL_CA_CERT_PATH`, `HIKCENTRAL_TLS_SKIP_HOSTNAME`) |

`getEnabledMonitors()` (`config.js:34-50`) เช็ค `requiredEnv` ครบไหมก่อนเปิด monitor นั้น — ขาดตัวไหน `console.warn` แล้วข้าม ไม่ทำให้ตัวอื่นพัง; `index.js:24-27` ใช้ผลนี้ตัดสินว่าจะ `require()` service ไหนบ้าง

**TLS (Omada/HikCentral ร่วมกัน)**: dedicated `https.Agent` — ถ้าตั้ง `*_CA_CERT_PATH` จะ verify ด้วย custom CA (`rejectUnauthorized:true`); ถ้าไม่ตั้งจะ fallback เป็น `rejectUnauthorized:false` (dev/LAN insecure mode) เฉพาะ instance นั้น ไม่กระทบ process อื่น

---

## ส่วนที่ 3: Flow การทำงาน

### 3.1 LINE Webhook → Reply (ไล่จาก `index.js`)

Entry point: `POST /webhook` (`index.js:175`, ใช้ `express.raw()` เพื่อเก็บ raw body ไว้ verify signature)

1. **ตอบ 200 ทันที** (`index.js:180`) — กัน LINE timeout 5 วินาที ก่อนประมวลผลจริง
2. **Verify signature** — `verifyLineSignature(body, sig)` (`index.js:132-147`): HMAC-SHA256 ของ raw body ด้วย `LINE_CHANNEL_SECRET` → base64 → เทียบด้วย `crypto.timingSafeEqual`; ไม่ผ่าน → log warning แล้วจบ (`index.js:183-186`)
3. **Parse JSON** → `events` array (`index.js:188-194`)
4. **Fan-out**: `Promise.allSettled(events.map(handleEvent))` (`index.js:197`) — แต่ละ event ประมวลผลอิสระ
5. ภายใน `handleEvent()` (`index.js:221-272`):
   - กรองเฉพาะ `source.type === 'user'`
   - `event.type === 'postback'` → แยกไป `handlePostback` (ดู 3.2)
   - รับเฉพาะ `event.type === 'message'`; sanitize ข้อความด้วย `validator.sanitizeText()`
   - **Timestamp freshness** — `validator.isTimestampFresh(event.timestamp)` (`index.js:236`) กัน replay attack
   - `auth.registerPending(userId)` (`index.js:244`) — auto สร้าง user ใหม่เป็น `PENDING`
   - **Rate limit ต่อ user** — `checkUserRateLimit(userId)` (`index.js:94-105`, เรียกที่ `index.js:247`)
   - `text === 'myid'` ตอบได้แม้ pending (`index.js:252-256`)
   - user ที่เป็น `PENDING` ถูก block ด้วยข้อความคงที่ (`index.js:259-264`)
   - ที่เหลือเข้า `route(text, rawText, userId, replyToken)` (`index.js:267`)
6. **`route()`** (`index.js:549` เป็นต้นไป): เช็ค admin sub-command (`adduser/removeuser/approve:/manage:/changerole/pending`) ก่อน → ตามด้วยกลุ่ม "วิเคราะห์..." (AI) → sub-route แบบ pagination (`กล้อง:`, `port:`) → `matchCommand(text)` (`index.js:534-547`, ตาราง keyword `COMMAND_MAP` ที่ `index.js:426-440`) แล้ว `switch(cmd)` เข้า case ตามคำสั่ง (`help/alert/host/camera/cameraOff/wifi/client/port/metric/summary/status/listuser/cross`) — ทุก case เช็คสิทธิ์ผ่าน `auth.canExecute()` ก่อนเรียก service (`zabbix.*`/`omada.*`/`hikcentral` ผ่าน `getCamerasWithCache`)
7. แต่ละ case เรียก `fmt.build*()` (`services/formatter.js`) แปลงเป็น LINE Flex Message
8. **Size guard** — `flexOversize(msg)` (`index.js:532`, เกณฑ์ `FLEX_SAFE_BYTES = 9000` byte) ถ้าเกินจะเรียก formatter ซ้ำด้วยรายการที่ตัดให้สั้นลง
9. **`reply()`** (`index.js:1189-1230` — ตำแหน่งโดยประมาณจากช่วงที่อ่าน) ส่งผ่าน `lineClient.replyMessage`; ถ้า fail จะลองใหม่โดยตัด quickReply ออก แล้ว fallback เป็นข้อความ error ธรรมดา
10. ไม่ match คำสั่งใดเลย → ตกไปที่ default case ปฏิบัติเป็น free-form chat: ดึง Zabbix problems ล่าสุดสูงสุด 5 รายการเป็น context แล้วเรียก `ai.chat()` ผ่าน `withAI()` (เช็ค role/quota)

### 3.2 AI Analysis เมื่อกดปุ่ม 🤖 (Postback)

1. `handlePostback(event)` (`index.js:275-304`) — ผ่าน guard ชุดเดียวกับ message flow (timestamp freshness, registerPending, rate limit, pending block)
2. `data` รูปแบบ `analyze:{type}:{name}:{ip}` → เข้าเงื่อนไข `data.startsWith('analyze:')` → `handleAnalyze()` (`index.js:307-332`) ห่อด้วย `withAI()` (เช็คสิทธิ์/quota AI)
3. Parse `type/name/ip` จาก postback data (รองรับชื่อที่มี `:` ปนอยู่)
4. `gatherAnalyzeContext(type, name, ip)` (`index.js:346-422`) สร้าง context 2 ชั้น:
   - **Layer 1** — สถานะของอุปกรณ์เป้าหมายเอง
   - **Layer 2** — อุปกรณ์ข้างเคียง: ดึง `omada.getAPs()` และ `getCamerasWithCache()` พร้อมกันด้วย `Promise.allSettled` (`index.js:348-351`) → AP ใน subnet เดียวกัน (`sameSubnet`, `/24`) หรือ AP ที่กำลังมีปัญหา, กล้องในไซต์เดียวกันหรือ subnet เดียวกัน แยกออนไลน์/ออฟไลน์
5. ประกอบ prompt ภาษาไทย (`index.js:318-326`) แล้วเรียก `ai.chat(prompt, null, 800)` (max_tokens 800 — สูงกว่า default 500 เพราะมี context 2 ชั้น)
6. ผลลัพธ์ผ่าน `fmt.buildAiResponse()` แล้ว `reply()`
7. `withAI()` หัก quota (`auth.incrementAIUsage`) เฉพาะเมื่อ AI call **สำเร็จ**เท่านั้น (`index.js:126`) — ถ้า Claude ล้มเหลวหลัง retry ครบ จะไม่หัก quota (`index.js:120-125`)

---

## ส่วนที่ 4: โครงสร้างข้อมูล

### 4.1 ไฟล์ใน `data/`

**`data/users.json`** — object คีย์เป็น LINE `userId`:

```
{
  "<userId>": {
    "role": "ADMIN" | "IT_STAFF" | "VIEWER" | "PENDING",
    "addedAt": "<ISO-8601>",
    "approvedAt"?: "<ISO-8601>",   // ตั้งโดย auth.approvePending
    "aiQuotaDate"?: "YYYY-MM-DD",  // วันล่าสุดที่ใช้ AI quota
    "aiUsedToday"?: number         // reset เมื่อ aiQuotaDate ไม่ตรงวันปัจจุบัน
  }
}
```

**`data/notified_alerts.json`** — array แบนของ `triggerId` (string) ที่เคย push แจ้งเตือนไปยัง LINE user แล้ว (กัน alert ซ้ำ) — จำกัดเก็บ 500 รายการล่าสุด (`index.js:1274` โดยประมาณ)

### 4.2 Role/Permission — `services/auth.js` + `config.js`

**Role ทั้งหมด** (`config.js:95-100`): `ADMIN`, `IT_STAFF`, `VIEWER`, `PENDING`
**ลำดับสิทธิ์** (`config.js:103`, สูง→ต่ำ): `ADMIN > IT_STAFF > VIEWER > PENDING`
**ตรวจสิทธิ์**: `hasPermission(userRole, requiredRole)` (`auth.js:59-64`) เทียบ index ใน `ROLE_HIERARCHY`

**คำสั่งต่อ role ขั้นต่ำ** (`config.js:118-141`, `COMMAND_PERMISSIONS`)

| Role ขั้นต่ำ | คำสั่ง |
|---|---|
| ADMIN | `adduser`, `removeuser`, `listuser`, `approve`, `config` |
| IT_STAFF | `pending`, `alert`, `host`, `กล้อง`, `กล้องดับ`, `wifi`, `client`, `ประวัติ`, `cross` |
| VIEWER | `ทั้งหมด`, `สรุป`, `status`, `help`, `myid` |

คำสั่งที่ไม่อยู่ในตารางจะ default เป็น `VIEWER` (`auth.js:69`)

**AI quota** (`config.js:107-110`): `allowedRoles = [ADMIN, IT_STAFF]` (VIEWER ใช้ AI ไม่ได้เลย — `auth.js:109-111`); `dailyQuota` = `AI_DAILY_QUOTA` env หรือ default **20 ครั้ง/user/วัน**, เก็บ/reset ผ่าน `aiQuotaDate`/`aiUsedToday` ใน `users.json`

**PENDING**: user ที่ยังไม่มีใน `users.json` ถือเป็น PENDING โดย auto (`auth.js:39-42`, สร้างระเบียนด้วย `registerPending`, `auth.js:49-56`) — ใช้ได้แค่ `myid`, rate limit เข้มกว่า (3 ครั้ง/นาที เทียบกับปกติ 10 ครั้ง/นาที — `config.js:82-85, 113-116`), ต้องรอ ADMIN อนุมัติผ่าน `approvePending()` (`auth.js:74-84`)

### 4.3 NetGuard Manager — SQLite schema + meta.json

**SQLite** (`NetguardManager/services/stats-db.js:18-49`, engine: `better-sqlite3`, `journal_mode = WAL`)

```sql
CREATE TABLE IF NOT EXISTS samples (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_name    TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  state       TEXT NOT NULL,          -- 'up' | 'down' | 'unknown'
  partial     INTEGER DEFAULT 0,
  problems_total    INTEGER,
  problems_disaster INTEGER,
  problems_high     INTEGER,
  problems_average  INTEGER,
  problems_warning  INTEGER,
  hosts_total    INTEGER, hosts_up    INTEGER,
  aps_total      INTEGER, aps_up      INTEGER,
  switches_total INTEGER, switches_up INTEGER,
  cameras_total  INTEGER, cameras_up  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_samples_bot_ts ON samples(bot_name, ts);

CREATE TABLE IF NOT EXISTS daily (
  bot_name     TEXT NOT NULL,
  day          TEXT NOT NULL,
  samples      INTEGER,
  up_count     INTEGER,
  down_count   INTEGER,
  unknown_count INTEGER,
  uptime_pct   REAL,
  avg_problems REAL,
  max_problems INTEGER,
  PRIMARY KEY (bot_name, day)
);
```

- `samples` เก็บ raw ทุก 5 นาที, ลบทิ้งเมื่อเก่ากว่า `RETENTION_DAYS = 60` วัน (`stats-db.js:9`, ลบด้วย `pruneOldSamples()` — `stats-db.js:200-205`)
- `daily` เป็น rollup รายวัน เก็บถาวรไม่ลบ
- ความหมาย `state`: `up` = `/stats` ตอบ 200 + `ok:true`, `down` = error/timeout/container ไม่ running, `unknown` = manager เองไม่ได้ poll (ช่วง downtime ของตัว manager) — `uptime_pct = up/(up+down)` เท่านั้น ไม่นับ `unknown`
- `fillUnknownGaps()` เติม sample `unknown` ย้อนหลังถ้า gap ห่างจาก sample ล่าสุด > 2 รอบ poll (10 นาที), จำกัด `MAX_GAP_FILL_ROWS = 288` แถว/bot (1 วัน) (`stats-db.js:8, 207-237`)

**`meta.json`** (`NetguardManager/services/meta.js:7`) — field ที่รองรับ: `companyName, contactName, contactPhone, contractEnd, note` (ทุก field optional string, `contractEnd` ต้องเป็นรูปแบบ `YYYY-MM-DD`) + auto field `createdAt`, `updatedAt` — เขียนแบบ atomic (`.tmp` แล้ว `rename`)

**poller.js**: interval 5 นาที (`POLL_INTERVAL_MS`), timeout 10 วิ (`STATS_FETCH_TIMEOUT_MS`), ดึงจาก `http://netguard-<botName>:3000/stats` ผ่าน Docker DNS แล้ว insert เข้า `samples` ผ่าน `statsDb.insertSample()`

---

## ส่วนที่ 5: Adapter Pattern

### 5.1 Interface ร่วม — `adapters/base.js`

`BaseMonitorAdapter` (`adapters/base.js:3-23`) — ทุก adapter (Zabbix/Omada/HikCentral) ต้อง override 3 method (ไม่ override → throw):

| Method | บรรทัด | Return shape (normalized) |
|---|---|---|
| `testConnection()` | 6-8 | `{ ok: boolean, message: string }` |
| `getProblems()` | 12-14 | `[{source, device, zone, type, status, timestamp, ip, severity}]` |
| `getDevices()` | 18-20 | `[{device, zone, type, status, ip}]` |

Normalized schema (ตาม `adapters/README.md:93-140`): `type` ∈ `camera/ap/switch/host/other`, `status` ∈ `up/down` (สำหรับ device) หรือ `"problem"` เสมอ (สำหรับ problem), `severity` 0-5

### ตัวอย่าง field mapping จริง

**ZabbixAdapter** (`adapters/zabbix.js:34-79`) — เรียก `services/zabbix.js` โดยตรง
- `p.host` → `device` + ผ่าน `extractZone()` → `zone` (บรรทัด 50-51)
- `p.host` ผ่าน `typeFromName()` (regex) → `type` (บรรทัด 52)
- `p.lastchangeTs` → `timestamp` (บรรทัด 54); `p.interfaces?.[0]?.ip` → `ip` (บรรทัด 55); `p.priority` → `severity` ตรงๆ (บรรทัด 56)
- `getDevices()`: `h.available === 1 ? 'up' : 'down'` → `status` (บรรทัด 71)

**OmadaAdapter** (`adapters/omada.js:6-56`)
- `e.name` → `device`; `zone` fix เป็น `'ไม่ระบุ'` เสมอ (Omada ไม่มี zone concept, บรรทัด 25)
- `type` fix เป็น `'ap'` เสมอ (บรรทัด 26)
- `timestamp` ใช้เวลา fetch ปัจจุบันแทน (Omada alert ไม่มี unix timestamp ให้แปลง, บรรทัด 20/28)
- `e.level.includes('วิกฤต') ? 5 : 2` → `severity` (binary mapping, บรรทัด 30)

**HikCentralAdapter** (`adapters/hikcentral.js:6-58`)
- `c.name` → `device`; `c.location !== 'N/A' ? c.location : 'ไม่ระบุ'` → `zone` (บรรทัด 28)
- `type` fix `'camera'` เสมอ; `ip` fix เป็น `null` เสมอ (HikCentral ไม่คืน IP กล้อง, บรรทัด 32); `severity` fix `3` เสมอ (บรรทัด 33)

### จุดที่เรียกใช้ adapters

- `config.js:12,20,27` — registry `adapterModule` ของแต่ละ monitor
- `config.js:53-67` — `getAdapters()` สร้าง instance จริงจาก `MONITORS` ที่ enabled
- `mcp-server/index.js` — เรียก `appConfig.getAdapters()` ในทุก tool (ดู 7.1)
- **หมายเหตุสำคัญ**: `index.js` (LINE Bot หลัก) **ไม่ได้เรียก adapters โดยตรง** — ใช้ `services/zabbix.js`, `services/omada.js`, `services/hikcentral.js` ตรงๆ แทน; adapter layer มีไว้สำหรับ normalized cross-system use เท่านั้น (MCP server + correlate)

### 5.2 Cross-System Correlation — `services/correlate.js`

**Export**: `{ correlate }` เท่านั้น (บรรทัด 115)

**จับคู่ด้วย**: `zone` (จาก `extractZone()` ของแต่ละ adapter) + `timestamp` — ไม่ใช้ IP หรือชื่อ host โดยตรงเป็นตัวจับคู่หลัก

**อัลกอริทึม** (`correlate(alerts, opts)`, บรรทัด 33-113):
1. กรองเฉพาะ alert ที่ `status === 'down' || 'problem'` และอยู่ในช่วง `lookbackSec` (default 300 วินาที, `DEFAULT_LOOKBACK_SEC`) — บรรทัด 44-47
2. จัดกลุ่มตาม `zone` (alert ที่ `zone === 'ไม่ระบุ'` ถูกจัดรวมกลุ่มแยกต่างหาก) — บรรทัด 51-56
3. **Anchor-based clustering** ภายใน zone เดียวกัน (บรรทัด 63-100): เรียงตาม timestamp, ใช้ alert แรกสุดที่ยังไม่ถูกใช้เป็น anchor แล้วดึง alert ที่ `timestamp - anchor.timestamp ≤ timeWindowSec` (default 120 วินาที, `DEFAULT_TIME_WINDOW_SEC`) เข้ากลุ่มเดียวกัน
4. **เกณฑ์ตัดกลุ่ม**: ต้องมีสมาชิก ≥ 2 อุปกรณ์ขึ้นไป (บรรทัด 80) จึงนับเป็น correlation group

**Confidence scoring** (`scoreConfidence()`, บรรทัด 12-21) — เป็น rule-based ให้ผล `high`/`medium` เท่านั้น (ไม่ใช่ weighted score ตัวเลข):
- มีหลายชนิดอุปกรณ์ปนกัน (`types.length > 1`) → `high`
- หรือมี switch/host ปนอยู่ในกลุ่ม → `high`
- อุปกรณ์ชนิดเดียวล้วน ไม่มี infra device → `medium`

เรียงผลลัพธ์: `high` ก่อน `medium`, ระดับเดียวกันเรียงตามจำนวน device มาก→น้อย (บรรทัด 104-107)

**Config**: `lookbackSec`/`timeWindowSec` override ได้ผ่าน `config.CORRELATION_CONFIG` (`config.js:89-92`: `lookbackSec: 300, timeWindowSec: 120`)

---

## ส่วนที่ 6: ความปลอดภัย

### 6.1 `crypto.timingSafeEqual` — ใช้ 3 จุดในทั้งโปรเจกต์ (ไม่พบใน NetguardManager)

| ไฟล์:บรรทัด | ป้องกันอะไร |
|---|---|
| `index.js:143` | เทียบ HMAC signature ของ LINE webhook (`verifyLineSignature`) |
| `index.js:209` | เทียบ shared secret ของ Zabbix webhook |
| `middleware/setupAuth.js:68` | เทียบ password hash ของ Setup UI (`verifyPassword`) |

ทั้ง 3 จุด **เช็คความยาว buffer เท่ากันก่อนเสมอ** (เพราะ `timingSafeEqual` throw ถ้าความยาวไม่เท่ากัน) — คอมเมนต์ซ้ำกันทุกจุด: *"timingSafeEqual บังคับให้ทั้งสอง buffer ยาวเท่ากัน — ตรวจก่อนเรียกเสมอ"* ป้องกัน timing side-channel attack ที่อาจเดา secret ทีละ byte จากความต่างของเวลาตอบสนอง

### 6.2 LINE Webhook Signature Verify

`verifyLineSignature()` (`index.js:132-147`): HMAC-SHA256 ของ raw request body ด้วย `LINE_CHANNEL_SECRET` → encode base64 → เทียบกับ header `x-line-signature` ด้วย `timingSafeEqual`

### 6.3 Zabbix Webhook Secret

`/zabbix-webhook` (`index.js:204-218`): shared-secret แบบธรรมดา (ไม่ใช่ HMAC) — เทียบ header `x-zabbix-secret` กับ `process.env.ZABBIX_WEBHOOK_SECRET` ผ่าน `timingSafeEqual` หลังเช็คความยาวเท่ากัน; คืน HTTP 401 ถ้า env ว่างหรือไม่ตรง

### 6.4 Rate Limit / Input Validation

**Rate limit ระดับ IP**: `express-rate-limit` เฉพาะบน `/webhook` — `windowMs: 60_000, max: 100` (`index.js:41`)

**Rate limit ระดับ User**: `checkUserRateLimit()` (`index.js:94-105`), เก็บใน `Map` ในหน่วยความจำ — ปกติ 10 ครั้ง/นาที (`config.RATE_LIMIT`), pending user 3 ครั้ง/นาที (`config.PENDING_RATE_LIMIT`)

**`services/validator.js`** exports:
- `validateIP(ip)` — regex IPv4 + เช็ค octet ≤255 + whitelist prefix (`ALLOWED_IP_PREFIX`, default `192.168.`)
- `validateLineUserId(userId)` — regex `^U[0-9a-f]{32}$`
- `validateRole(role)` — ต้องเป็นหนึ่งใน `ADMIN/IT_STAFF/VIEWER`
- `sanitizeText(text, maxLen=500)` — trim + ตัดความยาวไม่เกิน 500 ตัวอักษร
- `isTimestampFresh(timestampMs)` — ป้องกัน replay attack, ยอมรับช่วง −30 วินาที (clock skew) ถึง +5 นาที

### 6.5 `setupAuth.lanOnly` Guard

`middleware/setupAuth.js:71-83` — ต้องผ่านทั้ง 2 เงื่อนไข:
1. `isExternalHost(host)` (บรรทัด 24-29) — ปฏิเสธถ้า `Host` header ดูเหมือนโดเมนจริง (มี `.` และไม่ใช่ `localhost`/IP ตรงๆ) — กันการเข้าผ่าน Cloudflare Tunnel hostname
2. `isLanIp(ip)` (บรรทัด 13-21) — ยอมรับเฉพาะ `127.0.0.1`, `::1`, หรือ private range (`192.168.*`, `10.*`, `172.16-31.*`) โดย strip prefix `::ffff:` ก่อนเช็ค

Route `/setup`, `/settings`, `/api/config` ต้องผ่านทั้ง `lanOnly` และ `requireLogin` (session cookie, TTL 24 ชั่วโมง, token จาก `crypto.randomBytes(32)`, เก็บใน memory server-side) — `index.js:45-49`

---

## ส่วนที่ 7: MCP Server — `mcp-server/`

### 7.1 ภาพรวม

เปิดให้ MCP client (เช่น Claude Desktop) ดึงข้อมูล monitoring แบบ read-only จาก Zabbix/Omada/HikCentral โดยใช้ **adapter ชุดเดียวกับที่อธิบายในส่วนที่ 5** (`mcp-server/README.md:3-4`)

**Tools ที่ expose (4 ตัว)**

| # | ชื่อ Tool | บรรทัด | คำอธิบาย | Input schema |
|---|---|---|---|---|
| 1 | `get_problems` | 27-69 | ดึงรายการ alert/ปัญหาที่กำลังเกิดขึ้นจากทุกระบบ | `{ zone?: string }` |
| 2 | `get_devices` | 72-115 | ดึงรายการอุปกรณ์และสถานะ (กล้อง/AP/switch/host) | `{ type?: 'camera'\|'ap'\|'switch'\|'host' }` |
| 3 | `get_status_summary` | 118-172 | ภาพรวมสถานะระบบทั้งหมด | `{}` (ไม่รับ parameter) |
| 4 | `analyze_correlation` | 175-214 | วิเคราะห์ว่ามีอุปกรณ์หลายระบบขัดข้องพร้อมกันเป็นกลุ่มหรือไม่ | `{}` (ไม่รับ parameter) |

**Transport**: stdio เท่านั้น (`new StdioServerTransport()` + `server.connect(transport)`, บรรทัด 217-218) — **ไม่พบ** HTTP-SSE transport ในโค้ด (README ยืนยันตรงกัน)

**การเรียก adapter เดิม**: mcp-server เป็น ESM (`"type": "module"`) แต่ `adapters/`/`config.js` เป็น CJS จึงใช้ `createRequire()` เป็นสะพาน (บรรทัด 16) → `require('../config.js')` (บรรทัด 17) เรียก `appConfig.getAdapters()` ในทุก tool → ได้ instance ของ Zabbix/Omada/HikCentral Adapter ตาม monitor ที่ enabled → เรียก `adapter.getProblems()`/`getDevices()` ผ่าน `Promise.allSettled()`; tool `analyze_correlation` เรียก `require('../services/correlate.js')` (บรรทัด 18) ใช้ฟังก์ชัน `correlate()` เดียวกับ index.js

**Dependency**: `mcp-server/package.json:11-12` — `@modelcontextprotocol/sdk: ^1.12.0`, `zod: ^3.24.0`

---

## ส่วนที่ 8: สถาปัตยกรรม

### 8.1 Component หลักและหน้าที่

| Component | หน้าที่ |
|---|---|
| `index.js` | Express server, LINE webhook handler, command router, session cache ต่างๆ |
| `config.js` | Plugin registry ของ monitor, roles, permissions, correlation config |
| `services/zabbix.js` / `omada.js` / `hikcentral.js` | API client เชื่อมต่อระบบภายนอกโดยตรง (ใช้จริงโดย `index.js`) |
| `services/ai.js` | ห่อ Anthropic SDK — เรียก Claude สำหรับ chat/analyze/summarize/correlation |
| `services/auth.js` | จัดการ role/permission/pending user, อ่าน-เขียน `data/users.json` |
| `services/formatter.js` | สร้าง LINE Flex Message |
| `services/validator.js` | ตรวจสอบ input (IP, LINE userId, role, text, timestamp) |
| `services/stats.js` | รวมข้อมูลทุก monitor เป็น payload สำหรับ `/stats` (ให้ NetGuard Manager poll) |
| `services/correlate.js` | จับคู่ปัญหาข้ามระบบด้วย zone+time |
| `services/logger.js` | structured logging |
| `adapters/*` | normalized interface (สำหรับ MCP server + correlate เท่านั้น, ไม่ถูกใช้โดย index.js โดยตรง) |
| `mcp-server/` | MCP server แยก process, expose 4 tools ผ่าน stdio ให้ MCP client เช่น Claude Desktop |
| `middleware/setupAuth.js` | LAN-only guard + session login สำหรับ Setup UI |
| `routes/setup.js`, `routes/config.js` | backend ของ Setup UI |
| `public/` | หน้า HTML ของ Setup UI |
| `mock-server/` | mock API server สำหรับทดสอบ (dev only) |
| `data/` | runtime state (`users.json`, `notified_alerts.json`) |
| **NetguardManager** (repo แยก) | Dashboard คุม container ของบอทหลายตัว, poll `/stats`, เก็บสถิติ SQLite |

### 8.2 Text Diagram

```
LINE Platform
   │  POST /webhook (HMAC-SHA256 x-line-signature)
   ▼
index.js ── verifyLineSignature() ── route() ──┬──▶ services/zabbix.js   ──HTTP(JSON-RPC)──▶ Zabbix Server
                                                ├──▶ services/omada.js    ──HTTPS(OAuth2)───▶ Omada Controller
                                                ├──▶ services/hikcentral.js──HTTPS(AK/SK)───▶ HikCentral (artemis)
                                                └──(ปุ่ม 🤖 postback)──▶ services/ai.js ──HTTPS──▶ Anthropic Claude API
                                                        │
                                                        ▼
                                                services/formatter.js (Flex Message)
                                                        │
                                                        ▼
                                                lineClient.replyMessage() ──▶ LINE Platform ──▶ ผู้ใช้

Zabbix Server ── POST /zabbix-webhook (x-zabbix-secret) ──▶ index.js ── lineClient.pushMessage() ──▶ LINE user

NetGuard Manager (container แยก, Docker DNS)
   │  GET http://netguard-<bot>:3000/stats  (ทุก 5 นาที, timeout 10s)
   ▼
index.js ──▶ services/stats.js ──▶ รวมผล zabbix/omada/hikcentral ──▶ ตอบ JSON กลับ
   │
   ▼ (ฝั่ง Manager)
services/poller.js ──▶ services/stats-db.js ──▶ SQLite stats.db (samples/daily)
   │
   ▼
Dashboard UI (browser, Tailscale/LAN only) ──▶ routes/api.js, routes/auth.js

MCP Client (เช่น Claude Desktop)
   │  stdio JSON-RPC
   ▼
mcp-server/index.js ──▶ config.getAdapters() ──▶ adapters/{zabbix,omada,hikcentral}.js (normalized)
                                                        │
                                                        ▼
                                                services/{zabbix,omada,hikcentral}.js (เรียกซ้ำ path เดียวกับ index.js)
mcp-server/index.js ──▶ services/correlate.js (สำหรับ analyze_correlation)

Browser (LAN only) ──▶ middleware/setupAuth.lanOnly + requireLogin ──▶ routes/setup.js, routes/config.js ──▶ config.js/.env
```

---

## ส่วนที่ 9: ข้อจำกัด

### 9.1 TODO/FIXME/HACK — grep ทั้ง LineBot + NetguardManager

ไม่พบคำว่า `TODO`/`FIXME`/`HACK` ตัวอักษรตรงๆ ในทั้งสองโปรเจกต์ พบเฉพาะคำว่า "ยังไม่" ที่เป็น debt marker จริง (มีใน LineBot เท่านั้น):

| ไฟล์:บรรทัด | เนื้อหา |
|---|---|
| `services/omada.js:218` | `// ยังไม่ได้ทดสอบกับ controller จริง — กัน error ด้วย fallback คืน [] แทน throw` |
| `services/omada.js:229` | `logger.warn(\`omada: getAlerts ล้มเหลว (endpoint ยังไม่ยืนยัน): ${err.message}\`)` |

(ข้อความอื่นที่มีคำว่า "ยังไม่" เป็นข้อความตอบผู้ใช้ทั่วไป เช่น "Zabbix ยังไม่เปิดใช้งาน" ไม่ใช่ debt marker)

### 9.2 ฟีเจอร์ที่มีโค้ดแต่ยังใช้งานไม่เต็มที่

- **`omada.getAlerts()`** (`services/omada.js:218-229`) — endpoint `/openapi/v1/{omadacId}/sites/{siteId}/alerts` ยังไม่ยืนยันว่าถูกต้องกับ controller จริง โค้ดออกแบบให้ fallback คืน `[]` เงียบๆ เมื่อ fail แทนที่จะ throw
- **NetguardManager** — `CLAUDE.md` ระบุตรงๆว่า "ยังไม่ทดสอบบน Linux server จริง"
- พบข้อขัดแย้งเล็กน้อยระหว่างเอกสารกับโค้ดจริงใน NetguardManager: `CLAUDE.md` ระบุว่า `listBots()` ตรวจจับ bot จาก image ตรงกับ `botImage` ด้วย แต่โค้ดจริง (`NetguardManager/services/docker.js:115-122`) กรองด้วย label `netguard.managed==='true'` เท่านั้น (คอมเมนต์ในโค้ดระบุชัดว่า "เฉพาะ label เท่านั้น — ไม่ fallback ไป image name") — เอกสารอาจล้าหลังกว่าโค้ดปัจจุบัน
- `mock-server/` — มีไว้สำหรับทดสอบ dev เท่านั้น ไม่ถูกอ้างอิงจาก production path (`index.js`)

### 9.3 ข้อจำกัดที่ระบุไว้ตรงๆในคอมเมนต์โค้ด

| ข้อจำกัด | ค่า | อ้างอิง |
|---|---|---|
| Zabbix RPC timeout | 15000ms (default) | `services/zabbix.js:8` |
| Camera mass-fail threshold (ข้าม problem.get) | 30 ตัว | `services/zabbix.js:174-175` |
| Omada page size / max pages | 100 / 50 หน้า (cap 5,000 รายการ) | `services/omada.js:116-126` |
| HikCentral region cache TTL | 10 นาที | `services/hikcentral.js:99` |
| LINE Flex payload safe size | 9000 byte | `index.js:531-532` |
| Rate limit ต่อ user (ปกติ / pending) | 10 / 3 ครั้งต่อนาที | `config.js:82-85, 113-116` |
| AI daily quota | 20 ครั้ง/user/วัน (default) | `config.js:107-110` |
| Context TTL (สำหรับ "วิเคราะห์...") | 10 นาที | `index.js:86` |
| Setup session TTL | 24 ชั่วโมง | `middleware/setupAuth.js` |
| Correlation lookback / time window | 300 วิ / 120 วิ | `config.js:89-92` |
| NetGuard Manager: samples retention | 60 วัน | `NetguardManager/services/stats-db.js:9` |
| NetGuard Manager: gap-fill สูงสุด | 288 แถว/bot (1 วัน) | `NetguardManager/services/stats-db.js:8` |
| NetGuard Manager: poll interval / timeout | 5 นาที / 10 วิ | `NetguardManager/services/poller.js:5-6` |
| NetGuard Manager: query ย้อนหลังสูงสุด | samples ≤168 ชม., daily ≤90 วัน | `NetguardManager/routes/api.js:169, 182` |
| NetGuard Manager: login rate limit | 5 ครั้ง/15 นาที | `NetguardManager/routes/auth.js:9-15` |
| NetGuard Manager: ห้ามผูก Cloudflare Tunnel เข้า manager | — | `NetguardManager/CLAUDE.md` |
| NetGuard Manager: เข้าถึงเฉพาะ Tailscale VPN + private LAN | — | `NetguardManager/CLAUDE.md` |

---

*เอกสารนี้สร้างจากการอ่านโค้ดจริงเท่านั้น — วันที่รวบรวม: ตามวันที่ทำงานจริงในเซสชันนี้ (ดู timestamp การสร้างไฟล์)*
