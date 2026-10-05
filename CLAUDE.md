# IT Monitor LINE Bot

## วิธีทำงานที่ต้องการ
- ตอบเป็นภาษาไทยเสมอ ยกเว้นชื่อไฟล์ คำสั่ง และโค้ด
- ห้ามตอบเป็นภาษาญี่ปุ่น เกาหลี หรือจีน

## บทเรียนที่เจอมาแล้ว (อย่าพลาดซ้ำ)
- Deploy image ใหม่ให้ bot ที่มีอยู่แล้วผ่าน Manager: "อัปเดต Image" (pull)
  อย่างเดียวไม่พอ ต้อง remove+recreate container ด้วย ไม่งั้น container
  เดิมจะยังรัน image เก่าอยู่ (ดูรายละเอียดใน NetguardManager/CLAUDE.md)
- AI provider (OpenAI ยืนยันแล้ว) สะท้อน API key กลับมาใน error body → ห้ามใส่ body ใน Error/log
  ใช้ services/ai-providers/diagnostics.js (allowlist: retry-after, code, message สั้นที่ redact แล้วเฉพาะ 429/5xx)
- replyToken ของ LINE หมดอายุเร็ว แต่ AI ช้าได้ 30+ วินาที → คำสั่ง AI ทุกตัวใช้ aiGate + startAiJob
  (index.js): reply ack ครั้งเดียว แล้ว push ผล; ผู้ใช้ 1 คนมีงาน AI ได้ทีละงาน (aiInFlight, stale 3 นาที)
- Gemini รุ่นปัจจุบันเป็น thinking model → ต้อง thinkingBudget: 0 ไม่งั้นได้คำตอบว่าง; 503/429 เจอบ่อย
  → retry 3 ครั้ง backoff 2s/4s เฉพาะ 503/429 (services/ai-providers/retry.js); timeout 45 วินาทีต่อครั้ง
  (AI_TIMEOUT_MS) และ timeout ไม่ retry; ชื่อรุ่น override ได้ด้วย GEMINI_MODEL (ตอนนี้ gemini-3.8-flash)
- container ของบอทใช้เวลา UTC ใน log (เวลาไทย = +7 ชั่วโมง); production คือ netguard-itmonitor (พอร์ต host 3102 ที่ Manager สร้างให้,
  ดูด้วย docker port netguard-itmonitor; ภายนอกเข้าผ่าน tunnel เสมอ)
- deploy production (หลังย้ายเข้า Manager): ใช้ขั้นตอนในหัวข้อ "ขั้นตอน deploy ที่พิสูจน์แล้ว" ด้านล่าง — docker build → ติด rollback tag → สำรอง .env → สร้าง container netguard-itmonitor ใหม่เองด้วย docker (ชื่อ/พอร์ต/label/network/bind เดิม)
  แล้วเทียบ docker inspect .Image กับ docker images --no-trunc; **ยังไม่ docker push ตราบที่ repo บน Docker Hub เป็น public** และอย่ากด "อัปเดต Image" ใน Manager (จะ pull :latest เก่าทับ tag ในเครื่อง);
  recreate ทำให้ webhook ที่ค้างอยู่ 1-2 วินาทีหายได้ (คำสั่ง `docker compose up -d --force-recreate line-bot` เป็นของ it-monitor-bot เดิม ใช้ไม่ได้อีกแล้ว — service line-bot ถูกตัดออกจาก docker-compose.yml)
- docker kill จากภายนอกไม่ trigger restart policy (ถือเป็น stop ด้วยมือ) — ต้อง kill process ข้างใน container
- Git Bash บน Windows: -e X=/path ใน docker run ถูกแปลงเป็น path ของ Windows → ตั้ง MSYS_NO_PATHCONV=1;
  อย่าใส่ backtick ในสตริงของ node -e (bash รันเป็นคำสั่ง) ให้เขียนสคริปต์เป็นไฟล์แทน
- /test-connection (POST) ใช้ค่าที่ส่งมาตรงๆ ยิงออกไปยัง URL ที่รับมา → จำกัดเฉพาะ LAN (setupAuth.lanOnly) กัน SSRF

