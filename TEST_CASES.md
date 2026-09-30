# บทที่ 5 ผลการทดสอบระบบ (Test Cases)

> จัดทำเมื่อ 2026-09-30 — ทุกแถวที่ Result = Pass ผ่านการรันจริงในรอบนี้หรือรอบก่อนหน้าของ session เดียวกัน (ระบุใน Remark)
> แถวที่ไม่ได้ทดสอบจริงระบุตามความจริง: "ทดสอบผ่าน mock เท่านั้น", "ยังไม่ได้ทดสอบ" หรือ "รอตรวจสอบ" — ไม่มีแถวที่เดาผล
> ค่า secret ทั้งหมดถูก mask เป็น `***` · "lab" = อุปกรณ์จริงของผู้พัฒนา (Zabbix 1 เครื่อง, Omada AP 2 ตัว, HikCentral กล้อง 5 ตัว ส่วนใหญ่ออฟไลน์ขณะทดสอบ)
> คำว่า "ทดสอบใน container แยก" = สร้าง container ชั่วคราวชื่อ qa-* / netguard-qa-* (ลบทิ้งหลังทดสอบ) ไม่แตะ bot หรือ Manager ใช้งานจริง

## 5.1 ผลการทดสอบระบบฝั่งผู้ดูแลระบบ (NetGuard Manager Dashboard)

### 5.1.1 Dashboard และ UI (ทดสอบบน Manager จริง พอร์ต 8080 ด้วย Edge headless + puppeteer)

| # | Item | Expected Result | Test Data | Result | Remark |
|---|------|-----------------|-----------|--------|--------|
| 1 | แสดงตาราง bot | จำนวนแถวในตาราง = จำนวน bot ที่ /api/bots คืน | bot: netguard-test (1 ตัว) | Pass | 2026-09-30 |
| 2 | ค้นหา bot | พิมพ์ "test" → 1 แถว, พิมพ์คำที่ไม่มี → 0 แถว, ล้างคำ → กลับมา 1 แถว | คำค้น: "test", "zzzz-none", "" | Pass | 2026-09-30 (ทดสอบหลัง recreate bot) |
| 3 | AI provider badge | badge ตรงกับ aiProvider จาก /stats ของ bot | live-stats.aiProvider = claude → badge "Claude" | Pass | 2026-09-30 ทดสอบหลายรอบ ตรงกันทุกรอบ |
| 4 | System chips 3 สถานะ (เขียว/แดง/เทา) | เขียว = monitor ปกติ, แดง = monitor อยู่ใน failed[], เทา = ไม่ได้เปิดใช้ | bot ปกติ: Zabbix เขียว rgb(46,204,143), Omada/HikCentral เทา rgb(37,44,58) · bot ทดสอบ (Zabbix URL ชี้ 10.255.255.1): Zabbix แดง rgb(255,92,92) | Pass | 2026-09-30 เขียว/เทาบน 8080; แดงใน container แยก netguard-qa-red + Manager ชั่วคราว (เพราะ bot จริงไม่มี monitor ล้มเหลว) |
| 5 | เมนู kebab แสดงชื่อ "⚙ API" | ข้อความปุ่มเป็น "⚙ API" (เดิม "ตั้งค่า (.env)") | คลิก ⋮ ที่แถว bot | Pass | 2026-09-30 |
| 6 | ชื่อ modal และ badge ในหน้า API | title = "API — <ชื่อ bot>", badge = "พร้อมใช้ ✓" / "ยังไม่พร้อม" | bot test: LINE/Zabbix/AI พร้อมใช้, Omada/HikCentral ยังไม่พร้อม | Pass | 2026-09-30 |
| 7 | Modal แก้ไขข้อมูลลูกค้า: เปิด/ปิด | เปิดได้ แสดงค่าเดิม ("ลองดู จำกัด") ปิดได้ทั้งปุ่ม × และ "ยกเลิก" | kebab → แก้ไขข้อมูลลูกค้า | Pass | 2026-09-30 |
| 8 | Modal แก้ไขข้อมูลลูกค้า: บันทึก | กด "บันทึก" ด้วยค่าเดิม → modal ปิด ไม่มี error | bot test (สำรอง meta.json ไว้ก่อน) | Pass | 2026-09-30 — พบพฤติกรรม: writeMeta อัปเดต updatedAt และเพิ่มฟิลด์ว่าง 4 ตัว ทำให้ไฟล์ไม่เหมือนเดิมทุก byte (เป็นพฤติกรรมเดิมของระบบ ไม่ใช่บั๊ก) กู้คืนไฟล์จากสำรองแล้ว |
| 9 | วิดีโอพื้นหลัง | วิดีโอเล่นอยู่จริง (paused=false, currentTime เดิน) | bg-video.mp4, readyState=4, currentTime 14.92→16.82 วินาที | Pass | 2026-09-30 |
| 10 | มาสคอต: เคลื่อนไหว | ตำแหน่ง x เปลี่ยนต่อเนื่องใน 9 วินาที | ตัวอย่าง x: 481→546→609→671→736→800 | Pass | 2026-09-30 |
| 11 | มาสคอต: ตอบสนองการคลิก | คลิกแล้วเล่นท่า jump-spin | คลิกที่ #mascotSvg | Pass | 2026-09-30 |
| 12 | มาสคอต: สวิตช์ปิด/เปิด | ปิดแล้วซ่อน เปิดแล้วแสดงกลับ | กด #mascotToggle 2 ครั้ง | Pass | 2026-09-30 |
| 13 | ไม่มี JavaScript error | pageerror = 0 ตลอดการทดสอบทั้งหมด | ทุกหน้าที่เปิด | Pass | 2026-09-30 |

### 5.1.2 หน้า API (config modal) และการจัดการ .env

