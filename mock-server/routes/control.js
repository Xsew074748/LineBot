'use strict';

// Endpoint ควบคุมสถานะสำหรับทดสอบสถานการณ์ต่าง ๆ
// ทุก endpoint ขึ้นต้นด้วย /mock/

const { Router } = require('express');
const data       = require('../data');

const router = Router();

// ── GET /mock/status ───────────────────────────────────────────────────────────
// ดูสถานะปัจจุบันของข้อมูลจำลองทั้งหมด (useful สำหรับ debug)
router.get('/mock/status', (req, res) => {
  const cams       = data.getCameras();
  const aps        = data.getAPs();
  const offlineCams = cams.filter(c => !c.online);
  const offlineAPs  = aps.filter(a => a.status === 0);

  // สรุปกล้องแยกตามอาคาร
  const camsByBuilding = {};
  for (const b of data.BUILDINGS) {
    const total   = cams.filter(c => c.building === b).length;
    const offline = cams.filter(c => c.building === b && !c.online).length;
    camsByBuilding[`อาคาร ${b}`] = { total, online: total - offline, offline };
  }

  // สรุป AP แยกตามอาคาร
  const apsByBuilding = {};
  for (const b of data.BUILDINGS) {
    const bLabel  = `อาคาร ${b}`;
    const total   = aps.filter(a => a.building === bLabel).length;
    const offline = aps.filter(a => a.building === bLabel && a.status === 0).length;
    apsByBuilding[bLabel] = { total, online: total - offline, offline };
  }

  res.json({
    cameras: {
      total:       cams.length,
      online:      cams.length - offlineCams.length,
      offline:     offlineCams.length,
      byBuilding:  camsByBuilding,
    },
    aps: {
      total:      aps.length,
      online:     aps.length - offlineAPs.length,
      offline:    offlineAPs.length,
      byBuilding: apsByBuilding,
    },
  });
});

// ── POST /mock/camera/outage ───────────────────────────────────────────────────
// ทำให้กล้องในอาคารที่ระบุ offline ตามจำนวน
// Body: { building: "A", count: 50 }
//   building = "A"–"E" (ถ้าไม่ระบุ จะ offline ข้ามทุกอาคาร)
//   count    = จำนวนกล้องที่จะ offline (ถ้าไม่ระบุ offline ทั้งหมดที่กรอง)
router.post('/mock/camera/outage', (req, res) => {
  const { building, count } = req.body;
  const cams = data.getCameras();

  let targets = cams.filter(c => c.online);
  if (building) {
    const upper = String(building).toUpperCase();
    targets = targets.filter(c => c.building === upper);
  }
  if (count !== undefined) {
    targets = targets.slice(0, Number(count));
  }

  const now = Date.now();
  targets.forEach((cam, i) => {
    cam.online      = false;
    cam.offlineTime = now - i * 500; // spread เล็กน้อยให้ดูสมจริง
  });

  res.json({
    ok:       true,
    message:  `Set ${targets.length} camera(s) offline${building ? ` in building ${building.toUpperCase()}` : ''}`,
    affected: targets.map(c => c.cameraId),
    summary: {
      total:   cams.length,
      online:  cams.filter(c => c.online).length,
      offline: cams.filter(c => !c.online).length,
    },
  });
});

// ── POST /mock/camera/reset ────────────────────────────────────────────────────
// คืนสถานะกล้องทั้งหมดกลับ online
router.post('/mock/camera/reset', (req, res) => {
  const cams = data.getCameras();
  cams.forEach(cam => {
    cam.online      = true;
    cam.offlineTime = null;
  });
  res.json({
    ok:      true,
    message: 'All cameras set to online',
    summary: { total: cams.length, online: cams.length, offline: 0 },
  });
});

// ── POST /mock/ap/outage ───────────────────────────────────────────────────────
// ทำให้ AP offline ตามจำนวน
// Body: { count: 10, building: "A" } (building เป็น optional)
router.post('/mock/ap/outage', (req, res) => {
  const { count, building } = req.body;
  const aps = data.getAPs();

  let targets = aps.filter(a => a.status === 1);
  if (building) {
    const label = `อาคาร ${String(building).toUpperCase()}`;
    targets = targets.filter(a => a.building === label);
  }
  if (count !== undefined) {
    targets = targets.slice(0, Number(count));
  }

  targets.forEach(ap => {
    ap.status      = 0;    // 0=Disconnected
    ap.healthScore = -1;
    ap.clientNum   = 0;
  });

  res.json({
    ok:       true,
    message:  `Set ${targets.length} AP(s) offline${building ? ` in building ${building.toUpperCase()}` : ''}`,
    affected: targets.map(a => a.name),
    summary: {
      total:   aps.length,
      online:  aps.filter(a => a.status === 1).length,
      offline: aps.filter(a => a.status === 0).length,
    },
  });
});

