# Monitoring Adapters

ทุก adapter อยู่ในโฟลเดอร์นี้ แต่ละตัว extends `BaseMonitorAdapter`
และ implement เมธอดมาตรฐาน 3 ตัว

## Adapters ที่มีอยู่

| ไฟล์ | Class | ระบบ |
|------|-------|------|
| `zabbix.js` | `ZabbixAdapter` | Zabbix 7.x (JSON-RPC + Bearer token) |
| `omada.js` | `OmadaAdapter` | TP-Link Omada WiFi Controller |
| `hikcentral.js` | `HikCentralAdapter` | HikCentral CCTV Management |

---

## วิธีเพิ่ม Monitoring ตัวใหม่

### 1. สร้างไฟล์ `adapters/yourmonitor.js`

```js
'use strict';
const BaseMonitorAdapter = require('./base');
const logger             = require('../services/logger');

class YourMonitorAdapter extends BaseMonitorAdapter {
  async testConnection() {
    // เชื่อมต่อและตรวจสอบว่า API ตอบสนอง
    return { ok: true, message: 'เชื่อมต่อสำเร็จ' };
  }

  async getProblems() {
    // ดึง alert/problem ที่กำลัง active
    return [
      {
        source:    'yourmonitor',       // ชื่อระบบ (lowercase)
        device:    'ชื่ออุปกรณ์',
        zone:      'พื้นที่/อาคาร',    // ถ้าไม่มีใส่ 'ไม่ระบุ'
        type:      'camera',            // camera | ap | switch | host | other
        status:    'problem',
        timestamp: Math.floor(Date.now() / 1000),
        ip:        null,                // string หรือ null
        severity:  3,                   // 0=info 1=info 2=warn 3=avg 4=high 5=disaster
      },
    ];
  }

  async getDevices() {
    // ดึงอุปกรณ์ทั้งหมด (ทั้ง online และ offline)
    return [
      {
        device: 'ชื่ออุปกรณ์',
        zone:   'พื้นที่/อาคาร',
        type:   'camera',
        status: 'up',                   // up | down
        ip:     null,
      },
    ];
  }
}

module.exports = YourMonitorAdapter;
```

### 2. เพิ่ม entry ใน `config.js`

```js
const MONITORS = {
  // ... existing monitors ...
  yourmonitor: {
    enabled: true,
    name: 'ชื่อระบบ',
    type: 'yourmonitor',
    adapterModule: './adapters/yourmonitor',   // ← ชี้ไปที่ไฟล์ที่สร้าง
    requiredEnv: ['YOUR_MONITOR_URL', 'YOUR_MONITOR_TOKEN'],
  },
};
```

### 3. ตั้งค่า env vars ใน `.env`

```
YOUR_MONITOR_URL=https://your-monitor.example.com
YOUR_MONITOR_TOKEN=your-api-token
```

### 4. ระบบหลักโหลด adapter อัตโนมัติ

`config.getAdapters()` วนสร้าง instance จากทุก monitor ที่ `enabled: true`
และ env vars ครบ ไม่ต้องแก้ `index.js` สำหรับการ aggregate ข้ามระบบ

---

## Normalized Format

### Problem (getProblems)

```json
{
  "source":    "zabbix",
  "device":    "CAM-BLD-A-01",
  "zone":      "CAM-BLD",
  "type":      "camera",
  "status":    "problem",
  "timestamp": 1749600000,
  "ip":        null,
  "severity":  4
}
```

| field | type | ค่าที่เป็นไปได้ |
|-------|------|----------------|
| `source` | string | ชื่อ adapter ตัวเอง |
| `device` | string | ชื่ออุปกรณ์ |
| `zone` | string | พื้นที่/อาคาร หรือ `"ไม่ระบุ"` |
| `type` | string | `camera` / `ap` / `switch` / `host` / `other` |
| `status` | string | `"problem"` เสมอ |
| `timestamp` | number | Unix time (วินาที) |
| `ip` | string\|null | IP address หรือ null |
| `severity` | number | 0–5 (0=ไม่ระบุ … 5=วิกฤต) |

### Device (getDevices)

```json
{
  "device": "CAM-BLD-A-01",
  "zone":   "CAM-BLD",
  "type":   "camera",
  "status": "up",
  "ip":     null
}
```

| field | type | ค่าที่เป็นไปได้ |
|-------|------|----------------|
| `device` | string | ชื่ออุปกรณ์ |
| `zone` | string | พื้นที่/อาคาร หรือ `"ไม่ระบุ"` |
| `type` | string | `camera` / `ap` / `switch` / `host` / `other` |
| `status` | string | `"up"` หรือ `"down"` |
| `ip` | string\|null | IP address หรือ null |

---

## Error Handling

- แต่ละ adapter method ใส่ `try/catch` + log ก่อน re-throw
- Caller ควรใช้ `Promise.allSettled()` เมื่อเรียกหลาย adapter พร้อมกัน
  เพื่อให้ adapter ที่ error ไม่ทำให้ตัวอื่นพัง:

```js
const results = await Promise.allSettled(
  config.getAdapters().map(({ adapter }) => adapter.getProblems())
);
const problems = results
  .filter((r) => r.status === 'fulfilled')
  .flatMap((r) => r.value);
```