| # | Item | Expected Result | Test Data | Result | Remark |
|---|------|-----------------|-----------|--------|--------|
| 1 | ซ่อนค่า secret เมื่ออ่าน config | ตอบเฉพาะ {set:true, hint:"••••" + 4 ตัวท้าย} ห้ามมีค่าเต็ม | ZABBIX_API_TOKEN=abcdef123456 (ปลอม), ANTHROPIC_API_KEY=sk-ant-***9999 → hint ••••3456 / ••••9999 | Pass | 2026-09-30 — ทดสอบใน Manager ชั่วคราวกับโฟลเดอร์ bot ปลอม, response ไม่มีค่าเต็ม |
| 2 | ช่อง secret ใน modal ไม่แสดงค่าเดิม | value ว่าง, placeholder แสดง hint + "(ตั้งค่าแล้ว เว้นว่างถ้าไม่แก้)", type=password | bot ปลอม qa-red | Pass | 2026-09-30 |
| 3 | ซ่อน/แสดงช่อง API key ตาม AI provider | เลือก claude → เห็นเฉพาะช่อง Anthropic; gemini → เฉพาะ Gemini; openai → เฉพาะ OpenAI | สลับ dropdown AI_PROVIDER 3 ค่า | Pass | 2026-09-30 (claude=shown,gemini=hidden,openai=hidden ฯลฯ) |
| 4 | กัน newline injection ใน .env | ค่าที่มี \n ถูกกรอง ไม่สร้าง key ใหม่ในไฟล์ | ZABBIX_URL="https://new.example/api\nEVIL_KEY=1" | Pass | 2026-09-30 — ไม่มีบรรทัด EVIL_KEY= แยกในไฟล์ |
| 5 | ตรวจ scheme ของ URL | ค่าที่ไม่ขึ้นต้น http(s):// ถูกปฏิเสธ 400 | ZABBIX_URL="ftp://x" | Pass | 2026-09-30 |
| 6 | secret ว่าง = ไม่แตะค่าเดิม / null = ลบ | ส่ง "" → ค่าเดิมยังอยู่; ส่ง null → ค่าถูกลบ | ZABBIX_API_TOKEN: "" แล้ว null | Pass | 2026-09-30 |
| 7 | ไม่ log ค่า secret | log ของ Manager มีเฉพาะชื่อ key ที่เปลี่ยน | ค้นหา abcdef123456 / QAKEY9999 ใน docker logs | Pass | 2026-09-30 — 0 ครั้ง (log: "config updated for qa-bot: ZABBIX_URL") |
| 8 | กัน path traversal ที่ชื่อ bot | ชื่อ bot ที่ไม่ผ่านรูปแบบ → 400 | %2e%2e%2f%2e%2e%2fetc, ..%2fqa-bot, a%2fb | Pass | 2026-09-30 — ต้องใช้ %2e%2e%2f เพราะ curl ตัด ../ ก่อนถึง server |
| 9 | Password field แบบ dynamic ใน modal: autocomplete | ช่อง password ทั้ง 8 ช่องมี autocomplete="new-password" และช่องค้นหามี autocomplete="off", name="bot-table-filter", data-lpignore/1p-ignore | ตรวจ DOM หลังเปิด modal | Pass | 2026-09-30 — ตรวจ attribute ด้วย DOM · ยังไม่ commit ณ วันที่จัดทำ (index.html, login.html, modals.js) |
| 10 | Browser autofill ไม่ใส่รหัสผ่านลงช่องค้นหา | ช่องค้นหาว่างหลัง login/เปิด modal บน Chrome | ล้างรหัสที่บันทึกของ localhost:8080 แล้ว login ใหม่ | Pass (ตามที่ผู้ใช้รายงาน) | ผู้ใช้เป็นผู้ทดสอบบน Chrome จริง ผู้เขียนไม่ได้สังเกตผลเอง (headless Edge ไม่มี password manager) — ตรวจได้เฉพาะ attribute ใน DOM |

### 5.1.3 ปุ่ม "ทดสอบการเชื่อมต่อ" (Manager → bot → ระบบปลายทาง)

| # | Item | Expected Result | Test Data | Result | Remark |
|---|------|-----------------|-----------|--------|--------|
| 1 | Zabbix: ค่าถูกต้อง | แสดง ✓ สีเขียว "เชื่อมต่อสำเร็จ" | URL/Token จริงของ lab (token: ***) | Pass | 2026-09-30 — ผ่าน Manager 8080 → bot test (image ใหม่) → Zabbix จริง สี rgb(46,204,143) |
| 2 | Zabbix: token ผิด | แสดง ✗ สีแดง ข้อความไทย | URL จริง + token "wrong-token" | Pass | 2026-09-30 — "API Tokenไม่ถูกต้อง หรือไม่มีสิทธิ์" สี rgb(255,92,92) |
| 3 | Zabbix: URL ไม่มีอยู่จริง | ✗ สีแดง ไม่ใช่ stack trace | http://zabbix.invalid.example | Pass | 2026-09-30 — "ไม่พบเซิร์ฟเวอร์ ตรวจสอบ URL" |
| 4 | Omada: ค่าผิด | ✗ สีแดง ข้อความไทย | URL https://127.0.0.1:9, omadacId/clientId/secret = abc/abc/*** | Pass | 2026-09-30 — "เชื่อมต่อไม่ได้ ตรวจสอบ URL และเครือข่าย" |
| 5 | HikCentral: ค่าผิด | ✗ สีแดง ข้อความไทย | URL http://hik.invalid.example, key/secret = k/*** | Pass | 2026-09-30 — "ไม่พบเซิร์ฟเวอร์ ตรวจสอบ URL" |
| 6 | Omada / HikCentral: ค่าว่าง | ไม่ยิง request แสดงข้อความเตือนสีเหลือง | ทุกช่องว่าง | Pass | 2026-09-30 — Omada: "ทดสอบด้วยค่าที่บันทึกไว้แล้วไม่ได้..." (มีค่าเดิมซ่อนอยู่), HikCentral: "กรุณากรอกค่าก่อนทดสอบ" · ค่าว่างขึ้นสีเหลืองโดยออกแบบ ไม่ใช่สีแดง |
| 7 | Secret ที่มีค่าเดิมซ่อนอยู่และยังไม่กรอกใหม่ | ไม่ยิง request แสดงเหลือง "ทดสอบด้วยค่าที่บันทึกไว้แล้วไม่ได้ กรุณากรอกค่าใหม่ก่อนทดสอบ" | ช่อง Zabbix token ว่างแต่ set=true | Pass | 2026-09-30 — requests ที่ส่งจริง = 0 |
| 8 | กลุ่ม AI: อ่านค่า dropdown ปัจจุบัน | ส่ง system ตาม provider ที่เลือก ไม่ hardcode | เลือก gemini + key ปลอม | Pass | 2026-09-30 — request เป็น system=gemini, ผล "API Keyไม่ถูกต้อง หรือไม่มีสิทธิ์" · เลือก openai แต่ไม่กรอก key → เตือนเหลือง ไม่ยิง |
| 9 | ทดสอบ bot ที่ Stop อยู่ | ตอบ "Bot ไม่ได้ทำงานอยู่ ต้อง Start ก่อนทดสอบ" | container ที่สถานะ Exited | Pass | 2026-09-30 — ทดสอบด้วย API ใน Manager ชั่วคราว |
| 10 | ทดสอบ bot ที่ยังใช้ image เก่า (ไม่มี /test-connection) | ตอบ "ติดต่อ bot ไม่ได้ ลองใหม่อีกครั้ง" ไม่ crash | netguard-test ก่อน recreate (image 57de69f76fa0) | Pass | 2026-09-30 |
| 11 | Validate input ของ API | system ผิด / config ว่าง → 400 ข้อความไทย; bot ไม่มี → 404 "ไม่พบ bot" | system="nope"; config={}; id="deadbeef" | Pass | 2026-09-30 |
| 12 | ไม่ log secret ที่ใช้ทดสอบ | log เก็บแค่ bot=<id> system=<x> | ค้นหา token จริง, tunnel token, "wrong-token" ใน log Manager/bot/cloudflared | Pass | 2026-09-30 — 0 ครั้งในทุก container |