## Dedup กล้อง (services/camera-identity.js)
- snapshot ของวันที่ 2026-10-02 (ไม่ใช่ค่าปัจจุบัน — ดูค่าปัจจุบันที่ /stats): HikCentral 68 กล้อง index code ครบ/ไม่ซ้ำ; Zabbix 5 host; ทับกันข้ามระบบ 0; **Zabbix ไม่มีรหัส Hik เก็บที่ใดเลย** (ไม่มี inventory/tag/macro) และ list กล้องของ Hik ไม่มี IP → จับคู่ข้ามระบบด้วยรหัสล้วนไม่ได้
- ภายใน HikCentral: ใช้ index code (ชื่อซ้ำแต่รหัสต่าง = คนละตัว) — getCameras ตัดหน้าที่ซ้อนกัน (เดิมนับตัวซ้ำเข้า total แล้วหยุดไล่หน้าเร็ว กล้องท้ายๆ หาย), getCameraIndexCodes ไม่ใส่รหัสซ้ำ
- ข้ามระบบ (getAllCameras, /stats, daily summary): รหัสก่อน (ถ้ากล้อง Zabbix มี `hikIndexCode` — ตอนนี้ไม่มีใครตั้ง; ยังไม่ได้เพิ่ม selectTags) แล้ว fallback ชื่อ normalize แบบ 1:1; Zabbix มาก่อน (ชื่อ/สถานะฝั่ง Zabbix ถูกเก็บ)
- key มี prefix ระบบเสมอ (`hik:` / `zbx:`) — hostid ของ Zabbix กับ index code ของ Hik เป็นเลขเหมือนกันได้
- ผลต่อผู้ใช้: ณ snapshot 2026-10-02 ผลรวมเท่าเดิม (68 + 5 = 73; จำนวนจริงเปลี่ยนได้ตามอุปกรณ์); กล้องที่อยู่ทั้งสองระบบจะนับ/แสดงครั้งเดียว (บันทึก "กล้องที่อยู่ทั้งสองระบบถูกนับซ้ำ" ในหัวข้อ ai-comparison ด้านล่าง **แก้แล้ว** — 34 เคสของ ai-comparison ไม่ได้รับผลเพราะเคสที่มีกล้องทั้งสองระบบใช้เส้นทาง alert)
- ai-comparison/tools/bot-context.js: ส่ง cameraIdentity เข้า sandbox ของ getAllCameras และตัด CR ก่อนเทียบ drift (บน Windows index.js เป็น CRLF จึงเคยล้มทุกครั้งหลัง git checkout/stash)

## Circuit breaker ของ HikCentral (services/circuit-breaker.js, ครอบที่ hikPost จุดเดียว)
- ล้มเหลวติดกัน 3 ครั้ง (timeout / เครือข่ายขาด / HTTP 5xx) → เปิด 60 วินาที (คำขอล้มทันที ไม่รอ 10 วินาที) → ลอง 1 คำขอ → ปิดเมื่อสำเร็จ;
  ปรับด้วย HIKCENTRAL_BREAKER_THRESHOLD / HIKCENTRAL_BREAKER_COOLDOWN_MS (และ HIKCENTRAL_TIMEOUT_MS สำหรับ timeout ต่อคำขอ)
- ไม่นับ: 4xx, ลายเซ็นผิด, code != 0 ของ artemis (เช่น parameter error ของเราเอง) — เซิร์ฟเวอร์ตอบอยู่ ไม่ใช่ปัญหาความพร้อมใช้งาน
- override (ปุ่ม "ทดสอบการเชื่อมต่อ" ด้วย config ที่ยังไม่บันทึก) ข้าม breaker; ไม่ใช้ข้อมูลเก่าแทนตอน breaker เปิด (ตั้งใจ — ไม่รู้สถานะจริงก็ไม่ควรบอกว่าปกติ)
- สถานะอยู่ใน /stats: `breakers: { hikcentral: "closed" | "open" | "half_open" }` (log เฉพาะตอนเปลี่ยนสถานะ); ทดสอบด้วย mock-lab `POST /mock/fault`

