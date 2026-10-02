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
- deploy production (หลังย้ายเข้า Manager 2026-10-02): docker build → docker push → Manager "อัปเดต Image" (pull)
  → ลบ bot แบบไม่ลบไฟล์แล้วสร้างใหม่ชื่อ/พอร์ตเดิมทันที (ดู "คำเตือนสำคัญ" ด้านล่างก่อนทำ) แล้วเทียบ docker inspect .Image
  กับ docker images --no-trunc; recreate ทำให้ webhook ที่ค้างอยู่ 1-2 วินาทีหายได้ (ขั้นตอน `docker compose up -d --force-recreate line-bot`
  เป็นของ it-monitor-bot เดิม ใช้ไม่ได้อีกแล้ว — service line-bot ถูกตัดออกจาก docker-compose.yml)
- docker kill จากภายนอกไม่ trigger restart policy (ถือเป็น stop ด้วยมือ) — ต้อง kill process ข้างใน container
- Git Bash บน Windows: -e X=/path ใน docker run ถูกแปลงเป็น path ของ Windows → ตั้ง MSYS_NO_PATHCONV=1;
  อย่าใส่ backtick ในสตริงของ node -e (bash รันเป็นคำสั่ง) ให้เขียนสคริปต์เป็นไฟล์แทน
- /test-connection (POST) ใช้ค่าที่ส่งมาตรงๆ ยิงออกไปยัง URL ที่รับมา → จำกัดเฉพาะ LAN (setupAuth.lanOnly) กัน SSRF

## Circuit breaker ของ HikCentral (services/circuit-breaker.js, ครอบที่ hikPost จุดเดียว)
- ล้มเหลวติดกัน 3 ครั้ง (timeout / เครือข่ายขาด / HTTP 5xx) → เปิด 60 วินาที (คำขอล้มทันที ไม่รอ 10 วินาที) → ลอง 1 คำขอ → ปิดเมื่อสำเร็จ;
  ปรับด้วย HIKCENTRAL_BREAKER_THRESHOLD / HIKCENTRAL_BREAKER_COOLDOWN_MS (และ HIKCENTRAL_TIMEOUT_MS สำหรับ timeout ต่อคำขอ)
- ไม่นับ: 4xx, ลายเซ็นผิด, code != 0 ของ artemis (เช่น parameter error ของเราเอง) — เซิร์ฟเวอร์ตอบอยู่ ไม่ใช่ปัญหาความพร้อมใช้งาน
- override (ปุ่ม "ทดสอบการเชื่อมต่อ" ด้วย config ที่ยังไม่บันทึก) ข้าม breaker; ไม่ใช้ข้อมูลเก่าแทนตอน breaker เปิด (ตั้งใจ — ไม่รู้สถานะจริงก็ไม่ควรบอกว่าปกติ)
- สถานะอยู่ใน /stats: `breakers: { hikcentral: "closed" | "open" | "half_open" }` (log เฉพาะตอนเปลี่ยนสถานะ); ทดสอบด้วย mock-lab `POST /mock/fault`

## เครื่องมือทดสอบ (โฟลเดอร์ใหม่ ไม่อยู่ใน production image)
- mock-lab/ — จำลอง Zabbix + Omada Open API + HikCentral (artemis) ให้บอทจริงต่อเข้ามา สถานการณ์เป็น YAML
  (depends_on = ลูกโซ่, flap, zabbix_status ขัดแย้ง, metrics, generate:) ดู mock-lab/README.md
  ของเดิม mock-server/ จำลอง API รุ่นเก่าที่บอทไม่ใช้แล้ว ไม่ได้แก้ (Dockerfile ยัง COPY อยู่)
- ai-comparison/ — ทดลองเปรียบเทียบ Claude/GPT/Gemini 34 เคส สำหรับเล่มสหกิจศึกษา: เฉลยเขียนก่อนรัน (freeze ที่ commit 4543d3b),
  rubric ให้คะแนนด้วยมือแบบปกปิดชื่อ, runner = ai-comparison/tools/run-comparison.js (ดู README ในโฟลเดอร์)
  ข้อควรรู้ของบอทที่พบตอนทำ: correlation ไม่รวมอุปกรณ์ Omada (zone "ไม่ระบุ") และส่ง AI เฉพาะกลุ่ม high,
  จับ subnet ของกล้องได้เฉพาะกล้องที่อยู่ใน Zabbix, กล้องที่อยู่ทั้งสองระบบถูกนับซ้ำ, "กล้องดับ" (Zabbix) อาจขัดกับ "กล้อง" (HikCentral)
- ทดสอบ webhook LINE โดยไม่ส่งข้อความจริง: ส่ง event ที่เซ็น HMAC ด้วย LINE_CHANNEL_SECRET เข้า container แยก
  แล้วดักที่ชั้น @line/bot-sdk (preload) — ห้ามยิงเข้า production webhook ด้วย replyToken ปลอม (push จริงถึง ADMIN ได้)