### 5.1.4 บริการทดสอบการเชื่อมต่อฝั่ง bot (unit test ด้วย mock)

| # | Item | Expected Result | Test Data | Result | Remark |
|---|------|-----------------|-----------|--------|--------|
| 1 | zabbix | สำเร็จ → ok: true | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 2 | zabbix | 401 → ok: false ข้อความไทย ไม่ throw ไม่หลุดข้อความดิบ | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 3 | zabbix | 404 → ok: false ข้อความไทย ไม่ throw ไม่หลุดข้อความดิบ | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 4 | zabbix | timeout → ok: false ข้อความไทย ไม่ throw ไม่หลุดข้อความดิบ | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 5 | zabbix | ENOTFOUND → ok: false ข้อความไทย ไม่ throw ไม่หลุดข้อความดิบ | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 6 | zabbix | error แปลกๆ → ok: false ข้อความไทย ไม่ throw ไม่หลุดข้อความดิบ | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 7 | omada | สำเร็จ → ok: true | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 8 | omada | 401 → ok: false ข้อความไทย ไม่ throw ไม่หลุดข้อความดิบ | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 9 | omada | 404 → ok: false ข้อความไทย ไม่ throw ไม่หลุดข้อความดิบ | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 10 | omada | timeout → ok: false ข้อความไทย ไม่ throw ไม่หลุดข้อความดิบ | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 11 | omada | ENOTFOUND → ok: false ข้อความไทย ไม่ throw ไม่หลุดข้อความดิบ | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 12 | omada | error แปลกๆ → ok: false ข้อความไทย ไม่ throw ไม่หลุดข้อความดิบ | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 13 | hikcentral | สำเร็จ → ok: true | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 14 | hikcentral | 401 → ok: false ข้อความไทย ไม่ throw ไม่หลุดข้อความดิบ | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 15 | hikcentral | 404 → ok: false ข้อความไทย ไม่ throw ไม่หลุดข้อความดิบ | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 16 | hikcentral | timeout → ok: false ข้อความไทย ไม่ throw ไม่หลุดข้อความดิบ | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 17 | hikcentral | ENOTFOUND → ok: false ข้อความไทย ไม่ throw ไม่หลุดข้อความดิบ | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 18 | hikcentral | error แปลกๆ → ok: false ข้อความไทย ไม่ throw ไม่หลุดข้อความดิบ | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 19 | field ที่ขาด | ไม่เรียกเครือข่าย และไม่ throw | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 20 | zabbix | เติม /api_jsonrpc.php เมื่อกรอกแค่ base URL และใช้ token ที่ส่งมา | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 21 | zabbix | Zabbix error ใน body (Not authorized) → ข้อความไทย | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 22 | omada | errorCode ≠ 0 → ok:false และส่ง credential ที่ทดสอบไปตรงๆ | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 23 | testAiProvider | claude สำเร็จ | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 24 | testAiProvider | gemini สำเร็จ | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 25 | testAiProvider | openai สำเร็จ | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 26 | testAiProvider | claude 401/404/timeout | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 27 | testAiProvider | gemini 401/404/timeout | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 28 | testAiProvider | openai 401/404/timeout | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 29 | testAiProvider | ไม่รู้จัก provider | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 30 | provider รับ apiKey ตรง (ไม่อ่าน env) | openai ใช้ key ที่ส่งมา | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 31 | provider รับ apiKey ตรง (ไม่อ่าน env) | maxAttempts:1 → ไม่ retry | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 32 | provider ไม่ใส่ response body ใน Error (กัน key หลุดลง log) | openai | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 33 | provider ไม่ใส่ response body ใน Error (กัน key หลุดลง log) | gemini | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 34 | provider ไม่ใส่ response body ใน Error (กัน key หลุดลง log) | gemini 400 → ข้อความไทยเรื่อง key | mock ใน tests/connection-test.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |

### 5.1.5 การ Deploy

| # | Item | Expected Result | Test Data | Result | Remark |
|---|------|-----------------|-----------|--------|--------|
| 1 | Build และ push image ใหม่ | push สำเร็จ ได้ digest | phattadol358/netguard-ai:latest | Pass | 2026-09-30 — digest sha256:71e6025178f2…157715 |
| 2 | ทดสอบ image ก่อน push (container แยก) | /health ตอบปกติ และ /test-connection ตอบ {ok:false, message ไทย} ไม่ใช่ 404 | พอร์ต 13100, POST zabbix url=http://invalid token=*** | Pass | 2026-09-30 — "ไม่พบเซิร์ฟเวอร์ ตรวจสอบ URL" (200) |
| 3 | Recreate bot แบบไม่ลบไฟล์ | DELETE ?deleteFiles=false → 200; สร้างใหม่ชื่อ/พอร์ตเดิม + tunnel token เดิม → 201 | bot test พอร์ต 3100 | Pass | 2026-09-30 — .env และ meta.json เหมือนเดิมทุก byte (cmp) |
| 4 | container ใช้ image ล่าสุดหลัง recreate | docker inspect .Image ตรงกับ image ล่าสุดใน docker images | ก่อน: sha256:57de69f76fa0 → หลัง: sha256:71e6025178f2… | Pass | 2026-09-30 — เทียบ image ID เต็ม 64 ตัวอักษร ไม่ได้เชื่อ toast |
| 5 | tunnel ทำงานหลัง recreate | netguard-test-cloudflared ทำงาน | ตรวจสถานะ container | Pass | 2026-09-30 — Up |
| 6 | ยืนยัน restart ไม่สลับ image (บั๊กย้อนหลัง) | container เก่า restart แล้วยังใช้ image เดิม; ต้อง recreate จึงสลับ | netguard-test ก่อน recreate ใช้ 57de69f76fa0 แม้มี image ใหม่ใน local | Pass | 2026-09-30 — สอดคล้องกับ CLAUDE.md · การ "restart แล้วไม่สลับ" ยืนยันจากสถานะก่อน recreate ไม่ได้สั่ง restart เพื่อพิสูจน์ซ้ำ |

### 5.1.6 ความปลอดภัย (Security)