## แจ้งเตือน Omada traffic เกิน threshold (services/omada-traffic-alert.js) — ปิดเป็นค่าเริ่มต้น
- ตั้ง OMADA_TRAFFIC_ALERT_DOWN_MBPS / _UP_MBPS (อย่างน้อยหนึ่งตัว) จึงเปิด; ค่าอื่นดู .env.example (sustain 2 bucket, cooldown 30 นาที, ตรวจทุก 5 นาที, severity 3)
- วัดเฉพาะ traffic ของ AP จาก dashboard/traffic-activities เฉพาะ bucket ที่ปิดแล้ว; เกินติดกัน N bucket → แจ้ง; ต่ำกว่า 80% ติดกัน N bucket → ส่ง "กลับสู่ปกติ";
  ส่งผ่าน pushToUsers เดิม (allow-list: severity 3 = ADMIN/IT_STAFF เท่านั้น); state อยู่ที่ data/omada-traffic-alert.json (รอด recreate; ไม่นับ bucket ซ้ำ)
- ⚠️ ยังไม่ยืนยันกับของจริง: ชื่อ field tx/rx และหน่วย (สมมติ bytes ต่อ bucket) เพราะไซต์ไม่มี client — **เปิด OMADA_TRAFFIC_ALERT_DRYRUN=true ก่อน**
  เทียบ log `bucket ล่าสุด down=… up=…` กับหน้า Omada แล้วค่อยปิด dry-run; ถ้า field ไม่รู้จักจะไม่แจ้งและ log ชื่อ field (ต้องเพิ่มใน TX_KEYS/RX_KEYS ของ stats-detail.js)
- DRYRUN ไม่เขียน state ลงไฟล์ (ไม่งั้นสลับเป็นโหมดจริงแล้วแจ้งครั้งแรกไม่ออก)

## HikCentral / Artemis OpenAPI — ข้อเท็จจริงที่ยืนยันกับของจริงแล้ว
- ทุกคำขอตอบ HTTP 200 เสมอ — ความสำเร็จดูที่ `code === "0"` ใน body; ลายเซ็นเป็น HMAC (AppKey/AppSecret) ตามที่ services/hikcentral.js ทำอยู่
- ตารางความหมาย error (ใช้วินิจฉัยตอนต่อไม่ติดหลังเปลี่ยน key):

  | code | ความหมาย | ทำอย่างไร |
  |---|---|---|
  | 0x02401642 | AppKey ไม่รู้จัก (ไม่มี consumer นี้) | ตรวจ AppKey ที่ .env กับหน้า API consumer |
  | 0x02401010 | consumer ไม่มีพารามิเตอร์ `userId` | เพิ่มพารามิเตอร์ของ consumer (ดูด้านล่าง) |
  | 0x02401003 | ลายเซ็นผิด (AppSecret ไม่ตรง) | ใส่ AppSecret ใหม่ให้ตรง; ⚠️ msg ของ error นี้สะท้อน AppKey เต็มกลับมา |
  | code 1 "Unknow Error(0, 41050)" | `userId` เป็น 0 หรือยังไม่ผูกกับผู้ใช้จริง | ตั้ง userId เป็นชื่อผู้ใช้ HikCentral ที่มีอยู่จริง |
  | code 2 (parameter error) | พารามิเตอร์คำขอผิด (ไม่ใช่ปัญหาการเชื่อมต่อ) | ดูหัวข้อ eventRecords ด้านล่าง |
- วิธีตั้ง API consumer ที่ถูก: เพิ่มพารามิเตอร์ชื่อ `userId` ค่า = **ชื่อผู้ใช้ HikCentral ที่มีสิทธิ์** (ไม่ใช่เลข 0), `domainId` = 0, และ authorize API group ให้ครบทุกกลุ่มที่บอทเรียก (resource/cameras/regions, eventService)
- ⚠️ Artemis สะท้อน AppKey (และข้อความ StringToSign) กลับมาใน msg ของ error ลายเซ็น → ห้าม log/แสดง msg ดิบ; getTempAlarmEvents ผ่าน `redactSecrets` ก่อน error ถึง log เสมอ (มี test รั่วไหลคุมอยู่)
- **ห้ามวาง AppKey/AppSecret/token ในแชทหรือพรอมต์** (เครื่องมือ AI ปฏิเสธใช้ได้ และค่าจะค้างในประวัติ) ให้ผู้ใช้ใส่ที่ไฟล์ .env เอง แล้วรายงานแค่ผลผ่าน/ไม่ผ่าน (ไม่พิมพ์แม้ท้าย 4 ตัว)