## ⚠️ คำเตือนสำคัญ: production อยู่ใต้ Manager แต่ tunnel ไม่ได้อยู่ใต้ Manager (อย่าลืม)
production คือ container **netguard-itmonitor** (Manager คุม, ข้อมูลที่ D:\Project Code\bots\itmonitor) ส่วน tunnel จริงคือ
**it-monitor-cloudflared** ซึ่งอยู่ใน docker-compose.yml ของ LineBot (ไฟล์นี้) ไม่ใช่สิ่งที่ Manager สร้าง/จัดการ
(ingress อยู่ที่ C:\Users\phatt\.cloudflared\config.yml: bot.wwwonline.uk → http://netguard-itmonitor:3000; cloudflared ต่อ netguard-net ด้วย)
- ห้ามกด "Attach tunnel" กับ bot itmonitor ใน Manager UI — จะสร้าง cloudflared ตัวที่สองซ้อนกับ it-monitor-cloudflared
  (Manager จึงแสดง itmonitor ว่า "ไม่มี tunnel" ตลอด ถือเป็นเรื่องปกติ)
- ห้ามลบ bot itmonitor ผ่าน Manager เล่นๆ — removeBot จะพยายามลบ container ชื่อ netguard-itmonitor-cloudflared ซึ่งไม่มีจริง (ข้ามด้วย 404 ไม่พัง)
  แต่ตัว bot จะหายจาก Manager ทันที ทั้งที่ it-monitor-cloudflared ยังอยู่และยังชี้ไปที่ชื่อ netguard-itmonitor ที่ไม่มีแล้ว → ลูกค้าเข้าไม่ได้
  ลบได้เฉพาะตอนตั้งใจอัปเดต image (ลบแบบไม่ลบไฟล์ แล้วสร้างใหม่ชื่อ/พอร์ตเดิมต่อทันที)
- ห้ามหยุด/ลบ it-monitor-cloudflared — เป็นทางเข้า LINE webhook เพียงทางเดียว
- docker compose up -d ครั้งหน้า (ยังไม่ได้ apply หลังตัด service line-bot ออก): compose จะเตือนว่า it-monitor-bot เป็น orphan และอาจ recreate
  it-monitor-cloudflared (config เปลี่ยน → tunnel หลุดสั้นๆ) ทำตอนมีเวลาเท่านั้น และห้ามใช้ --remove-orphans

## สถานะ (2026-10-02 — หลังย้าย production เข้า Manager เสร็จสมบูรณ์)
- production = netguard-itmonitor (image phattadol358/netguard-ai:latest เดิม ยังไม่มี /stats/detail จึงยังไม่มีข้อมูลกราฟ Omada/HikCentral ใน Manager)
  daily summary เปิดแล้ว (DAILY_SUMMARY_ENABLED=true, 08:00/17:00 Asia/Bangkok) แก้เวลาผ่าน Manager ได้จริง (ทดสอบแล้ว)
- it-monitor-bot (ตัวเก่า) หยุดไว้ ไม่ได้ลบ restart policy = no (ใช้ rollback ฉุกเฉิน: docker update --restart=always it-monitor-bot && docker start it-monitor-bot
  แต่ต้องปิด netguard-itmonitor ก่อน เพราะ LINE webhook/daily summary จะซ้ำ) กำหนดลบถาวรหลังยืนยันความเสถียรอีก 2-3 วัน (หลัง 2026-10-05)
- ฟีเจอร์ stats แบบแท็บ (/stats/detail) พัฒนาเสร็จและ push แล้ว (d167799, 0391e75, 8452eb6) แต่ยังไม่ deploy/ยังไม่เปิดกับ itmonitor
  — ต้องคุยแยกก่อน; ต้องรู้รหัส HIKCENTRAL_EVENT_TYPES จริงจาก HikCentral console (Event and Alarm → Event Configuration)
- ค้างอยู่:
  - รันเปรียบเทียบ AI เต็ม 34 เคส: ต้องมี ANTHROPIC_API_KEY ที่ใช้ได้ (ตอนนี้ 401), OPENAI_API_KEY (ยังไม่มี), และโควตา Gemini
    (เจอ 429/503) แล้วรัน node ai-comparison/tools/run-comparison.js --confirm-full → make-review.js → ให้คะแนนด้วยมือ
  - ผู้จัดทำต้องตรวจเฉลยใน ai-comparison/scenarios/ (ร่างโดย Claude ซึ่งเป็นหนึ่งในสามเจ้าที่เปรียบเทียบ) ก่อนรันเต็ม
  - ยังไม่ได้ทดสอบกับแอป LINE จริง: ack+push ของคำสั่ง AI ทั้ง 9 จุด (ทดสอบผ่านตัวดักที่ชั้น SDK), Claude/OpenAI จริง
  - TEST_CASES.md ยังไม่มีเคส ack+push, guard, timeout, retry/backoff, mock-lab
  - ข้อสังเกตที่ยังไม่สืบสาเหตุ: HikCentral /cameras timeout 10 วินาที (เกิดทุก ~5 นาทีก่อนเครื่อง reboot 2026-10-02 13:01 แต่หลัง reboot ตอบ ~480 ms ไม่ timeout เลย — ยังไม่รู้ว่าหายถาวรไหม), "กล้องดับ" ขัดกับ "กล้อง", /health รายงาน aiProvider เป็น claude แม้ไม่มี key