| # | Item | Expected Result | Test Data | Result | Remark |
|---|------|-----------------|-----------|--------|--------|
| 1 | Rate limit หน้า login | ผิด 5 ครั้งแรกได้ 401, ครั้งที่ 6 ขึ้นไปได้ 429 | POST /api/auth/login รหัสผิด 7 ครั้ง | Pass | 2026-09-30 — Manager ชั่วคราว (พอร์ต 8082) · ครั้งที่ 6,7 = 429 |
| 2 | Rate limit บล็อกแม้ใช้รหัสถูก | หลังโดนบล็อก รหัสถูกก็ได้ 429 | login ด้วยรหัสถูกต้องหลังผิด 7 ครั้ง | Pass | 2026-09-30 — 429 "Too many login attempts" |
| 3 | Network guard: IP ที่อนุญาต | อนุญาต 127.0.0.1, ::1, 10/8, 172.16/12, 192.168/16, Tailscale 100.64/10 | 127.0.0.1, ::1, 10.1.2.3, 172.16.0.5, 192.168.50.9, 100.64.0.1, 100.127.255.1, ::ffff:192.168.1.5 | Pass | 2026-09-30 — เรียก networkGuard() ตรงใน container แยก |
| 4 | Network guard: IP ที่บล็อก | ตอบ 403 | 172.32.0.5, 100.128.0.1, 8.8.8.8, 203.0.113.5, ::ffff:8.8.8.8, fe80::1 | Pass | 2026-09-30 — ทดสอบด้วยการเรียกฟังก์ชันตรง เพราะจำลอง IP ภายนอกผ่าน HTTP จากเครื่องนี้ไม่ได้ |
| 5 | ส่ง X-Forwarded-For ปลอม | header ไม่ถูกเชื่อถือ (ไม่ตั้ง trust proxy) | X-Forwarded-For: 8.8.8.8 จาก LAN | Pass | 2026-09-30 — ได้ 200 (ตัดสินจาก IP ของ socket) แต่ไม่ได้พิสูจน์การบล็อกจากภายนอกจริง |
| 6 | ไฟล์หน้า dashboard ต้อง login | / และ /index.html โดยไม่มี cookie → redirect ไป login; /api/bots → 401 | ไม่แนบ cookie | Pass | 2026-09-30 — 302 → /login.html, 302, 401 |
| 7 | ไฟล์ static JS เข้าถึงได้โดยไม่ login | ควรบล็อกหรือยอมรับอย่างมีเหตุผล | GET /js/modals.js ไม่มี cookie | รอตรวจสอบ | 2026-09-30 — ได้ 200 (เปิดให้อ่านได้) โค้ดฝั่ง client ไม่มี secret แต่เปิดเผยโครงสร้าง UI/API · เป็นพฤติกรรมเดิม ยังไม่ได้ตัดสินใจว่าจะปิดหรือไม่ |
| 8 | /test-connection ของ bot จำกัดเฉพาะ LAN | IP นอก LAN โดน lanOnly บล็อก (กัน SSRF) | ใส่ setupAuth.lanOnly ที่ route | ทดสอบผ่านการอ่านโค้ดเท่านั้น | 2026-09-30 — เรียกจริงจาก LAN สำเร็จ แต่ยังไม่ได้ทดสอบกรณีถูกบล็อกจาก IP นอก LAN |

### 5.1.7 การจัดการข้อผิดพลาด (Error Handling)

| # | Item | Expected Result | Test Data | Result | Remark |
|---|------|-----------------|-----------|--------|--------|
| 1 | Monitor timeout ไม่ทำให้ /health พัง | /health ตอบ 200 ทันที | bot ใน container แยก, ZABBIX_URL=http://10.255.255.1 (ไม่ตอบ) | Pass | 2026-09-30 — 200 ใน 0.004 วินาที |
| 2 | Monitor timeout ไม่ทำให้ /stats พัง | /stats ตอบ 200 พร้อม partial:true, failed:["zabbix"] | เหมือนข้างบน | Pass | 2026-09-30 — 200 ใน 4.01 วินาที (timeout ต่อ monitor 4 วินาที); เรียกซ้ำได้จาก cache 10 วินาที ใน 0.006 วินาที |
| 3 | Manager แสดงผล monitor ที่ล้มเหลว | chip Zabbix เป็นสีแดง (ไม่ใช่ "ไม่มีข้อมูล") | bot netguard-qa-red | Pass | 2026-09-30 — ข้อมูลมาทันภายใน timeout ของ Manager (6 วินาที) |
| 4 | Container restart อัตโนมัติเมื่อ process crash | restart policy=always ทำให้ container กลับมา และ /health ตอบ 200 | kill -9 process node ภายใน container (RestartCount 0→1) | Pass | 2026-09-30 — กลับมาใน ~9 วินาที · หมายเหตุ: "docker kill" จากภายนอกไม่ trigger restart เพราะ Docker ถือเป็นการหยุดด้วยมือ |
| 5 | Manager ไม่สามารถติดต่อ bot | ไม่ crash แสดงข้อความไทย | Manager ที่ไม่อยู่ใน netguard-net (พลาดตอนตั้ง container ทดสอบ) | Pass | 2026-09-30 — live-stats คืน null ใน ~10 วินาที, chip เป็นเทา (แสดงเป็น 'ไม่มีข้อมูล') |

### 5.1.8 บั๊กที่เคยพบและแก้แล้ว (ทดสอบย้อนหลัง)

| # | Item | Expected Result | Test Data | Result | Remark |
|---|------|-----------------|-----------|--------|--------|
| 1 | Restart ไม่สลับ image | ต้อง remove+create จึงใช้ image ใหม่ และตรวจได้ด้วย image ID | ดู 5.1.5 แถวที่ 4 | Pass | 2026-09-30 — แหล่ง: CLAUDE.md (Manager) |
| 2 | API key หลุดใน error log (พบระหว่างทดสอบ) | Error จาก provider ไม่มี response body; log ไม่มี key | key ปลอม 4 ตัว (sk-bad2, AIza…, sk-ant-…, sk-proj-…) แล้ว grep logs/ | Pass | 2026-09-30 — พบบั๊กก่อนแก้: OpenAI สะท้อน "sk-bad" ลงไฟล์ log · แก้แล้วใน commit 62c52e4 · ลบ log เก่า 2 บล็อกแล้ว grep "sk-\|AIza" ไม่พบ |
| 3 | Timeout ฝั่ง Manager ต้องยาวกว่า timeout ของ bot | timeout ของ Manager > เวลาที่ bot ใช้จริง | bot /stats ใช้ 4.01 วินาที < Manager 6 วินาที; test-connection Manager 20 วินาที > bot สูงสุด 15 วินาที | Pass | 2026-09-30 — ตรวจค่าคงที่จากโค้ดและวัดเวลาจริงของ /stats · ยังไม่ได้ทดสอบกรณี AI ช้าจน 15 วินาที |
| 4 | Zabbix ไม่คืน host-level "available" | อ่านสถานะจาก main interface (interfaces[]) แทน | host มี interfaces[0].available=1/2; ไม่มี interfaces; main อยู่ตัวที่ 2 | Pass | 2026-09-30 — ครอบคลุมด้วย unit test (ดู 5.2.5) แก้ใน commit ab57af7, f65dfa6 · ทดสอบผ่าน mock + ผลจริงจาก Zabbix lab (host 13 เครื่อง) |
| 5 | /stats ไม่แช่ผลบางส่วนไว้นาน | partial cache 10 วินาที ไม่ใช่ 60 | monitor ล้มเหลว → เรียก /stats 2 ครั้ง | Pass | 2026-09-30 — commit ab57af7 |
| 6 | Browser autofill ใส่รหัสผ่านลงช่องค้นหา | ช่องค้นหาไม่ถูกเติม | ดู 5.1.2 แถวที่ 10 | Pass (ตามที่ผู้ใช้รายงาน) | ผู้เขียนยืนยันเองไม่ได้ (ดูหมายเหตุที่ 5.1.2) |
| 7 | Native module (better-sqlite3) ต้องทำงานใน image | Manager เริ่มได้และ stats-db ทำงาน | build image ใหม่ แล้วดู log | Pass | 2026-09-30 — log: "stats-db: rollupDaily(2026-09-29) — 1 bot(s)" ไม่ segfault (ป้องกันด้วย .dockerignore ตาม CLAUDE.md) |
| 8 | ค่า OMADA_URL เพี้ยนใน bots/test/.env | ค่าต้องเป็น URL เดียว | ตรวจ bots/test/.env (mask) | ยังไม่แก้ | 2026-09-30 — ยังพบรูปแบบ "OMADA_URL=…OMADA_URL=…" (ค้างมาก่อน ไม่อยู่ใน scope) ควรแก้ก่อนส่งงาน |

