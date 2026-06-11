'use strict';

// จำลอง Omada Controller API (v2)
// Bot คาดหวัง response format: { errorCode: 0, msg: "Success", result: { data: [...], totalRows: N } }
// และใช้ Csrf-Token header สำหรับ authenticated requests

const { Router } = require('express');
const data       = require('../data');

const router = Router();

// ── POST /api/v2/hotspot/login ─────────────────────────────────────────────────
// จำลอง Omada login → คืน token ปลอมในรูปแบบ { errorCode:0, result:{ token } }
// Bot อ่าน: data.result?.token
router.post('/api/v2/hotspot/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.json({ errorCode: -1002, msg: 'Username or password is incorrect' });
  }
  res.json({
    errorCode: 0,
    msg: 'Success',
    result: {
      token: `MOCK-OMADA-TOKEN-${Date.now()}`,
    },
  });
});

// ── GET /api/v2/:siteId/eaps ───────────────────────────────────────────────────
// คืนรายการ Access Point ทั้งหมด
// รองรับทั้ง /api/v2/:siteId/eaps (ที่ Bot ส่งจริง) และ /api/v2/sites/:siteId/eaps
// Bot อ่าน: result?.data → map(ap => { name, mac, status, clientNum, model })
router.get(['/api/v2/sites/:siteId/eaps', '/api/v2/:siteId/eaps'], (req, res) => {
  const aps = data.getAPs();
  res.json({
    errorCode: 0,
    msg: 'Success',
    result: {
      totalRows:   aps.length,
      currentPage: 1,
      data: aps.map(ap => ({
        name:      ap.name,
        mac:       ap.mac,
        ip:        ap.ip,
        status:    ap.status,    // 0=online, 1=offline
        clientNum: ap.clientNum,
        model:     ap.model,
        // fields เพิ่มเติมสำหรับ context
        building:  ap.building,
        floor:     ap.floor,
      })),
    },
  });
});

// ── GET /api/v2/:siteId/clients ────────────────────────────────────────────────
// คืน Client ที่เชื่อมต่อ WiFi (wireless) และ wired
// Bot อ่าน: result?.totalRows, result?.data[].wireless (boolean)
router.get(['/api/v2/sites/:siteId/clients', '/api/v2/:siteId/clients'], (req, res) => {
  const aps          = data.getAPs();
  const onlineAPs    = aps.filter(a => a.status === 0);
  const wirelessCount = onlineAPs.reduce((sum, ap) => sum + ap.clientNum, 0);
  const wiredCount    = Math.floor(onlineAPs.length * 1.5); // ~1.5 wired ต่อ AP

  // สร้าง data array ให้ Bot ใช้ filter c.wireless
  const clientData = [
    ...Array(wirelessCount).fill(null).map(() => ({ wireless: true })),
    ...Array(wiredCount).fill(null).map(() => ({ wireless: false })),
  ];

  res.json({
    errorCode: 0,
    msg: 'Success',
    result: {
      totalRows:   clientData.length,
      currentPage: 1,
      data:        clientData,
    },
  });
});

// ── GET /api/v2/:siteId/events ─────────────────────────────────────────────────
// คืน Alert/Event จาก AP ที่ offline
// Bot เรียกผ่าน getAlerts() ซึ่งใช้ path นี้ พร้อม ?pageSize=10&currentPage=1
// Bot อ่าน: result?.data[].{ name, time (ms), level (0=warn, else=critical) }
router.get(['/api/v2/sites/:siteId/events', '/api/v2/:siteId/events'], (req, res) => {
  const pageSize  = parseInt(req.query.pageSize || '10', 10);
  const offlineAPs = data.getAPs().filter(a => a.status === 1);

  const events = offlineAPs.slice(0, pageSize).map((ap, idx) => ({
    name:     `AP Disconnected: ${ap.name}`,
    time:     Date.now() - (idx + 1) * 15 * 60_000, // ทุก 15 นาทีย้อนหลัง
    level:    offlineAPs.length > 3 ? 1 : 0,         // วิกฤตถ้า offline หลายตัว
    apName:   ap.name,
    apMac:    ap.mac,
    building: ap.building,
    floor:    ap.floor,
  }));

  res.json({
    errorCode: 0,
    msg: 'Success',
    result: {
      totalRows:   events.length,
      currentPage: 1,
      data:        events,
    },
  });
});

module.exports = router;
