# ชุดทดลองเปรียบเทียบความแม่นยำ AI 3 เจ้า (Claude / GPT / Gemini)

ทดลองแยกต่างหากจากบอทจริง สำหรับเล่มรายงานสหกิจศึกษา: ส่งสถานการณ์จำลองที่มี **เฉลย (ground truth) เขียนไว้ก่อน** ให้ AI แต่ละเจ้าวิเคราะห์ด้วย prompt รูปแบบเดียวกับที่บอทจริงใช้ แล้ว **ให้คะแนนด้วยมือ** ตามเกณฑ์ใน [`RUBRIC.md`](RUBRIC.md)

> **สถานะ: ขั้นที่ 1 เสร็จ (ออกแบบเคส + rubric) — ยังไม่ได้เรียก AI ใดๆ และยังไม่มีสคริปต์เรียก AI**
> ขั้นที่ 2 (สคริปต์รันจริง เสีย API credit) รอการยืนยันว่าเคสและเฉลยใช้ได้

## โครงสร้างโฟลเดอร์

```
ai-comparison/
├─ README.md                  ← ไฟล์นี้
├─ RUBRIC.md                  ← เกณฑ์ให้คะแนน + ตัวอย่าง + ขั้นตอนลดอคติ
├─ scoring-sheet-template.csv ← ใบให้คะแนน
├─ scenarios/                 ← เคสทั้งหมด (YAML 7 ไฟล์ ตามหมวด)
│   ├─ 01-network-down.yaml   ├─ 05-cascade.yaml
│   ├─ 02-camera-offline.yaml ├─ 06-false-alarm.yaml
│   ├─ 03-host-resource.yaml  └─ 07-conflict.yaml
│   └─ 04-flapping.yaml
└─ tools/
    ├─ load.js           ← โหลด YAML (ใช้ js-yaml ที่มีใน node_modules ของโปรเจกต์)
    ├─ render-prompt.js  ← สร้าง prompt แบบเดียวกับบอทจริงจาก input ของเคส (ไม่เรียก AI)
    └─ validate.js       ← ตรวจโครงสร้าง/ความสอดคล้อง + drift check ของ template
```

คำสั่งที่ใช้ได้ตอนนี้ (ไม่เสียเงิน ไม่ยิงเครือข่าย):

```
node ai-comparison/tools/validate.js         # ตรวจทั้งชุด (ตอนนี้: ผ่านหมด 34 เคส)
node ai-comparison/tools/render-prompt.js NET-01   # ดู prompt ที่จะส่งให้ AI สำหรับเคสหนึ่ง
```

## การตัดสินใจออกแบบและเหตุผล

| เรื่อง | ตัดสินใจ | เหตุผล |
|---|---|---|
| ตำแหน่ง | `LineBot/ai-comparison/` (โฟลเดอร์ย่อยใน repo เดิม) | ต้องอ้างอิงรูปแบบ prompt ของ `services/ai.js`/`index.js` และแนบเป็นภาคผนวกของโปรเจกต์เดียวกันได้ แต่แยกโฟลเดอร์ชัดเจนไม่ปนโค้ดบอท; เพิ่ม `ai-comparison` ใน `.dockerignore` เพื่อไม่ให้เฉลย/สคริปต์เข้า production image |
| รูปแบบไฟล์เคส | YAML 1 ไฟล์ต่อหมวด (7 ไฟล์) | มี comment ได้ อ่าน/แก้ด้วยมือง่าย; ไฟล์เดียวรวม 34 เคสยาวเกินไปจนตรวจยาก, 1 ไฟล์ต่อเคส (34 ไฟล์) กระจัดกระจายเกินสำหรับการรีวิวเทียบเคส |
| ข้อมูลจำลอง | ใช้ **ชนิดและรูปแบบสตริงเดียวกับที่บอทจริงส่งให้ AI** | ไม่ทำให้ผลเปรียบเทียบผิดไปจากการใช้งานจริง — มี drift check ตรวจว่าข้อความ template ยังตรงกับซอร์สบอท |
| ชื่อไซต์/อุปกรณ์ | สมมติทั้งหมด (HQ, PLANT, อาคาร B ฯลฯ) | ไม่ใช้ข้อมูลลูกค้าจริง |
| ผู้ให้คะแนน | มนุษย์ ปกปิดชื่อ provider | ตามที่กำหนด ไม่ใช้ AI ตัดสิน |

## ชนิด prompt ที่ใช้ (map ตรงกับการเรียกจริงในบอท)

