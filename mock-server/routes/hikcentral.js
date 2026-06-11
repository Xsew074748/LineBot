'use strict';

// จำลอง HikCentral OpenAPI
// Bot ใช้ Bearer token สำหรับทุก request และอ่านข้อมูลจาก data?.list

const { Router } = require('express');
const data       = require('../data');

const router = Router();

// ── POST /api/v1/oauth/token ───────────────────────────────────────────────────
// จำลอง OAuth2 client_credentials flow
// Bot ส่ง: grant_type, client_id, client_secret (form-encoded)
// Bot อ่าน: data.access_token, data.expires_in
router.post('/api/v1/oauth/token', (req, res) => {
  const { grant_type, client_id, client_secret } = req.body;
  if (!client_id || !client_secret) {
    return res.status(401).json({ error: 'invalid_client', error_description: 'Missing credentials' });
  }
  if (grant_type !== 'client_credentials') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }
  res.json({
    access_token: `MOCK-HIK-TOKEN-${Date.now()}`,
    token_type:   'Bearer',
    expires_in:   7200, // 2 ชั่วโมง (Bot หัก 60 วิก่อน refresh)
  });
});

// ── GET /api/v1/cameras ────────────────────────────────────────────────────────
// คืนกล้องทั้งหมด รองรับ pagination และ filter ตาม areaId
// Bot อ่าน: data?.list → formatCameras(list)
// formatCameras อ่าน: cameraId/id, cameraName/name, areaName/location, online, offlineTime
router.get('/api/v1/cameras', (req, res) => {
  const pageNo   = parseInt(req.query.pageNo   || '1',   10);
  const pageSize = parseInt(req.query.pageSize || '100', 10);
  const areaId   = req.query.areaId; // อาจเป็น building letter "A"–"E"

  let cams = data.getCameras();

  // filter ตามอาคาร: areaId = "A" หรือ "อาคาร A"
  if (areaId) {
    const upper = areaId.toUpperCase().replace('อาคาร ', '').trim();
    cams = cams.filter(c => c.building === upper || c.areaName.includes(areaId));
  }

  const total = cams.length;
  const start = (pageNo - 1) * pageSize;
  const list  = cams.slice(start, start + pageSize).map(cam => ({
    cameraId:    cam.cameraId,
    cameraName:  cam.cameraName,
    areaName:    cam.areaName,
    ip:          cam.ip,
    online:      cam.online,
    offlineTime: cam.offlineTime, // Unix ms หรือ null
  }));

  res.json({ list, total, pageNo, pageSize });
});

// ── GET /api/v1/cameras/:id/status ────────────────────────────────────────────
// สถานะกล้องตาม ID
// Bot อ่าน: data?.online (boolean)
router.get('/api/v1/cameras/:id/status', (req, res) => {
  const cam = data.getCameras().find(c => c.cameraId === req.params.id);
  if (!cam) {
    return res.status(404).json({ error: 'Camera not found', cameraId: req.params.id });
  }
  res.json({
    cameraId:    cam.cameraId,
    cameraName:  cam.cameraName,
    online:      cam.online,
    offlineTime: cam.offlineTime,
    areaName:    cam.areaName,
  });
});

// ── GET /api/v1/events ─────────────────────────────────────────────────────────
// Event ล่าสุด (สร้างจากกล้องที่ offline อยู่)
// Bot อ่าน: data?.list[].{ name, eventType, cameraId, time (ms) }
router.get('/api/v1/events', (req, res) => {
  const pageSize    = parseInt(req.query.pageSize || '10', 10);
  const offlineCams = data.getCameras().filter(c => !c.online);

  const list = offlineCams.slice(0, pageSize).map((cam, idx) => ({
    name:      `Video Loss: ${cam.cameraName}`,
    eventType: data.EVENT_TYPES[idx % data.EVENT_TYPES.length],
    cameraId:  cam.cameraId,
    time:      cam.offlineTime || Date.now() - (idx + 1) * 10 * 60_000,
    location:  cam.areaName,
  }));

  res.json({ list, total: offlineCams.length });
});

module.exports = router;