## 5.2 ผลการทดสอบระบบฝั่งผู้ใช้งาน (LINE Bot)

### 5.2.1 คำสั่งผ่าน LINE (Functional) — ทดสอบจริงใน container แยก

> วิธีทดสอบ: รัน image ปัจจุบัน (พอร์ต 13200) ด้วย .env ของ lab (Zabbix/Omada/HikCentral จริง แบบอ่านอย่างเดียว) ส่ง webhook ที่เซ็น HMAC-SHA256 ด้วย LINE_CHANNEL_SECRET จริง (***) จาก user ปลอมระดับ ADMIN และดักการตอบกลับที่ชั้น LINE SDK จึง**ไม่มีข้อความถูกส่งเข้า LINE จริง** — ตรวจจากเนื้อหา Flex Message ที่ bot สร้าง ไม่ได้ดูบนแอป LINE

| # | Item | Expected Result | Test Data | Result | Remark |
|---|------|-----------------|-----------|--------|--------|
| 1 | help | ตอบเมนูคำสั่ง (Flex) | ข้อความ: "help" (ADMIN) | Pass | 2026-09-30 — Flex 5,436 ไบต์ หัวข้อ "รายการคำสั่งทั้งหมด" |
| 2 | alert | สรุปแจ้งเตือนที่ยัง active | ข้อความ: "alert" | Pass | 2026-09-30 — "พบ 7 รายการ" (High 5, Average 2) ข้อมูลจริงจาก Zabbix lab |
| 3 | host | แสดงสถานะ host แบบแบ่งหน้า | ข้อความ: "host" | Pass | 2026-09-30 — ทั้งหมด 13 (เชื่อมต่อ 2, ไม่เชื่อมต่อ 11) หน้า 1/2 |
| 4 | wifi | แสดงอุปกรณ์เครือข่ายจาก Omada | ข้อความ: "wifi" | Pass | 2026-09-30 — AP 2 ตัว ออฟไลน์ทั้งคู่ (ตามสถานะจริงของ lab) ยังไม่ได้ทดสอบกับ AP ที่ออนไลน์ |
| 5 | กล้อง | สรุปสถานะกล้องรายไซต์จาก HikCentral | ข้อความ: "กล้อง" | Pass | 2026-09-30 — 5 ตัว ออฟไลน์ 5 (ยังไม่ได้ทดสอบกับกล้องที่ออนไลน์) · ตอบช้า >7 วินาที |
| 6 | กล้องดับ | รายการกล้องออฟไลน์ | ข้อความ: "กล้องดับ" | รอตรวจสอบ | 2026-09-30 — ตอบ "ดับ 0 ตัว ✅ ไม่มีกล้องออฟไลน์" ขัดกับ "กล้อง" (5 ออฟไลน์) และ host list ที่ Camera-01..03 ไม่เชื่อมต่อ · คำสั่งนี้อ่านจาก Zabbix (poller: total=0) ส่วน "กล้อง" อ่านจาก HikCentral · ยังไม่ได้สืบสาเหตุว่าเป็นบั๊กหรือแหล่งข้อมูลต่างกัน |
| 7 | port | เลือก Switch แล้วแสดงพอร์ต | ข้อความ: "port" | Pass | 2026-09-30 — site ไม่มี Switch จึงตอบ "ไม่พบ Switch ใน site นี้" (การจัดการกรณีว่างถูกต้อง) |
| 8 | port แสดงพอร์ตของ Switch จริง | แสดงสถานะพอร์ต/ความเร็ว/PoE | Switch จริง | ทดสอบผ่าน mock เท่านั้น | unit test getSwitchPorts (ดู 5.2.5) — lab ไม่มี Switch |
| 9 | metric <host> | แสดง CPU/RAM/Disk ของ host | ข้อความ: "metric Camera-01" | Pass | 2026-09-30 — host ไม่มี item มาตรฐาน จึงตอบข้อความอธิบายชัดเจน ไม่ crash |
| 10 | metric ของ host ที่มี item ครบ | แสดงค่า CPU/RAM/Disk | host ที่มี system.cpu.util ฯลฯ | ทดสอบผ่าน mock เท่านั้น | unit test getHostMetrics — ยังไม่ได้ทดสอบกับ host จริงที่มี item |
| 11 | client | จำนวน client ที่เชื่อมต่อ | ข้อความ: "client" | Pass | 2026-09-30 — total 0 (lab ไม่มี client) |
| 12 | status | สถานะ monitor แต่ละระบบ | ข้อความ: "status" | Pass | 2026-09-30 — Zabbix "เชื่อมต่อได้" |
| 13 | summary | สรุปภาพรวมทุกระบบ | ข้อความ: "summary" | Pass | 2026-09-30 — Zabbix Host 13 · สถานะ "มีปัญหา" |

### 5.2.2 สิทธิ์และความปลอดภัย

| # | Item | Expected Result | Test Data | Result | Remark |
|---|------|-----------------|-----------|--------|--------|
| 1 | VIEWER ใช้คำสั่ง IT_STAFF ไม่ได้ | ตอบ "คุณไม่มีสิทธิ์ใช้คำสั่งนี้" | user role VIEWER ส่ง "alert" | Pass | 2026-09-30 |
| 2 | VIEWER ใช้ help ได้ (เมนูตามสิทธิ์) | ตอบเมนูที่สั้นกว่า ADMIN | user role VIEWER ส่ง "help" | Pass | 2026-09-30 — 4,768 ไบต์ (ADMIN 5,436 ไบต์) |
| 3 | ปฏิเสธ webhook ที่ลายเซ็นผิด | HTTP 200 แต่ไม่ประมวลผล ไม่มี reply | x-line-signature: AAAA | Pass | 2026-09-30 — log: "Invalid LINE signature — rejected" |
| 4 | Rate limit ต่อ user (10 ข้อความ/นาที) | ข้อความที่ 11 ขึ้นไปได้ข้อความ "ส่งคำสั่งเร็วเกินไป" | ADMIN 1 คนส่ง "help" 12 ครั้งห่างกัน 0.5 วินาที | Pass | 2026-09-30 — ข้อความที่ 11, 12 โดนบล็อก (Flex 1,270 ไบต์) |
| 5 | ไม่มี secret ใน log ของ bot | LINE secret / Zabbix token ไม่ปรากฏใน docker logs | ค้นค่าจริง (***) ใน log ของ container ทดสอบ | Pass | 2026-09-30 — 0 ครั้ง |