| `prompt_kind` | การเรียกจริงในบอท | system prompt | max_tokens | ฟิลด์ `input` |
|---|---|---|---|---|
| `analyze_device` | ปุ่ม 🤖 วิเคราะห์ → `handleAnalyze` → `ai.chat(prompt, null, 800)` | `SYSTEM_PROMPT` | 800 | `type,name,ip,status,apContext,cameraContext` (สตริงรูปแบบเดียวกับ `gatherAnalyzeContext`) |
| `camera_single` | `วิเคราะห์กล้อง CAM-xxx` → `ai.chat(prompt)` | `SYSTEM_PROMPT` | 500 | `name,location,status,duration,offlineSince` |
| `alert` | `ai.analyzeAlert(alert)` | `SYSTEM_PROMPT` | 600 | `description,host,priorityLabel,lastChange,comments` |
| `correlation` | `ai.analyzeCorrelation(group)` | `CORRELATION_SYSTEM_PROMPT` (กันเดา) | 600 | `group` (`zone,startTimeText,types,confidence,hasInfraDevice,devices[]`) |
| `context_text` | `วิเคราะห์ host/wifi/กล้อง/summary` → `ai.chat(prompt)` | `SYSTEM_PROMPT` | 500 | `topic` (`host|wifi|camera|summary`), `context` (สตริงแบบ hostCtxText/wifiCtxText/cameraCtxText/summaryCtxText) |

ค่า `confidence` ของ `correlation` ยึดกฎใน `services/correlate.js` (หลายชนิดหรือมี switch/host → `high`, ชนิดเดียวไม่มี infra → `medium`) และ `validate.js` ตรวจให้

## โครงของแต่ละเคส

```yaml
- id: NET-01                 # หมวด-เลขที่
  title: "..."
  category: network_down     # ต้องตรงกับไฟล์
  prompt_kind: analyze_device
  input: { ... }             # ข้อมูลที่ AI จะได้รับ (ตามตารางข้างบน)
  ground_truth:              # เขียนก่อนรัน AI ทุกตัว
    root_cause: ...          # เฉลยต้นตอ (คะแนน A = 2)
    partial_root_cause: ...  # เงื่อนไขได้ A = 1
    wrong_root_cause_examples: [...]   # ตัวอย่างที่ได้ A = 0
    key_evidence: [...]      # ข้อมูลใน input ที่ชี้ไปสู่เฉลย
    severity: low|medium|high|critical
    severity_rationale: ...
    correct_actions: [...]   # ลำดับความสำคัญจากมากไปน้อย
    unacceptable_actions: [...]   # คำแนะนำที่ถือว่าผิด/อันตราย
  design_note: ...           # เคสนี้ทดสอบอะไร
```

## ภาพรวมเคส (34 เคส)

หมวด × ความรุนแรงของเฉลย:

| หมวด | low | medium | high | critical | รวม |
|---|---|---|---|---|---|
| network_down (เครือข่ายล่ม) | 1 | 2 | 1 | 1 | 5 |
| camera_offline (กล้อง) | 1 | 2 | 2 | 0 | 5 |
| host_resource (CPU/RAM/Disk) | 1 | 0 | 2 | 2 | 5 |
| flapping | 1 | 2 | 1 | 0 | 4 |
| cascade (ลูกโซ่) | 0 | 1 | 2 | 3 | 6 |
| false_alarm | 5 | 0 | 0 | 0 | 5 |
| conflict (ข้อมูลขัดแย้ง) | 1 | 2 | 1 | 0 | 4 |
| **รวม** | **10** | **9** | **9** | **6** | **34** |

### รายการเคสทั้งหมด

