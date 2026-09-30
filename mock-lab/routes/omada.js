'use strict';
// จำลอง Omada Open API (OAuth2 client credentials) เฉพาะ endpoint ที่ services/omada.js เรียกจริง:
//   POST /openapi/authorize/token?grant_type=client_credentials
//   GET  /openapi/v1/:omadacId/sites/:siteId/devices|clients|alerts
//   GET  /openapi/v1/:omadacId/sites/:siteId/switches/:mac/ports
//   GET  /openapi/v1/:omadacId/sites
// Auth header ของบอท: "Authorization: AccessToken=<token>"; token ไม่ถูกต้อง → HTTP 200 + errorCode ตามรูปแบบของ Omada
const { Router } = require('express');
const crypto = require('crypto');

module.exports = function omadaRoutes(holder, cfg) {
  const router = Router();
  const tokens = new Map(); // token → expiresAt (ms)

  const reply = (res, result) => res.json({ errorCode: 0, msg: 'Success.', result });
  const fail  = (res, errorCode, msg) => res.json({ errorCode, msg });
  const page = (list, q) => {
    const size = Math.min(Math.max(parseInt(q.pageSize, 10) || 10, 1), 100);
    const cur  = Math.max(parseInt(q.page, 10) || 1, 1);
    return { totalRows: list.length, currentPage: cur, currentSize: size, data: list.slice((cur - 1) * size, cur * size) };
  };

  router.post('/openapi/authorize/token', (req, res) => {
    holder.log('omada', 'authorize/token');
    const { omadacId, client_id: clientId, client_secret: clientSecret } = req.body || {};
    if (req.query.grant_type !== 'client_credentials') return fail(res, -44004, 'Unsupported grant_type.');
    if (!omadacId || !clientId || !clientSecret) return fail(res, -44106, 'Invalid client credentials (missing field).');
    if (cfg.strictAuth && (clientId !== cfg.omadaClientId || clientSecret !== cfg.omadaClientSecret || omadacId !== cfg.omadacId)) {
      return fail(res, -44106, 'Invalid client_id, client_secret or omadacId.');
    }
    const accessToken = `mock-omada-${crypto.randomBytes(8).toString('hex')}`;
    tokens.set(accessToken, Date.now() + 7200 * 1000);
    return reply(res, { accessToken, tokenType: 'bearer', expiresIn: 7200 });
  });

  // ทุก endpoint ด้านล่างต้องมี token ที่ออกให้และยังไม่หมดอายุ
  router.use('/openapi/v1', (req, res, next) => {
    const m = String(req.headers.authorization || '').match(/^AccessToken=(\S+)$/);
    const exp = m && tokens.get(m[1]);
    if (!exp || exp < Date.now()) return fail(res, -44112, 'The access token has expired or is invalid.');
    next();
  });

  router.get('/openapi/v1/:omadacId/sites', (req, res) => {
    holder.log('omada', 'sites');
    reply(res, page([{ siteId: cfg.siteId, name: 'Mock Site', region: 'TH' }], req.query));
  });

  router.get('/openapi/v1/:omadacId/sites/:siteId/devices', (req, res) => {
    holder.log('omada', 'devices');
    const s = holder.state; const now = Math.floor(Date.now() / 1000);
    const devices = s.inOmada().map((d) => ({
      name: d.name, ip: d.ip, mac: d.mac, model: d.model || defaultModel(d.kind), type: d.kind,
      status: s.viewStatus(d, 'omada', now) === 'up' ? 1 : 0,
    }));
    reply(res, page(devices, req.query));
  });

  router.get('/openapi/v1/:omadacId/sites/:siteId/clients', (req, res) => {
    holder.log('omada', 'clients');
    const s = holder.state; const now = Math.floor(Date.now() / 1000);
    const clients = [];
    for (const d of s.inOmada()) {
      if (!d.clients || s.viewStatus(d, 'omada', now) !== 'up') continue; // อุปกรณ์ดับ → ไม่มี client เกาะ
      for (let i = 1; i <= d.clients; i++) {
        const wireless = d.kind === 'ap';
        clients.push({
          name: `client-${d.name}-${i}`, hostName: `client-${d.name}-${i}`, ip: `10.${d.kind === 'ap' ? 10 : 20}.${clients.length % 250}.${(i % 250) + 1}`,
          mac: `02-00-${(clients.length >> 8).toString(16).padStart(2, '0')}-${(clients.length & 255).toString(16).padStart(2, '0')}-00-${i.toString(16).padStart(2, '0')}`.toUpperCase(),
          ssid: wireless ? 'Office-WiFi' : null, apName: wireless ? d.name : null,
          signalLevel: wireless ? -45 - ((i * 7) % 30) : null, trafficDown: 1_000_000 * i, trafficUp: 200_000 * i, wireless,
        });
      }
    }
    reply(res, page(clients, req.query));
  });

  router.get('/openapi/v1/:omadacId/sites/:siteId/alerts', (req, res) => {
    holder.log('omada', 'alerts');
    const s = holder.state; const now = Math.floor(Date.now() / 1000);
    const alerts = s.inOmada().filter((d) => s.viewStatus(d, 'omada', now) === 'down')
      .map((d) => ({ name: `${d.name} disconnected`, time: s.downSince(d, now) * 1000, level: 1 }));
    reply(res, page(alerts, req.query));
  });

  router.get('/openapi/v1/:omadacId/sites/:siteId/switches/:mac/ports', (req, res) => {
    holder.log('omada', 'switch ports');
    const s = holder.state; const now = Math.floor(Date.now() / 1000);
    const mac = decodeURIComponent(req.params.mac).toUpperCase().replace(/:/g, '-');
    const sw = s.inOmada().find((d) => d.kind === 'switch' && d.mac === mac);
    if (!sw) return fail(res, -39002, 'The switch does not exist.');
    const up = s.viewStatus(sw, 'omada', now) === 'up';
    let ports = sw.ports;
    if (!ports) {
      // สร้างพอร์ตอัตโนมัติ: พอร์ตแรกๆ = อุปกรณ์ลูกที่ depends_on switch นี้ (เชื่อมอยู่), ที่เหลือว่าง
      const children = s.list().filter((c) => c.depends_on === sw.name);
      ports = Array.from({ length: Math.max(8, children.length) }, (_, i) => ({
        port: i + 1, name: `Port ${i + 1}`, linkStatus: i < children.length ? 1 : 0, linkSpeed: 3, poe: children[i] && (children[i].kind === 'ap' || children[i].kind === 'camera') ? 1 : 0,
        clientMac: children[i] ? children[i].mac : null,
      }));
    }
    reply(res, page(ports.map((p) => ({ ...p, linkStatus: up ? p.linkStatus : 0 })), req.query));
  });

  return router;
};

function defaultModel(kind) { return { ap: 'EAP670', switch: 'TL-SG3428X', gateway: 'ER8411' }[kind] || null; }