### 5.2.3 AI หลาย provider และ fallback

| # | Item | Expected Result | Test Data | Result | Remark |
|---|------|-----------------|-----------|--------|--------|
| 1 | AI_PROVIDER=gemini แต่ไม่มี GEMINI_API_KEY | fallback เป็น claude | AI_PROVIDER=gemini, ANTHROPIC_API_KEY=***, GEMINI_API_KEY=(ไม่ตั้ง) | Pass | 2026-09-30 — /health aiProvider="claude" (ทดสอบใน container แยก + unit test) |
| 2 | AI_PROVIDER=gemini และมี key | ใช้ gemini | AI_PROVIDER=gemini + GEMINI_API_KEY=*** | Pass | 2026-09-30 — aiProvider="gemini" |
| 3 | AI_PROVIDER=openai และมี key | ใช้ openai | AI_PROVIDER=openai + OPENAI_API_KEY=*** | Pass | 2026-09-30 — aiProvider="openai" |
| 4 | ตั้ง provider แต่ไม่มี key เลย | ควรรายงานว่าใช้ AI ไม่ได้ | AI_PROVIDER=gemini ไม่มี key ใดๆ | รอตรวจสอบ | 2026-09-30 — /health รายงาน "claude" ทั้งที่ไม่มี ANTHROPIC_API_KEY (unit test ครอบคลุมเฉพาะกรณี AI_PROVIDER=claude) · ยังไม่ได้ทดสอบว่าเรียกจริงแล้วตอบอย่างไร |
| 5 | เรียก AI จริงด้วย key ที่ใช้ได้ | ได้คำตอบจริง | key จริง | ยังไม่ได้ทดสอบ | ทดสอบเฉพาะ key ปลอม (ได้ "API Keyไม่ถูกต้อง") และ mock — ยังไม่ได้ทดสอบกับ key จริงของ Claude/Gemini/OpenAI |

รายละเอียดการทดสอบ provider ด้วย mock ดูตาราง 5.2.5 หมวด "AI providers"

### 5.2.4 ที่ยังไม่ได้ทดสอบ

| # | Item | Expected Result | Test Data | Result | Remark |
|---|------|-----------------|-----------|--------|--------|
| 1 | ใช้งานผ่านแอป LINE จริง (แสดงผล Flex, quick reply) | ข้อความแสดงถูกต้องบนมือถือ | บัญชี LINE จริง | ยังไม่ได้ทดสอบ | ทดสอบแบบดักที่ชั้น SDK เท่านั้น |
| 2 | Push แจ้งเตือนจาก Zabbix webhook | push ถึงผู้ใช้ตาม role | POST /zabbix-webhook พร้อม shared secret | ยังไม่ได้ทดสอบ | มี commit c98993a เพิ่มการยืนยันตัวตน แต่ไม่ได้ทดสอบซ้ำในรอบนี้ |
| 3 | Uptime/สถิติย้อนหลังใน Manager (SQLite) | สรุป uptime 30 วัน กราฟถูกต้อง | ข้อมูลหลายวัน | ยังไม่ได้ทดสอบ | ทดสอบเฉพาะว่าฐานข้อมูลเริ่มทำงาน (5.1.8) |
| 4 | ทำงานบน Linux server จริง | ทำงานเหมือน Docker Desktop บน Windows | Docker Engine บน Linux | ยังไม่ได้ทดสอบ | CLAUDE.md ระบุว่ายังไม่ได้ทดสอบ |

### 5.2.5 Unit test ของ bot (jest — รันจริง 141/141 ผ่าน)

> Item = ชื่อกลุ่ม test, Expected Result = ชื่อ test (ระบุผลที่ assert), Test Data = ข้อมูลจำลอง (mock) ในไฟล์ test นั้น — ไม่ได้ต่ออุปกรณ์จริงทั้งหมด

#### Validator / Auth / Config (tests/services.test.js) — 23 test

| # | Item | Expected Result | Test Data | Result | Remark |
|---|------|-----------------|-----------|--------|--------|
| 1 | validator › validateIP | ยอมรับ IP ที่ถูกต้องใน prefix | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 2 | validator › validateIP | ปฏิเสธ IP นอก prefix | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 3 | validator › validateIP | ปฏิเสธ IP format ผิด | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 4 | validator › validateIP | ปฏิเสธ octet เกิน 255 | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 5 | validator › validateLineUserId | ยอมรับ LINE UserID ที่ถูกต้อง | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 6 | validator › validateLineUserId | ปฏิเสธ UserID ที่ผิดรูปแบบ | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 7 | validator › validateRole | ยอมรับ role ที่ถูกต้อง | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 8 | validator › validateRole | ปฏิเสธ role ที่ไม่มีอยู่ | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 9 | validator › sanitizeText | ตัด whitespace และจำกัดความยาว | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 10 | validator › isTimestampFresh | ยอมรับ timestamp ที่เพิ่งสร้าง | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 11 | validator › isTimestampFresh | ปฏิเสธ timestamp เก่าเกิน 5 นาที | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 12 | auth › getUserRole | คืน PENDING สำหรับ User ใหม่ที่ยังไม่ได้รับอนุมัติ | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 13 | auth › hasPermission | ADMIN มีสิทธิ์ทุกอย่าง | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 14 | auth › hasPermission | VIEWER ไม่มีสิทธิ์ IT_STAFF | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 15 | auth › hasPermission | IT_STAFF มีสิทธิ์ VIEWER แต่ไม่มีสิทธิ์ ADMIN | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 16 | auth › addUser | ปฏิเสธ LINE UserID ที่ไม่ถูกต้อง | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 17 | auth › addUser | ปฏิเสธ Role ที่ไม่มีอยู่ | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 18 | auth › addUser | เพิ่ม User สำเร็จ | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 19 | auth › PIN session | isPinVerified คืน false ก่อน verify | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 20 | auth › PIN session | isPinVerified คืน true หลัง setPinVerified | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 21 | config | getEnabledMonitors คืน object ที่ถูกต้อง | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 22 | config | ROLES มีครบ 4 roles (รวม PENDING) | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 23 | config | ROLE_HIERARCHY เรียงถูกต้อง (ADMIN อันดับแรก) | mock ใน tests/services.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |

#### AI providers (tests/ai-providers.test.js) — 14 test

| # | Item | Expected Result | Test Data | Result | Remark |
|---|------|-----------------|-----------|--------|--------|
| 1 | ai-providers/index — getProvider() | คืน claude เมื่อ AI_PROVIDER ไม่ได้ตั้งค่า (default) และมี ANTHROPIC_API_KEY | mock ใน tests/ai-providers.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 2 | ai-providers/index — getProvider() | คืน claude เมื่อ AI_PROVIDER=gemini แต่ไม่มี GEMINI_API_KEY (fallback) | mock ใน tests/ai-providers.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 3 | ai-providers/index — getProvider() | คืน claude เมื่อ AI_PROVIDER=openai แต่ไม่มี OPENAI_API_KEY (fallback) | mock ใน tests/ai-providers.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 4 | ai-providers/index — getProvider() | คืน gemini เมื่อตั้งค่าครบ | mock ใน tests/ai-providers.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 5 | ai-providers/index — getProvider() | คืน openai เมื่อตั้งค่าครบ | mock ใน tests/ai-providers.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 6 | ai-providers/index — getProvider() | AI_PROVIDER ตัวพิมพ์ใหญ่ก็ต้องใช้ได้ (case-insensitive) | mock ใน tests/ai-providers.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 7 | ai-providers/index — getProvider() | throw เมื่อไม่มี ANTHROPIC_API_KEY เลย (ไม่มีทาง fallback) | mock ใน tests/ai-providers.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 8 | ai-providers/gemini — parse response ตาม shape จริงของ Gemini API | parse candidates[0].content.parts[0].text + usageMetadata ถูกต้อง, auth ผ่าน query param | mock ใน tests/ai-providers.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 9 | ai-providers/gemini — parse response ตาม shape จริงของ Gemini API | retry 1 ครั้งเมื่อ attempt แรก fail แล้วสำเร็จ attempt 2 | mock ใน tests/ai-providers.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 10 | ai-providers/gemini — parse response ตาม shape จริงของ Gemini API | throw หลัง fail ครบ 2 ครั้ง | mock ใน tests/ai-providers.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 11 | ai-providers/gemini — parse response ตาม shape จริงของ Gemini API | throw เมื่อ response ไม่มี candidates/text (shape ผิดคาด) | mock ใน tests/ai-providers.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 12 | ai-providers/openai — parse response ตาม shape จริงของ OpenAI API | parse choices[0].message.content + usage ถูกต้อง, auth ผ่าน Bearer header | mock ใน tests/ai-providers.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 13 | ai-providers/openai — parse response ตาม shape จริงของ OpenAI API | retry 1 ครั้งเมื่อ attempt แรก fail แล้วสำเร็จ attempt 2 | mock ใน tests/ai-providers.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 14 | ai-providers/openai — parse response ตาม shape จริงของ OpenAI API | throw หลัง fail ครบ 2 ครั้ง | mock ใน tests/ai-providers.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |

#### Monitor adapters (tests/adapters.test.js) — 27 test

| # | Item | Expected Result | Test Data | Result | Remark |
|---|------|-----------------|-----------|--------|--------|
| 1 | ZabbixAdapter › testConnection() | คืน { ok: true } เมื่อ Zabbix ตอบสนอง | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 2 | ZabbixAdapter › testConnection() | คืน { ok: false, message } เมื่อ Zabbix ไม่ตอบสนอง | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 3 | ZabbixAdapter › testConnection() | คืน { ok: false } เมื่อ healthCheck โยน error | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 4 | ZabbixAdapter › getProblems() | คืน array ของ normalized problems | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 5 | ZabbixAdapter › getProblems() | มี field ครบตาม normalized format | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 6 | ZabbixAdapter › getProblems() | ตรวจจับ type "camera" จากชื่อ host ที่ขึ้นต้นด้วย CAM | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 7 | ZabbixAdapter › getProblems() | ตรวจจับ type "host" จากชื่อ SRV-CORE-01 | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 8 | ZabbixAdapter › getProblems() | คืน array เปล่าเมื่อไม่มี problem | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 9 | ZabbixAdapter › getProblems() | โยน error ถ้า service ล้มเหลว (เพื่อให้ caller ใช้ Promise.allSettled) | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 10 | ZabbixAdapter › getDevices() | คืน array ของ normalized devices | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 11 | ZabbixAdapter › getDevices() | มี field ครบตาม normalized format | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 12 | ZabbixAdapter › getDevices() | แปลง available=1 → status "up" | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 13 | ZabbixAdapter › getDevices() | แปลง available=2 → status "down" | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 14 | ZabbixAdapter › getDevices() | ตรวจจับ type "camera" จาก groups "Camera, Floor A" | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 15 | ZabbixAdapter › getDevices() | ตรวจจับ type "switch" จาก groups "Network, Switch" | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 16 | ZabbixAdapter › getDevices() | ตรวจจับ type "host" จาก groups "Servers" | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 17 | OmadaAdapter › testConnection() | คืน { ok: true } เมื่อ login สำเร็จ | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 18 | OmadaAdapter › testConnection() | คืน { ok: false } เมื่อ login ล้มเหลว | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 19 | OmadaAdapter › getProblems() | แปลง Omada alerts เป็น normalized problems | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 20 | OmadaAdapter › getDevices() | แปลง Omada devices (all) เป็น normalized devices | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 21 | HikCentralAdapter › testConnection() | คืน { ok: true } เมื่อ login สำเร็จ | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 22 | HikCentralAdapter › getProblems() | แสดงเฉพาะกล้องที่ offline | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 23 | HikCentralAdapter › getProblems() | คืน array เปล่าเมื่อทุกกล้อง online | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 24 | HikCentralAdapter › getDevices() | แปลงกล้องทั้งหมดเป็น normalized devices | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 25 | BaseMonitorAdapter | โยน Error เมื่อเรียก testConnection โดยตรง | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 26 | BaseMonitorAdapter | โยน Error เมื่อเรียก getProblems โดยตรง | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 27 | BaseMonitorAdapter | โยน Error เมื่อเรียก getDevices โดยตรง | mock ใน tests/adapters.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |

#### Omada / Zabbix / HikCentral / Formatter (tests/new-features.test.js) — 23 test

