# IT Monitor MCP Server

MCP Server สำหรับ IT Monitor Bot — เปิดให้ Claude Desktop ดึงข้อมูล monitoring
จาก Zabbix, Omada และ HikCentral ผ่าน adapter เดิม (read-only ทั้งหมด)

---

## 1. ติดตั้ง

ติดตั้ง dependencies จาก root ของโปรเจค (ครั้งเดียว):

```bash
cd "C:\Users\phatt\OneDrive\Desktop\Project Code\LineBot"
npm install
```

ตรวจสอบว่าไฟล์ `.env` ในโฟลเดอร์นั้นมีค่า credential ครบแล้ว

---

## 2. ทดสอบรันด้วยมือ

```bash
# จาก root ของโปรเจค
node mcp-server/index.js
```

ถ้าเห็น `IT Monitor MCP Server ready (stdio)` ใน stderr แสดงว่าพร้อมแล้ว
(กด Ctrl+C เพื่อออก — server รอรับ JSON-RPC ผ่าน stdin ปกติไม่มี output เพิ่ม)

---

## 3. เชื่อม Claude Desktop

### 3.1 เปิดไฟล์ config ของ Claude Desktop

บน Windows ไฟล์อยู่ที่:
```
C:\Users\<username>\AppData\Roaming\Claude\claude_desktop_config.json
```

### 3.2 เพิ่ม MCP Server

เปิดไฟล์ด้วย Notepad หรือ VS Code แล้วเพิ่ม block `mcpServers`:

```json
{
  "mcpServers": {
    "it-monitor": {
      "command": "node",
      "args": [
        "C:\\Users\\phatt\\OneDrive\\Desktop\\Project Code\\LineBot\\mcp-server\\index.js"
      ]
    }
  }
}
```

> **หมายเหตุ:** ถ้าในไฟล์มี key อื่นอยู่แล้ว ให้เพิ่ม `"mcpServers"` เข้าไปโดยไม่ลบส่วนเดิม

### 3.3 Restart Claude Desktop

ปิดแล้วเปิด Claude Desktop ใหม่ — ไอคอน MCP (plug) จะขึ้นในหน้าแชท

---

## 4. Tools ที่มี

| Tool | คำอธิบาย | พารามิเตอร์ |
|------|-----------|-------------|
| `get_problems` | ดึง alert/ปัญหาที่กำลังเกิดขึ้น | `zone` (optional) |
| `get_devices` | ดึงรายการอุปกรณ์และสถานะ | `type`: camera\|ap\|switch\|host (optional) |
| `get_status_summary` | ภาพรวม online/offline ทั้งระบบ | — |
| `analyze_correlation` | วิเคราะห์กลุ่มอุปกรณ์ที่ขัดข้องพร้อมกัน | — |

---

## 5. ตัวอย่างคำถามที่ถามได้ใน Claude Desktop

```
ตอนนี้มีอุปกรณ์ไหนออฟไลน์บ้าง?
```
```
ตึก A มีปัญหาอะไรไหม?
```
```
สรุปสถานะระบบ monitoring ทั้งหมดให้หน่อย
```
```
มีกลุ่มอุปกรณ์ที่ขัดข้องพร้อมกันไหม? น่าจะเกิดจากอะไร?
```
```
กล้องที่ออฟไลน์อยู่ตอนนี้มีกี่ตัว?
```

---

## 6. ทดสอบด้วย Mock Server

ถ้าต้องการทดสอบโดยไม่เชื่อมระบบจริง ให้รัน mock server ก่อน:

```bash
# Terminal 1 — เปิด Mock Server
node mock-server/index.js

# Terminal 2 — รัน MCP Server (ชี้ .env ไปที่ localhost:4000 อยู่แล้ว)
node mcp-server/index.js
```

---

## 7. สถาปัตยกรรม

```
Claude Desktop
    │  stdio (JSON-RPC)
    ▼
mcp-server/index.js          ← MCP Server (ESM)
    │  createRequire (CJS bridge)
    ├── ../config.js          ← getAdapters() + CORRELATION_CONFIG
    ├── ../adapters/zabbix.js
    ├── ../adapters/omada.js
    ├── ../adapters/hikcentral.js
    └── ../services/correlate.js
```

LINE Bot เดิม (`index.js`) ไม่ถูกแตะต้อง — MCP Server เป็นส่วนเพิ่มแยกต่างหาก