| ID | ชื่อเคส | ระดับเฉลย | prompt_kind | max_tokens |
|---|---|---|---|---|
| NET-01 | AP ล็อบบี้ดับเครื่องเดียว อุปกรณ์รอบข้างปกติ | medium | analyze_device | 800 |
| NET-02 | Gateway ขอบเครือข่ายล่ม LAN ภายในยังปกติ | critical | context_text | 500 |
| NET-03 | Switch ชั้น 3 ล่ม พา AP 3 ตัวหลุดตาม | high | context_text | 500 |
| NET-04 | AP 2 ตัวชั้นเดียวกันดับพร้อมกัน กล้อง subnet เดียวกันปกติ | medium | analyze_device | 800 |
| NET-05 | AP สำรองในโกดังหลุด (ไม่มีผู้ใช้กระทบ) | low | alert | 600 |
| CAM-01 | กล้องดับเครื่องเดียว กล้องอื่นในไซต์ปกติ | medium | analyze_device | 800 |
| CAM-02 | กล้องภายนอกภาพดำหลังฝนตก (ยัง ping ได้) | medium | alert | 600 |
| CAM-03 | กล้องครึ่งไซต์ (หมายเลข 101-116) ออฟไลน์เป็นช่วงต่อเนื่อง | high | context_text | 500 |
| CAM-04 | กล้องประตูทางเข้าหลักออฟไลน์เกิน 4 วัน | high | camera_single | 500 |
| CAM-05 | กล้องอาคารเก่า (ยังไม่เปิดใช้งาน) ออฟไลน์ 12 วัน | low | camera_single | 500 |
| HOST-01 | CPU สูงต่อเนื่องจากโปรเซส java ตัวเดียว | high | alert | 600 |
| HOST-02 | หน่วยความจำ DB หมด OOM-killer ทำงาน | critical | alert | 600 |
| HOST-03 | Log nginx โตเร็ว ดิสก์ /var/log เหลือ 3.8% เต็มใน ~1.4 ชั่วโมง | high | alert | 600 |
| HOST-04 | ดิสก์ว่าง 18% โตช้า (แจ้งเตือนเชิงวางแผน) | low | alert | 600 |
| HOST-05 | ดิสก์เสื่อม RAID5 degraded ไม่มี hot spare | critical | alert | 600 |
| FLAP-01 | ลิงก์ไฟเบอร์ uplink สะดุด 17 ครั้ง/30 นาที (CRC สูง แสงอ่อน) | high | alert | 600 |
| FLAP-02 | AP สลับ Connected/Disconnected 9 ครั้ง/ชม. (PoE เกือบเต็มขีดจำกัด) | medium | alert | 600 |
| FLAP-03 | กล้อง Online/Offline สลับ 12 ครั้ง/20 นาที (IP ชนกัน) | medium | alert | 600 |
| FLAP-04 | เซิร์ฟเวอร์พิมพ์หายจาก ping ครั้งละไม่ถึง 30 วินาที (ไม่มีผลกระทบ) | low | alert | 600 |
| CAS-01 | Switch ชั้น 2 ล่ม พากล้อง 5 ตัว + AP 2 ตัวหลุดพร้อมกัน (switch อยู่ในรายการ) | high | correlation | 600 |
| CAS-02 | กล้อง 4 + AP 2 ชั้น 3 ดับพร้อมกัน แต่ switch ไม่อยู่ในรายการ (ไม่ได้ monitor) | high | correlation | 600 |
| CAS-03 | อาคาร B: server 2 + กล้อง 4 + AP 3 หายพร้อมกัน (ไฟหรือ uplink ทั้งอาคาร) | critical | correlation | 600 |
| CAS-04 | NVR ล่ม → กล้อง 16 ตัวใน subnet เดียวกันออฟไลน์ตาม | critical | analyze_device | 800 |
| CAS-05 | ทุกระบบล่มกว้าง (hosts 2/13, กล้อง 4/32) — จุดร่วมระดับแกนกลาง | critical | context_text | 500 |
| CAS-06 | กล้อง 6 ตัวโซนเดียวกันหลุดพร้อมกัน แต่มีชนิดเดียว ไม่มี infra (confidence = medium) | medium | correlation | 600 |
| FAL-01 | server ดับตามแผน maintenance window (ป้ายวิกฤต) | low | alert | 600 |
| FAL-02 | CPU สูงเพราะงาน backup รายคืน (baseline เดิมทุกคืน) | low | alert | 600 |
| FAL-03 | กล้องรีบูตตามเวลา 03:00 ทุกวัน (ออฟไลน์ 2 นาที) | low | alert | 600 |
| FAL-04 | Bandwidth uplink พุ่ง 84% เช้าวันจันทร์ทุกสัปดาห์ | low | alert | 600 |
| FAL-05 | เซนเซอร์อุณหภูมิห้องเซิร์ฟเวอร์อ่านค่า 78°C ครั้งเดียว (ป้ายวิกฤต) | low | alert | 600 |
| CON-01 | Zabbix เห็น NVR ออนไลน์ แต่ HikCentral เห็นกล้องใต้ NVR ออฟไลน์ทั้ง 8 ตัว | high | analyze_device | 800 |
| CON-02 | Zabbix ICMP บอกเว็บเซิร์ฟเวอร์ล่ม แต่ agent/HTTP ปกติ (firewall เพิ่งเปลี่ยน) | low | alert | 600 |
| CON-03 | Omada เห็น AP ออนไลน์ (uplink ไร้สาย) แต่ Zabbix เห็นพอร์ตสายแลนของ AP นั้น down | medium | alert | 600 |
| CON-04 | HikCentral เห็นกล้องออนไลน์ แต่ Zabbix เห็น packet loss 62% (เฉพาะกล้องตัวเดียว) | medium | alert | 600 |