## eventRecords/page (HikCentral) — ข้อจำกัดที่ยืนยันแล้ว
- ต้องมี `eventTypes` (สตริงคั่น `,`); ถ้าใส่ `srcType` ต้องมี `srcIndexs` (สตริงคั่น `,`) ด้วย; เวลาเป็น ISO8601 มี offset; ช่วงเวลา **≤ 31 วัน** (เกิน → code 2); pageSize 100 ใช้ได้
- **eventType 192517 = Temperature Alarm** (srcType camera) — record มี eventIndexCode, eventType, srcType, srcIndex, description (ว่าง), startTime, stopTime, eventPicUri, eventPicList, linkCameraIndexCode; **ไม่มีตัวเลขอุณหภูมิ** และยังไม่พบ API ที่ให้ค่านี้
- หารหัสเหตุการณ์ที่ไม่รู้: ใช้ "anchor + กลุ่มใหญ่" — คำขอที่มีรหัสถูกต้องอย่างน้อย 1 ตัว (anchor ที่รู้ว่ามีจริง เช่น 131329) จะข้ามรหัสที่ไม่มีอยู่แบบเงียบๆ ส่วนคำขอที่ไม่มีรหัสถูกต้องเลยได้ code 2 → รับได้ ≥ 50,000 รหัสต่อครั้ง สแกนทีละกลุ่มใหญ่ ไม่ต้องยิงทีละรหัส (ประหยัดโควตา API)
- รหัส 131329–131332 ใน mock-lab เป็นของสมมติ ไม่ใช่รหัสจริง
- `HIKCENTRAL_EVENT_TYPES` ใช้กับหน้า "สถิติ" ของ Manager เท่านั้น **ไม่ได้กรองการแจ้งเตือน** (การแจ้งเตือนใช้ `HIKCENTRAL_TEMP_ALARM_TYPES` แยกต่างหาก)
- สถานะกล้องใน resource/cameras: 1 = ออนไลน์, 2 = ออฟไลน์

## แจ้งเตือน Temperature Alarm จาก HikCentral (services/hik-temp-alarm.js) — ปิดเป็นค่าเริ่มต้น
- ทำอะไร: ลูปทุก INTERVAL_SEC เรียก hikcentral.getTempAlarmEvents (ผ่าน circuit breaker เดิม; ไม่ดึงรูป) → `evaluate()` บริสุทธิ์ → ส่งผ่าน pushToUsers (allow-list ตาม role: severity 3 = ADMIN/IT_STAFF, ≥ 4 = ผู้ใช้ที่อนุมัติแล้วทุกระดับ)
- ข้อความบอก "กล้อง + เวลา (+07:00)" แล้วให้ไปตรวจค่าอุณหภูมิที่ HikCentral เอง (ไม่มีตัวเลขในข้อมูล)
- ตัวแปร .env (ดู .env.example) — ค่าผิดรูปแบบ → ใช้ค่าเริ่มต้น + warning ใน log:

  | ตัวแปร (`HIKCENTRAL_TEMP_ALARM_…`) | ความหมาย | ค่าเริ่มต้น |
  |---|---|---|
  | `ENABLED` | เปิดฟีเจอร์ (เฉพาะ "true") | false |
  | `DRYRUN` | true = log "จะส่ง …" เท่านั้น ไม่ส่ง LINE ไม่เขียน state; ส่งจริงเมื่อตั้ง "false" ชัดเจนเท่านั้น | true |
  | `TYPES` | eventType (จำนวนเต็มคั่น `,`) | 192517 |
  | `CAMERAS` | camera index code ที่เฝ้า — **ต้องระบุเอง** ไม่เดาจากชื่อ; ว่าง = ไม่ทำงาน | (ไม่มี) |
  | `INTERVAL_SEC` | ตรวจทุกกี่วินาที (30–3600) | 60 |
  | `LOOKBACK_MIN` | ค้นย้อนจาก watermark กี่นาที เผื่อ HikCentral บันทึกช้า (1–1440) | 30 |
  | `COOLDOWN_MIN` | กล้องเดียวกันเกิดซ้ำภายในกี่นาที ไม่แจ้งซ้ำแต่นับรวมในข้อความ (0 = ปิด) | 10 |
  | `SEVERITY` | 0–5 (ใช้เลือกกลุ่มผู้รับ) | 3 |
