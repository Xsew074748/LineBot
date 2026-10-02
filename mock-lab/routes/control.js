'use strict';
// Endpoint ควบคุมสถานการณ์ขณะรัน (ทุกตัวขึ้นต้น /mock/) — สร้าง/แก้/ลบ device และสลับสถานการณ์โดยไม่ต้อง restart
const { Router } = require('express');
const { loadScenarioFile, loadScenarioYaml, listScenarios } = require('../lib/scenario');

module.exports = function controlRoutes(holder) {
  const router = Router();
  const bad = (res, e, code = 400) => res.status(code).json({ ok: false, error: e.message });

  const view = (d) => {
    const s = holder.state; const now = Math.floor(Date.now() / 1000);
    return {
      name: d.name, kind: d.kind, ip: d.ip, mac: d.mac, location: d.location, depends_on: d.depends_on,
      own_status: s.ownStatus(d, now), effective: { omada: d.kind === 'ap' || d.kind === 'switch' || d.kind === 'gateway' ? s.viewStatus(d, 'omada', now) : undefined,
        hikcentral: d.kind === 'camera' ? s.viewStatus(d, 'hikcentral', now) : undefined, zabbix: d.zabbix ? s.viewStatus(d, 'zabbix', now) : undefined },
      down_since: s.physicalStatus(d, now) === 'down' ? new Date(s.downSince(d, now) * 1000).toISOString() : null,
      flap: d.flap, metrics: d.metrics, clients: d.clients,
    };
  };

  // ฉีดความผิดพลาดของระบบภายนอก (ไว้ทดสอบ circuit breaker/timeout)   body: { system: 'hikcentral', mode: 'hang' | 'error500' | 'overlap' | 'ok' }
  router.post('/mock/fault', (req, res) => {
    const { system, mode } = req.body || {};
    if (system !== 'hikcentral' || !['hang', 'error500', 'overlap', 'ok'].includes(mode)) {
      return bad(res, new Error("system ต้องเป็น 'hikcentral' และ mode เป็น hang | error500 | overlap | ok"));
    }
    if (mode === 'ok') delete holder.faults[system]; else holder.faults[system] = mode;
    return res.json({ ok: true, faults: holder.faults });
  });

  router.get('/mock/state', (req, res) => {
    const s = holder.state; const now = Math.floor(Date.now() / 1000);
    const count = (list, view2) => ({ total: list.length, down: list.filter((d) => s.viewStatus(d, view2, now) === 'down').length });
    res.json({
      scenario: s.meta,
      omada: count(s.inOmada(), 'omada'), hikcentral: count(s.inHik(), 'hikcentral'), zabbix: count(s.inZabbix(), 'zabbix'),
      devices: s.list().map(view),
    });
  });

  router.get('/mock/devices', (req, res) => {
    let list = holder.state.list().map(view);
    if (req.query.kind) list = list.filter((d) => d.kind === req.query.kind);
    res.json(list);
  });

  // เพิ่ม/แทนที่ device ทั้งตัว   body: { name, kind, ip, status, depends_on, ... } (ฟิลด์เดียวกับไฟล์ YAML)
  router.post('/mock/devices', (req, res) => {
    try {
      const d = holder.state.upsert(req.body, { now: Math.floor(Date.now() / 1000) });
      holder.state.validateDependencies();
      res.status(201).json({ ok: true, device: view(d) });
    } catch (e) { bad(res, e); }
  });

  // แก้บางฟิลด์   body: { status?: 'down', metrics?: {cpu: 97}, flap?: {...} ... }
  router.patch('/mock/devices/:name', (req, res) => {
    try { const d = holder.state.patch(req.params.name, req.body); holder.state.validateDependencies(); res.json({ ok: true, device: view(d) }); }
    catch (e) { bad(res, e, /ไม่พบ/.test(e.message) ? 404 : 400); }
  });

  router.post('/mock/devices/:name/:action(down|up)', (req, res) => {
    try { const d = holder.state.patch(req.params.name, { status: req.params.action }); res.json({ ok: true, device: view(d) }); }
    catch (e) { bad(res, e, 404); }
  });

  router.delete('/mock/devices/:name', (req, res) => {
    if (!holder.state.remove(req.params.name)) return bad(res, new Error(`ไม่พบอุปกรณ์ "${req.params.name}"`), 404);
    try { holder.state.validateDependencies(); res.json({ ok: true }); }
    catch (e) { bad(res, new Error(`ลบแล้ว แต่ทำให้ dependency พัง: ${e.message}`)); }
  });

  router.get('/mock/scenarios', (req, res) => res.json({ current: holder.state.meta, files: listScenarios() }));

  // โหลดสถานการณ์   body: { file: "02-floor2-switch-down.yaml" }  หรือ { yaml: "<เนื้อหา YAML>" }
  router.post('/mock/scenario/load', (req, res) => {
    try {
      const { file, yaml } = req.body || {};
      if (!file && !yaml) throw new Error('ต้องระบุ file หรือ yaml');
      holder.state = file ? loadScenarioFile(file) : loadScenarioYaml(yaml);
      holder.source = file ? { file } : { yaml };
      res.json({ ok: true, scenario: holder.state.meta, devices: holder.state.devices.size });
    } catch (e) { bad(res, e); }
  });

  // คืนสถานการณ์ที่โหลดล่าสุดกลับเป็นค่าเริ่มต้น (ล้างการแก้ผ่าน API)
  router.post('/mock/reset', (req, res) => {
    try {
      holder.state = holder.source.file ? loadScenarioFile(holder.source.file) : loadScenarioYaml(holder.source.yaml);
      res.json({ ok: true, scenario: holder.state.meta });
    } catch (e) { bad(res, e); }
  });

  // ประวัติคำขอล่าสุดที่บอทยิงเข้ามา (ไม่เก็บ header/ค่า secret) — ไว้ดูว่าบอทเรียก API ไหนบ้าง
  router.get('/mock/requests', (req, res) => res.json(holder.requests.slice(-Number(req.query.limit || 50))));

  return router;
};