// ── POST /mock/group-outage ────────────────────────────────────────────────────
// จำลองสถานการณ์ outage แบบกลุ่ม: กล้อง + AP ในอาคารเดียวกันดับพร้อมกัน
// ใช้ทดสอบและ demo Cross-System Correlation โดยไม่ต้องรอของจริงพัง
// Body: { building: "A", cameraCount: 10, apCount: 3 }
//   building     = "A"–"E" (default: "A")
//   cameraCount  = จำนวนกล้องที่จะ offline (default: 10)
//   apCount      = จำนวน AP ที่จะ offline (default: 3)
router.post('/mock/group-outage', (req, res) => {
  const { building = 'A', cameraCount = 10, apCount = 3 } = req.body;
  const upper = String(building).toUpperCase();
  const zone  = `อาคาร ${upper}`;
  const now   = Date.now();
  const nowSec = Math.floor(now / 1000);

  // ── Cameras offline ──────────────────────────────────────────────────────
  const camPool    = data.getCameras().filter((c) => c.online && c.building === upper);
  const camTargets = camPool.slice(0, Number(cameraCount));
  camTargets.forEach((cam, i) => {
    cam.online      = false;
    cam.offlineTime = now - i * 300; // กระจายช่วงเวลา 300ms ให้สมจริง
  });

  // ── APs offline ─────────────────────────────────────────────────────────
  const apPool    = data.getAPs().filter((a) => a.status === 1 && a.building === zone);
  const apTargets = apPool.slice(0, Number(apCount));
  apTargets.forEach((ap) => {
    ap.status      = 0;    // 0=Disconnected
    ap.healthScore = -1;
    ap.clientNum   = 0;
  });

  // ── Normalized events สำหรับทดสอบ correlate() โดยตรง ───────────────────
  // Zone ตรงกันทุก adapter ("อาคาร A") ทำให้ correlation ทำงานได้ทันที
  const normalizedEvents = [
    ...camTargets.map((cam, i) => ({
      source:    'hikcentral',
      device:    cam.cameraName,
      zone,
      type:      'camera',
      status:    'problem',
      timestamp: nowSec - Math.floor(i * 0.3), // กระจายในช่วง < 1 วินาที
      ip:        null,
      severity:  3,
    })),
    ...apTargets.map((ap, i) => ({
      source:    'omada',
      device:    ap.name,
      zone,
      type:      'ap',
      status:    'problem',
      timestamp: nowSec - Math.floor(i * 0.1),
      ip:        null,
      severity:  2,
    })),
  ];

  res.json({
    ok: true,
    scenario: `Group outage — ${zone}`,
    affected: {
      cameras: { count: camTargets.length, building: upper },
      aps:     { count: apTargets.length,  zone },
    },
    hint: [
      `1. พิมพ์ "cross" ใน LINE Bot เพื่อดู correlation result`,
      `2. หรือใช้ normalizedEvents ด้านล่างนี้เพื่อทดสอบ correlate() โดยตรง`,
    ],
    // ready-made normalized events พร้อม zone ที่ match กัน
    normalizedEvents,
    // สรุปปัจจุบันหลังจาก outage
    currentState: {
      cameras: {
        total:   data.getCameras().length,
        online:  data.getCameras().filter((c) => c.online).length,
        offline: data.getCameras().filter((c) => !c.online).length,
      },
      aps: {
        total:   data.getAPs().length,
        online:  data.getAPs().filter((a) => a.status === 1).length,
        offline: data.getAPs().filter((a) => a.status === 0).length,
      },
    },
  });
});

// ── POST /mock/reset ───────────────────────────────────────────────────────────
// Reset ทุกอย่างกลับสู่สถานะเริ่มต้น (480 cam online, 20 offline / 45 AP online, 5 offline)
router.post('/mock/reset', (req, res) => {
  data.reset();
  const cams = data.getCameras();
  const aps  = data.getAPs();
  res.json({
    ok:      true,
    message: 'All data reset to initial state',
    summary: {
      cameras: {
        total:   cams.length,
        online:  cams.filter(c => c.online).length,
        offline: cams.filter(c => !c.online).length,
      },
      aps: {
        total:   aps.length,
        online:  aps.filter(a => a.status === 1).length,
        offline: aps.filter(a => a.status === 0).length,
      },
    },
  });
});

module.exports = router;