- พฤติกรรม:
  - ไม่ย้อนส่ง: `sinceMs` = เวลาเริ่มทำงาน (หรือที่บันทึกไว้) เหตุการณ์ก่อนหน้านั้นไม่แจ้ง; ช่วงค้นไม่เกิน 24 ชม.; กรองซ้ำด้วย eventIndexCode (seen ≤ 200)
  - รวมเหตุการณ์ในรอบเดียวเป็นข้อความเดียว (แสดง ≤ 5 + "และอีก N"); cooldown ต่อกล้องนับจากเวลาเกิดเหตุ
  - ดึงไม่ได้/breaker เปิด → ข้ามรอบ ไม่เปลี่ยน state; ส่ง LINE ไม่ถึงใครเลย → ไม่บันทึก state (รอบหน้าลองใหม่); ไม่มีผู้รับเข้าเกณฑ์ → บันทึก (กันวนส่งไม่รู้จบ)
  - state อยู่ที่ data/hik-temp-alarm.json (เขียน atomic; พัง/ไม่มี → เริ่มนับจากตอนนี้); **DRYRUN ไม่เขียน state** — ไฟล์นี้จะถูกสร้างหลังเปลี่ยนเป็นส่งจริงและ restart
- เปิด/ปิด: แก้ ENABLED / DRYRUN ใน .env ของ production แล้ว **restart container** (ดูหัวข้อ .env ด้านล่าง) — ฟอร์ม bot-config ของ Manager แก้ตัวแปรกลุ่มนี้ไม่ได้ (ไม่อยู่ใน FIELDS)
- ทดสอบ:
  - `node scripts/hik-temp-alarm-replay.js [--burst]` — เล่นซ้ำเหตุการณ์ตัวอย่างผ่าน evaluate/renderMessage ตัวเดียวกับของจริง ไม่ต่อเครือข่าย (`scripts/` อยู่ใน image แล้ว)
  - `node scripts/hik-temp-alarm-test-send.js` — แสดงข้อความและจำนวนผู้รับ **โดยไม่ส่ง**; ใส่ `--confirm-send` จึงส่งข้อความ "[ทดสอบ]" ถึง **ADMIN เท่านั้น** ผ่าน createAlertPusher เส้นทางเดียวกับของจริง (ไม่พิมพ์ userId) รันในคอนเทนเนอร์: `docker exec <container> node scripts/hik-temp-alarm-test-send.js`
- ยังไม่ทราบ: ความหน่วงที่ HikCentral บันทึกเหตุการณ์ (จึงค้นเหลื่อมเวลา — ถ้าช้ากว่า LOOKBACK_MIN จะพลาด), กล้องตัวอื่นที่ใช้ eventType เดียวกันหรือไม่, ชนิดเหตุการณ์ความร้อนอื่น (สแกนรหัสช่วงกว้างใน 90 วันแล้วไม่พบ)

## ไฟล์ .env ของ production (อ่านก่อนแก้ทุกครั้ง)
- ไฟล์ที่ container ใช้จริงคือไฟล์ที่ **mount เข้า container** (ไม่ใช่ .env ในโฟลเดอร์ซอร์ส) — หา path จริงทุกครั้งด้วย `docker inspect <container> --format '{{json .Mounts}}'` แล้วค่อยแก้ ในเอกสารนี้เรียกว่า "โฟลเดอร์ production .env"
- เป็น bind mount **ไฟล์เดี่ยว**: การแก้แบบ atomic (เขียน .tmp แล้ว rename) ทำให้ container ที่รันอยู่ยังเห็นไฟล์เก่าจนกว่าจะ `docker restart` (restart เพียงพอ ไม่ต้อง recreate ถ้าไม่เปลี่ยน image)
- ก่อนแก้: สำรองเป็นไฟล์ใหม่มี timestamp (เทียบ `cmp` ว่าเหมือนต้นฉบับ), แก้เฉพาะบรรทัดที่ตั้งใจแล้ว `diff` ยืนยันว่าเปลี่ยนแค่นั้น, ห้ามพิมพ์ค่า secret ออกมาตอนตรวจ