## ข้อจำกัดและความเสี่ยงต่อความน่าเชื่อถือ (ควรระบุในเล่มรายงาน)

1. **ผู้เขียนเฉลยคือ AI (Claude) ที่ร่างขึ้นภายใต้การกำกับของผู้ใช้** — Claude เป็นหนึ่งในสามเจ้าที่เปรียบเทียบ จึงมีความเสี่ยงอคติเข้าข้าง (เช่น รูปแบบการให้เหตุผลที่คุ้นเคย) ข้อควรทำ: ผู้จัดทำรายงาน **ตรวจและแก้เฉลยทุกเคสด้วยความรู้ของตนเอง** ก่อนรัน แล้วระบุในเล่มว่าเฉลยร่างด้วย AI และผ่านการทบทวนโดยมนุษย์; เฉลยถูกเขียนก่อนมีคำตอบของ AI ใดๆ (ไม่ปนเปื้อนจากคำตอบ) และการให้คะแนนปกปิดชื่อ provider
2. **ข้อมูลเป็นข้อมูลจำลอง** ไม่ใช่ log จริงจากระบบลูกค้า — ผลบอกความสามารถในสถานการณ์ที่ออกแบบ ไม่ใช่ความแม่นยำบนหน้างานทั้งหมด
3. **เคสหมวด host_resource และ flapping ใส่ค่าที่วัดได้/ประวัติไว้ในฟิลด์ `comments`** เพราะ prompt จริงของบอทมีข้อความอิสระฟิลด์เดียว (บอทปัจจุบันยังไม่ส่งค่าเหล่านี้ให้ AI) ควรระบุในเล่มว่าการทดลองให้ข้อมูลละเอียดกว่าบอทที่ใช้งานจริงในบางเคส (ส่วนหนึ่งเป็นข้อเสนอแนะเพื่อพัฒนาบอทต่อ)
4. **สัดส่วน prompt_kind เอียงไปทาง `alert` (19/34)** เพราะข้อมูลเชิงตัวเลข/ประวัติใส่ได้เฉพาะรูปแบบนี้ ส่วนรูปแบบ context ของ Omada/HikCentral ที่บอทสร้างเองมีข้อมูลบางกว่า (เช่น `cameraCtxText` ตัดรายชื่อเหลือ 5 ตัว) ซึ่งสะท้อนข้อจำกัดของบอทจริง
5. **เฉลยบางเคสยอมรับสมมติฐานได้มากกว่าหนึ่งข้อ** (เช่น CAS-03 ไฟ/ลิงก์อาคาร, CAS-05 จุดร่วมแกนกลาง, NET-04) จึงเขียน `partial_root_cause` และกฎข้อ 3 ใน RUBRIC ไว้ให้ชัด — เคสเหล่านี้ควรถูกตรวจซ้ำเป็นพิเศษ
6. **ผลการรันเดียวต่อเคส/provider** มีความแปรปรวนจากการสุ่มของโมเดล — ขั้นที่ 2 ต้องตัดสินใจเรื่องจำนวนรอบ/อุณหภูมิ (ตอนนี้บอทจริงไม่ได้ตั้ง temperature จึงใช้ค่า default ของแต่ละเจ้า)
7. **ความเป็นธรรมของ prompt:** ทุก provider ได้ system/user prompt เหมือนกันทุกตัวอักษรและ max_tokens เท่ากัน; ต่างกันที่รุ่นโมเดลของแต่ละเจ้า (`claude-haiku-4-5`, `gpt-4o`, `gemini-3.8-flash` ตามที่บอทใช้จริง — เป็นรุ่นระดับประหยัด/เร็วต่างกัน ไม่ใช่รุ่นเรือธงเสมอไป ควรระบุในเล่ม)

## กฎเหล็กของการทดลอง

- **ห้ามแก้เฉลยหลังเห็นคำตอบ AI ใดๆ** (ตอน commit ให้บันทึก hash ของเฉลยที่ freeze ก่อนรัน)
- ห้ามแก้โค้ด production เพื่อการทดลองนี้ (โฟลเดอร์นี้อ่านซอร์สบอทเพื่ออ้างอิงเท่านั้น)
- ทุกการรันที่เสีย API credit ต้องได้รับการยืนยันก่อน
