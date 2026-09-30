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

  router.post('/artemis/api/eventService/v1/eventRecords/page', (req, res) => {
    holder.log('hikcentral', 'eventRecords');
    const s = holder.state; const now = Math.floor(Date.now() / 1000);
    const events = s.inHik().filter((c) => s.viewStatus(c, 'hikcentral', now) === 'down')
      .map((c) => ({ eventName: 'Camera offline', eventType: 131329, srcIndex: c.name, srcName: c.name, happenTime: new Date(s.downSince(c, now) * 1000).toISOString() }))
      .sort((a, b) => (a.happenTime < b.happenTime ? 1 : -1));
    ok(res, paged(events, req.body || {}));
  });

  return router;
};