## ขั้นตอน deploy ที่พิสูจน์แล้ว (ฟีเจอร์ใหม่ที่ส่ง LINE จริง)
ทำตามลำดับ หยุดทันทีถ้าขั้นใดผิดปกติ:
1. **Rollback tag**: `docker tag <repo>:latest <repo>:prev-<ชื่อ>-<วันที่>` และยืนยันว่า ID ตรงกับ image ที่ container รันอยู่ (`docker inspect --format '{{.Image}}'`) — เก็บ tag นี้ไว้ ห้าม push
2. สำรอง .env (ดูหัวข้อด้านบน) แล้วเพิ่มตัวแปรของฟีเจอร์ โดย **เริ่มที่ ENABLED=true + DRYRUN=true**
3. **build จาก commit ที่ทดสอบแล้ว** (working tree สะอาด) — ถ้าฟีเจอร์ใช้ไฟล์โฟลเดอร์ใหม่ ตรวจว่า Dockerfile COPY แล้ว (เคยลืม `scripts/`)
4. recreate container เดิม (ชื่อ/พอร์ต/label/network/bind เดิม; ตรวจจาก `docker inspect` ก่อนลบ) — **ห้ามแตะ cloudflared และ container อื่น**; ไม่ใช้ปุ่ม "อัปเดต Image" ของ Manager (ดูหัวข้อ Manager) ช่วงไม่ตอบสนองจริงราว 5 วินาที
5. ตรวจหลัง deploy: `healthy`, `RestartCount=0`, log ขึ้น "เปิดใช้ … DRYRUN", ไม่มี warning ใหม่, HikCentral ตอบ OK + breaker closed, `/stats` จำนวนอุปกรณ์เท่าเดิม, ไม่มี push LINE, cloudflared/Manager ID ไม่เปลี่ยน, เวลาเริ่ม container ตรงกับที่ทำจริง
6. ส่งทดสอบถึง **ADMIN คนเดียว** ด้วย test-send (ดูก่อนไม่มีธง แล้วค่อย `--confirm-send` ครั้งเดียว) และให้ผู้ใช้ยืนยันว่าได้รับข้อความ
7. เมื่อผู้ใช้อนุมัติ จึงตั้ง `DRYRUN=false` (สำรอง .env ใหม่ก่อน) แล้ว `docker restart`; ตรวจว่า log ไม่มีคำว่า DRYRUN, state file ถูกสร้างและ watermark เป็นเวลาที่เริ่มใหม่ (ไม่ใช่เหตุการณ์เก่า), ไม่มี push ย้อนหลัง
8. **Rollback**: คืน .env จากไฟล์สำรอง (หรือตั้ง DRYRUN=true) แล้ว restart; ถ้าต้องย้อน image: ติด tag rollback เป็น `:latest` แล้ว recreate ด้วยพารามิเตอร์เดิม

## ข้อควรระวัง Manager ที่กระทบบอทนี้
- ปุ่ม **"อัปเดต Image" ดึง `:latest` จาก Docker Hub โดยไม่ส่ง registry auth** (ใช้ dockerode `pull` เปล่าๆ): ถ้า image ใหม่ยังไม่ได้ push จะดึงของเก่ามาทับ tag `:latest` ในเครื่อง และ recreate รอบหน้าจะกลับไปใช้ของเก่า; ถ้า repo บน Hub เป็น private ปุ่มจะล้ม (pull access denied) — จึงควร build/tag/recreate เองตามขั้นตอนด้านบน และตรวจ `docker images` ก่อน/หลังเสมอ
- ฟอร์ม bot-config ของ Manager แก้ได้เฉพาะคีย์ใน whitelist `FIELDS` (services/env-config.js); คีย์อื่นใน .env **ถูกรักษาไว้** ตอนบันทึก (แก้เฉพาะบรรทัดตรงกัน ที่เหลือคงเดิม)
- "บันทึก" ไม่ restart; "บันทึกและ Restart" **restart production จริง** — ใช้ด้วยความระมัดระวัง
- ห้ามกด "Attach tunnel" กับ bot itmonitor (ดูหัวข้อคำเตือนด้านล่าง)

