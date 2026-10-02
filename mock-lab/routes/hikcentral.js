'use strict';
// จำลอง HikCentral OpenAPI (artemis, AK/SK signature) เฉพาะ endpoint ที่ services/hikcentral.js เรียกจริง:
//   POST /artemis/api/resource/v1/cameras · /cameras/indexCode · /regions
//   POST /artemis/api/eventService/v1/eventRecords/page
// ตรวจลายเซ็น X-Ca-Signature ตามสูตรเดียวกับที่บอทสร้าง (HMAC-SHA256 ของ METHOD/Accept/Content-Type/x-ca-key/x-ca-timestamp/path)
// เมื่อ strictAuth → ต้องตรงกับ MOCK_HIK_APP_KEY / MOCK_HIK_APP_SECRET; ไม่ตรง → HTTP 401 เหมือน artemis จริง
const { Router } = require('express');
const crypto = require('crypto');

module.exports = function hikRoutes(holder, cfg) {
  const router = Router();

  // fault injection (ตั้งผ่าน POST /mock/fault): hang = ไม่ตอบเลย (client timeout), error500 = HTTP 500, ok = ปกติ
  router.use('/artemis', (req, res, next) => {
    const fault = holder.faults && holder.faults.hikcentral;
    if (fault === 'hang') { holder.log('hikcentral', 'FAULT hang'); return undefined; }
    if (fault === 'error500') { holder.log('hikcentral', 'FAULT 500'); return res.status(500).json({ code: '500', msg: 'mock internal error' }); }
    return next();
  });

  router.use('/artemis', (req, res, next) => {
    const h = req.headers;
    if (!h['x-ca-key'] || !h['x-ca-signature'] || !h['x-ca-timestamp']) {
      res.set('X-Ca-Error-Message', 'Missing signature headers');
      return res.status(401).json({ code: '401', msg: 'Missing X-Ca-* signature headers' });
    }
    if (cfg.strictAuth) {
      const stringToSign = [
        req.method.toUpperCase(), h.accept || '*/*', h['content-type'] || '',
        `x-ca-key:${h['x-ca-key']}`, `x-ca-timestamp:${h['x-ca-timestamp']}`, req.originalUrl.split('?')[0],
      ].join('\n');
      const expected = crypto.createHmac('sha256', cfg.hikAppSecret).update(stringToSign, 'utf8').digest('base64');
      if (h['x-ca-key'] !== cfg.hikAppKey || h['x-ca-signature'] !== expected) {
        res.set('X-Ca-Error-Message', 'Invalid Signature');
        return res.status(401).json({ code: '401', msg: 'Invalid AppKey or signature' });
      }
    }
    next();
  });

  const ok = (res, data) => res.json({ code: '0', msg: 'success', data });
  const paged = (list, body) => {
    const pageSize = Math.min(Math.max(parseInt(body.pageSize, 10) || 20, 1), 500);
    const pageNo = Math.max(parseInt(body.pageNo, 10) || 1, 1);
    return { total: list.length, pageNo, pageSize, list: list.slice((pageNo - 1) * pageSize, pageNo * pageSize) };
  };

  // region: จากชื่อ location ของกล้อง (ไม่ระบุ = "Default")
  function regionsOf(state) {
    const names = [];
    for (const c of state.inHik()) { const n = c.location || 'Default'; if (!names.includes(n)) names.push(n); }
    return names.map((name, i) => ({ indexCode: String(i + 1), regionIndexCode: String(i + 1), name, parentIndexCode: '-1' }));
  }
  function cameraRecords(state) {
    const regions = regionsOf(state); const now = Math.floor(Date.now() / 1000);
    return state.inHik().map((c) => ({
      cameraIndexCode: c.name, cameraName: c.name, cameraTypeName: 'Fixed Camera',
      regionIndexCode: regions.find((r) => r.name === (c.location || 'Default')).indexCode,
      // artemis: status 1 = online, 0 = offline
      status: state.viewStatus(c, 'hikcentral', now) === 'up' ? 1 : 0, ip: c.ip,
    }));
  }

  router.post('/artemis/api/resource/v1/cameras/indexCode', (req, res) => {
    holder.log('hikcentral', 'cameras/indexCode');
    const cam = cameraRecords(holder.state).find((c) => c.cameraIndexCode === (req.body || {}).cameraIndexCode);
    if (!cam) return res.json({ code: '0x02401002', msg: 'camera does not exist' });
    ok(res, cam);
  });

  router.post('/artemis/api/resource/v1/cameras', (req, res) => {
    holder.log('hikcentral', 'cameras');
    ok(res, paged(cameraRecords(holder.state), req.body || {}));
  });

  router.post('/artemis/api/resource/v1/regions', (req, res) => {
    holder.log('hikcentral', 'regions');
    ok(res, paged(regionsOf(holder.state), req.body || {}));
  });

  // รหัสชนิด event ของ mock (ของจริงยังไม่ยืนยันรหัส — ผู้ใช้ตั้ง HIKCENTRAL_EVENT_TYPES เอง; mock ใช้ชุดนี้)
  const MOCK_EVENT_TYPES = { 131329: 'Camera offline', 131330: 'Motion detection', 131331: 'Video loss', 131332: 'Video tampering' };
  const hash = (str) => { let h = 2166136261; for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h; };

  // รูปแบบที่ "ยืนยันกับ HikCentral จริงแล้ว" (ผิด → code 2 "[<field> parameter error]" ตรวจเรียงตามนี้):
  //   startTime, endTime : บังคับ ISO8601 ลงท้าย offset เช่น +00:00 (ลงท้าย Z ไม่ผ่าน)
  //   eventTypes         : สตริงรหัสคั่น "," (array ไม่ผ่าน)
  //   srcType            : สตริง "camera"
  //   srcIndexs          : สตริง cameraIndexCode คั่น "," (array ไม่ผ่าน, ขาดไม่ได้)
  // เรียกแบบเก่าที่ไม่ส่งพารามิเตอร์พวกนี้เลย (getEvents) → ตอบ "Camera offline" ล่าสุดเหมือนเดิม — ของจริงปฏิเสธการเรียกแบบนี้
  const OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
  router.post('/artemis/api/eventService/v1/eventRecords/page', (req, res) => {
    holder.log('hikcentral', 'eventRecords');
    const s = holder.state; const now = Math.floor(Date.now() / 1000);
    const body = req.body || {};
    const strict = ['startTime', 'endTime', 'eventTypes', 'srcType', 'srcIndexs'].some((k) => body[k] !== undefined);
    if (strict) {
      const bad = (what) => res.json({ code: '2', msg: `Incorrect request parameter. [${what} parameter error]` });
      const validTime = (v) => typeof v === 'string' && OFFSET_ISO.test(v) && !Number.isNaN(Date.parse(v));
      if (!validTime(body.startTime)) return bad('startTime');
      if (!validTime(body.endTime)) return bad('endTime');
      const st = Date.parse(body.startTime); const et = Date.parse(body.endTime);
      if (et < st) return bad('endTime');
      const typeList = typeof body.eventTypes === 'string' ? body.eventTypes.split(',').map((x) => x.trim()) : null;
      if (!typeList || !typeList.length || !typeList.every((t) => /^\d+$/.test(t) && MOCK_EVENT_TYPES[t])) return bad('eventTypes');
      if (body.srcType !== 'camera') return bad('srcType');
      const srcList = typeof body.srcIndexs === 'string' ? body.srcIndexs.split(',').map((x) => x.trim()).filter(Boolean) : null;
      if (!srcList || !srcList.length) return bad('srcIndexs');
      const srcSet = new Set(srcList);
      const wanted = new Set(typeList.map(Number));
      const events = [];
      const cams = s.inHik().filter((c) => srcSet.has(c.name) && s.viewStatus(c, 'hikcentral', now) === 'up');
      // 1 นาทีต่อ slot: motion บ่อย, video loss/tamper นานๆ ครั้ง — คงที่ตามชื่อกล้อง+slot (ซ้ำได้ ไม่สุ่ม)
      for (let t = Math.ceil(st / 60000) * 60000; t <= et && events.length < 5000; t += 60000) {
        for (const c of cams) {
          const h = hash(`${c.name}:${t / 60000}`);
          let type = null;
          if (h % 23 === 0) type = 131330;
          else if (h % 97 === 0) type = 131331;
          else if (h % 149 === 0) type = 131332;
          if (type && wanted.has(type)) events.push({ eventName: MOCK_EVENT_TYPES[type], eventType: type, srcIndex: c.name, srcName: c.name, happenTime: new Date(t).toISOString() });
        }
      }
      events.sort((x, y) => (x.happenTime < y.happenTime ? 1 : -1));
      return ok(res, paged(events, body));
    }
    const events = s.inHik().filter((c) => s.viewStatus(c, 'hikcentral', now) === 'down')
      .map((c) => ({ eventName: 'Camera offline', eventType: 131329, srcIndex: c.name, srcName: c.name, happenTime: new Date(s.downSince(c, now) * 1000).toISOString() }))
      .sort((x, y) => (x.happenTime < y.happenTime ? 1 : -1));
    ok(res, paged(events, body));
  });

  return router;
};