| # | Item | Expected Result | Test Data | Result | Remark |
|---|------|-----------------|-----------|--------|--------|
| 1 | omada.getAPs() | คืน { aps, switches, gateways, all } แยกตาม type ถูกต้อง | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 2 | omada.getAPs() | วนดึงทุกหน้าจนครบเมื่อ devices เกิน 1 หน้า (regression F-8) | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 3 | omada.getAPs() | ไม่ throw เมื่อไม่มี switch/gateway เลย (edge case) | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 4 | omada.getClients() | คืน { total, wireless, wired, clients[] } พร้อม field fallback | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 5 | omada.getClients() | total = 0 ไม่ throw และคืน array ว่าง (edge case) | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 6 | omada.getClients() | คืน unavailable:true เมื่อ API ล้มเหลว (ไม่ throw ทำให้ client/summary พัง) | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 7 | omada.getSwitchPorts() | map field แบบ flat (linkStatus/linkSpeed/poe ตรงระดับบนสุด) | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 8 | omada.getSwitchPorts() | map field แบบซ้อน portStatus.{linkStatus,linkSpeed,poe} (controller รุ่นอื่น) | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 9 | omada.getSwitchPorts() | normalize MAC ทั้ง : และตัวพิมพ์เล็กเป็นรูปแบบเดียวกัน (- ตัวพิมพ์ใหญ่) ก่อนยิง request | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 10 | omada.getSwitchPorts() | ไม่มี port เลยคืน array ว่าง (edge case) | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 11 | zabbix.getHostMetrics() | คืน { cpu, memory, disk } โดย memory แปลงเป็น % used (100 - pavailable) | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 12 | zabbix.getHostMetrics() | host ไม่มี item CPU/RAM/Disk เลย → คืน null ทั้งหมด ไม่ throw (edge case) | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 13 | zabbix.getHosts() — available มาจาก main interface (host-level available ถูก Zabbix เลิกคืนแล้ว) | host มี interfaces[0].available = 1 → นับเป็น up (available=1) | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 14 | zabbix.getHosts() — available มาจาก main interface (host-level available ถูก Zabbix เลิกคืนแล้ว) | host มี interfaces[0].available = 2 → นับเป็น down (available=2) | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 15 | zabbix.getHosts() — available มาจาก main interface (host-level available ถูก Zabbix เลิกคืนแล้ว) | host ไม่มี interfaces เลย → fallback ใช้ status (monitored=0 → available=1) | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 16 | zabbix.getHosts() — available มาจาก main interface (host-level available ถูก Zabbix เลิกคืนแล้ว) | host มี 2 interfaces, main อยู่ตัวที่ 2 → ต้องอ่าน available จากตัวที่ 2 ไม่ใช่ตัวแรก | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 17 | zabbix.fetchOfflineCamerasRaw() | คืนเฉพาะกล้องที่ available === 2 (filter ฝั่ง client หลังลบ server-side filter ที่ใช้ไม่ได้แล้ว) | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 18 | zabbix.fetchOfflineCamerasRaw() | ไม่มีกล้องในกลุ่มเลย (edge case) → คืนค่าว่างไม่ throw | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 19 | hikcentral.getRegions() + region cache | วนดึงทุกหน้าจนครบและ map indexCode/name ถูกต้อง | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 20 | hikcentral.getRegions() + region cache | cache TTL ทำงาน — ไม่ยิง regions ซ้ำภายใน TTL แต่ยิงใหม่หลังหมดอายุ | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 21 | formatter render — ไม่ throw กับข้อมูลปกติและ edge case | buildClients render ได้ทั้งกรณีมีข้อมูลและว่าง | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 22 | formatter render — ไม่ throw กับข้อมูลปกติและ edge case | buildHostMetrics render ได้ทั้งกรณีมี metric ครบและไม่มีเลย | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 23 | formatter render — ไม่ throw กับข้อมูลปกติและ edge case | buildSwitchPorts render ได้ทั้งกรณีมี port และไม่มี port เลย | mock ใน tests/new-features.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |

#### Stats (/stats) (tests/stats.test.js) — 4 test

| # | Item | Expected Result | Test Data | Result | Remark |
|---|------|-----------------|-----------|--------|--------|
| 1 | buildStats() | คืน shape ถูกต้องเมื่อทุก monitor ทำงานปกติ | mock ใน tests/stats.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 2 | buildStats() | monitor ล้มเหลว 1 ตัว (omada.getAPs ล้มเหลว) → ยังคืนผลลัพธ์ปกติพร้อมค่า 0 ไม่ throw | mock ใน tests/stats.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 3 | buildStats() | ไม่มี monitor เลย → คืน monitors: [] และไม่มี problems/devices | mock ใน tests/stats.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 4 | buildStats() | hikcentral ล้มเหลว/timeout → partial: true, failed: ["hikcentral"], cameras ยังนับจาก zabbix ต่อ | mock ใน tests/stats.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |

#### Correlation (จัดกลุ่มเหตุการณ์ข้ามระบบ) (tests/correlate.test.js) — 16 test

| # | Item | Expected Result | Test Data | Result | Remark |
|---|------|-----------------|-----------|--------|--------|
| 1 | Multi-type alerts in same zone | camera + ap + switch ในโซนเดียว timestamp ห่าง < 120s → high confidence | mock ใน tests/correlate.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 2 | Multi-type alerts in same zone | camera + ap (ไม่มี switch) → high confidence เพราะ multi-type | mock ใน tests/correlate.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 3 | Multi-type alerts in same zone | host อยู่คนเดียวในกลุ่ม + camera → high confidence (infra device) | mock ใน tests/correlate.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 4 | Multi-type alerts in same zone | เรียงกลุ่ม high ก่อน medium | mock ใน tests/correlate.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 5 | Single-type alerts | camera หลายตัวในโซนเดียว → medium confidence | mock ใน tests/correlate.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 6 | Single-type alerts | ap หลายตัวในโซนเดียว → medium confidence | mock ใน tests/correlate.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 7 | No active problems | array เปล่า → คืน [] | mock ใน tests/correlate.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 8 | No active problems | status=up ทั้งหมด → คืน [] | mock ใน tests/correlate.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 9 | No active problems | device คนเดียวในโซน → ไม่สร้างกลุ่ม (ต้องมีอย่างน้อย 2) | mock ใน tests/correlate.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 10 | No active problems | null/undefined input → คืน [] | mock ใน tests/correlate.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 11 | Different zones create separate groups | alert ในโซนต่างกัน → สร้างกลุ่มแยก | mock ใน tests/correlate.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 12 | Timestamp window separation | alert ห่าง > 120s ในโซนเดียวกัน → คนละกลุ่ม | mock ใน tests/correlate.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 13 | Timestamp window separation | alert ห่างพอดี 120s → ยังอยู่กลุ่มเดียวกัน (boundary) | mock ใน tests/correlate.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 14 | Lookback time filter | alert เก่าเกินกว่า lookback → ไม่ถูกรวม | mock ใน tests/correlate.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 15 | Output structure | group มี field ครบตาม spec | mock ใน tests/correlate.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |
| 16 | Output structure | startTime เท่ากับ timestamp ของ alert ที่เก่าสุดในกลุ่ม | mock ใน tests/correlate.test.js | Pass | jest 2026-09-30 (141/141 ผ่าน) — mock only ไม่ได้ต่ออุปกรณ์จริง |

สรุป: ทั้งหมด 141 test ผ่าน 141 ล้มเหลว 0 (รวมตาราง 5.1.4 อีก 34 test)