## ความปลอดภัยการเผยแพร่ (repo นี้เป็น public)
- ห้ามใส่ข้อมูลภายในใน CLAUDE.md / README / test / ตัวอย่าง: โดเมน tunnel, IP จริง, ชื่อพื้นที่/ชื่อกล้อง/รหัสกล้องจริง, key/secret/token (แม้ท้าย 4 ตัว), LINE userId, path ที่มีชื่อผู้ใช้ Windows — ใช้ข้อมูลสมมติ (เช่น `192.0.2.x`, `example.com`, userId ปลอมแบบ `Uaaa…`) และชื่อกลางแทน
- รายละเอียดภายในที่อยากให้เครื่องนี้จำ → เก็บใน `CLAUDE.local.md` (ไม่ถูก commit)
- ก่อน commit เอกสาร/test: ค้น diff หา IP, โดเมน, ชื่อพื้นที่, รูปแบบ key/token/userId (`git diff | grep -nE …`) — ประวัติ git ที่ push แล้วแก้ย้อนหลังไม่ได้ง่าย

## เครื่องมือทดสอบ (โฟลเดอร์ใหม่ ไม่อยู่ใน production image)
- mock-lab/ — จำลอง Zabbix + Omada Open API + HikCentral (artemis) ให้บอทจริงต่อเข้ามา สถานการณ์เป็น YAML
  (depends_on = ลูกโซ่, flap, zabbix_status ขัดแย้ง, metrics, generate:) ดู mock-lab/README.md
  ของเดิม mock-server/ จำลอง API รุ่นเก่าที่บอทไม่ใช้แล้ว ไม่ได้แก้ (Dockerfile ยัง COPY อยู่)
- ai-comparison/ — ทดลองเปรียบเทียบ Claude/GPT/Gemini 34 เคส สำหรับเล่มสหกิจศึกษา: เฉลยเขียนก่อนรัน (freeze ที่ commit 4543d3b),
  rubric ให้คะแนนด้วยมือแบบปกปิดชื่อ, runner = ai-comparison/tools/run-comparison.js (ดู README ในโฟลเดอร์)
  ข้อควรรู้ของบอทที่พบตอนทำ: correlation ไม่รวมอุปกรณ์ Omada (zone "ไม่ระบุ") และส่ง AI เฉพาะกลุ่ม high,
  จับ subnet ของกล้องได้เฉพาะกล้องที่อยู่ใน Zabbix, กล้องที่อยู่ทั้งสองระบบถูกนับซ้ำ (ตอนทำการทดลอง — แก้แล้ว 2026-10-02 ดูหัวข้อ "Dedup กล้อง"), "กล้องดับ" (Zabbix) อาจขัดกับ "กล้อง" (HikCentral)
- ทดสอบ webhook LINE โดยไม่ส่งข้อความจริง: ส่ง event ที่เซ็น HMAC ด้วย LINE_CHANNEL_SECRET เข้า container แยก
  แล้วดักที่ชั้น @line/bot-sdk (preload) — ห้ามยิงเข้า production webhook ด้วย replyToken ปลอม (push จริงถึง ADMIN ได้)

## ⚠️ คำเตือนสำคัญ: production อยู่ใต้ Manager แต่ tunnel ไม่ได้อยู่ใต้ Manager (อย่าลืม)
production คือ container **netguard-itmonitor** (Manager คุม, ข้อมูลอยู่ในโฟลเดอร์ production ของบอท — path จริงอยู่ใน CLAUDE.local.md และตรวจได้ด้วย docker inspect) ส่วน tunnel จริงคือ
**it-monitor-cloudflared** ซึ่งอยู่ใน docker-compose.yml ของ LineBot (ไฟล์นี้) ไม่ใช่สิ่งที่ Manager สร้าง/จัดการ
(ingress อยู่ในไฟล์ config ของ cloudflared บนเครื่อง ชี้โดเมน tunnel → http://netguard-itmonitor:3000; cloudflared ต่อ netguard-net ด้วย — โดเมนและ path จริงอยู่ใน CLAUDE.local.md (ไม่ถูก commit))
- ห้ามกด "Attach tunnel" กับ bot itmonitor ใน Manager UI — จะสร้าง cloudflared ตัวที่สองซ้อนกับ it-monitor-cloudflared
  (Manager จึงแสดง itmonitor ว่า "ไม่มี tunnel" ตลอด ถือเป็นเรื่องปกติ)
- ห้ามลบ bot itmonitor ผ่าน Manager เล่นๆ — removeBot จะพยายามลบ container ชื่อ netguard-itmonitor-cloudflared ซึ่งไม่มีจริง (ข้ามด้วย 404 ไม่พัง)
  แต่ตัว bot จะหายจาก Manager ทันที ทั้งที่ it-monitor-cloudflared ยังอยู่และยังชี้ไปที่ชื่อ netguard-itmonitor ที่ไม่มีแล้ว → ลูกค้าเข้าไม่ได้
  ลบได้เฉพาะตอนตั้งใจอัปเดต image (ลบแบบไม่ลบไฟล์ แล้วสร้างใหม่ชื่อ/พอร์ตเดิมต่อทันที)
- ห้ามหยุด/ลบ it-monitor-cloudflared — เป็นทางเข้า LINE webhook เพียงทางเดียว
- docker compose up -d ครั้งหน้า (ยังไม่ได้ apply หลังตัด service line-bot ออก): compose จะเตือนว่า it-monitor-bot เป็น orphan และอาจ recreate
  it-monitor-cloudflared (config เปลี่ยน → tunnel หลุดสั้นๆ) ทำตอนมีเวลาเท่านั้น และห้ามใช้ --remove-orphans

## สถานะ (ปรับล่าสุด 2026-10-05 — production อยู่ใต้ Manager)
- production = netguard-itmonitor รัน image ที่ build เองในเครื่องจาก commit ล่าสุด (ยังไม่ได้ push ขึ้น Docker Hub — ดูหัวข้อ deploy) มีฟีเจอร์ Temperature Alarm
  (ส่งจริงแล้ว ตรวจ log ล่าสุด: ไม่มี DRYRUN) และ endpoint /stats/detail ตอบ 200 แล้ว (ตรวจ 2026-10-05); **ยังไม่ยืนยัน** ว่าหน้า "สถิติ" ของ Manager ดึงข้อมูลนี้ครบทุกแท็บ
  daily summary เปิดแล้ว (DAILY_SUMMARY_ENABLED=true, 08:00/17:00 Asia/Bangkok) แก้เวลาผ่าน Manager ได้จริง (ทดสอบแล้ว)
- it-monitor-bot (ตัวเก่า): ตรวจ 2026-10-05 ยังมี container อยู่ในสถานะ exited (restart policy = no) — **ยังไม่ถูกลบ** ทั้งที่ตั้งใจจะลบ; ใช้ rollback ฉุกเฉินได้ (docker update --restart=always it-monitor-bot && docker start it-monitor-bot
  แต่ต้องปิด netguard-itmonitor ก่อน เพราะ LINE webhook/daily summary จะซ้ำ); ผู้ใช้เป็นผู้ตัดสินใจลบ (ตรวจ `docker inspect` หา volume ก่อน)
- รหัส HIKCENTRAL_EVENT_TYPES ของหน้าสถิติ: ตั้งเป็น Temperature Alarm (192517) แล้ว; ใช้กับหน้าสถิติเท่านั้น (ดูหัวข้อ eventRecords)
- ค้างอยู่:
  - รันเปรียบเทียบ AI เต็ม 34 เคส: ต้องมี ANTHROPIC_API_KEY ที่ใช้ได้ (ตอนนี้ 401), OPENAI_API_KEY (ยังไม่มี), และโควตา Gemini
    (เจอ 429/503) แล้วรัน node ai-comparison/tools/run-comparison.js --confirm-full → make-review.js → ให้คะแนนด้วยมือ
  - ผู้จัดทำต้องตรวจเฉลยใน ai-comparison/scenarios/ (ร่างโดย Claude ซึ่งเป็นหนึ่งในสามเจ้าที่เปรียบเทียบ) ก่อนรันเต็ม
  - ยังไม่ได้ทดสอบกับแอป LINE จริง: ack+push ของคำสั่ง AI ทั้ง 9 จุด (ทดสอบผ่านตัวดักที่ชั้น SDK), Claude/OpenAI จริง
  - TEST_CASES.md ยังไม่มีเคส ack+push, guard, timeout, retry/backoff, mock-lab
  - ข้อสังเกตที่ยังไม่สืบสาเหตุ: HikCentral /cameras timeout 10 วินาที (เกิดทุก ~5 นาทีก่อนเครื่อง reboot 2026-10-02 13:01 แต่หลัง reboot ตอบ ~480 ms ไม่ timeout เลย — ยังไม่รู้ว่าหายถาวรไหม), "กล้องดับ" ขัดกับ "กล้อง", /health รายงาน aiProvider เป็น claude แม้ไม่มี key
