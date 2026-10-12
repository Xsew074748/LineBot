'use strict';
// connectivity ใน /health, /health/deep และสรุปประจำวัน
// กฎเหล็ก: HTTP status ของ /health ต้องไม่เปลี่ยนเด็ดขาด (Docker HEALTHCHECK ใช้) — บอทไม่ได้ตาย แค่มองไม่เห็นออฟฟิศ

const fs = require('fs');
const path = require('path');
const { createHealthHandler } = require('../services/health');
const healthDeep = require('../services/health-deep');
const dailySummary = require('../services/daily-summary');

const view = (state, minutes = 0, since = null) => ({ state, since, minutes });
const fakeRes = () => {
  const res = { statusCalls: [], body: null };
  res.status = (c) => { res.statusCalls.push(c); return res; };
  res.json = (b) => { res.body = b; return res; };
  res.sendStatus = (c) => { res.statusCalls.push(c); return res; };
  return res;
};

describe('createHealthHandler() — /health', () => {
  const mkHandler = (conn) => createHealthHandler({
    getMonitorsLoaded: () => ['zabbix', 'omada'], getAiProvider: () => 'gemini', getConnectivity: () => conn,
  });

  it.each(['ok', 'degraded', 'unreachable'])('state=%s → ตอบ JSON ปกติ ไม่เรียก res.status (HTTP 200 เสมอ)', (state) => {
    const res = fakeRes();
    mkHandler(view(state, 25, '2026-10-12T03:00:00.000Z'))({}, res);
    expect(res.statusCalls).toEqual([]);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('IT Monitor Bot');
    expect(res.body.monitorsLoaded).toEqual(['zabbix', 'omada']);
    expect(res.body.aiProvider).toBe('gemini');
    expect(res.body.connectivity).toEqual(view(state, 25, '2026-10-12T03:00:00.000Z'));
  });

  it('ฟิลด์เดิมครบเหมือนเดิม (status, service, monitorsLoaded, aiProvider) — connectivity เป็นฟิลด์เสริม', () => {
    const res = fakeRes();
    mkHandler(view('ok'))({}, res);
    expect(Object.keys(res.body).sort()).toEqual(['aiProvider', 'connectivity', 'monitorsLoaded', 'service', 'status']);
  });

  it('getConnectivity พัง/ไม่มี → ยังตอบ 200 และ connectivity เป็น null (ห้ามทำให้ health ล้ม)', () => {
    const res = fakeRes();
    createHealthHandler({ getMonitorsLoaded: () => [], getAiProvider: () => null, getConnectivity: () => { throw new Error('x'); } })({}, res);
    expect(res.statusCalls).toEqual([]);
    expect(res.body.connectivity).toBeNull();
  });

  it('payload ไม่มี IP / hostname / URL', () => {
    const res = fakeRes();
    mkHandler(view('unreachable', 30, '2026-10-12T03:00:00.000Z'))({}, res);
    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(json).not.toMatch(/https?:/);
  });
});

describe('index.js ใช้ createHealthHandler กับ /health', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  it("app.get('/health', createHealthHandler(...)) และไม่มี res.json({ status: 'ok' ...}) แบบเดิมเหลืออยู่", () => {
    expect(src).toMatch(/app\.get\('\/health',\s*createHealthHandler\(/);
    expect(src).not.toMatch(/res\.json\(\{\s*status:\s*'ok',\s*service:\s*'IT Monitor Bot'/);
  });
});

describe('/health/deep — connectivity เป็นข้อมูลเสริม ไม่กระทบรหัสตอบ', () => {
  const snap = (state) => ({
    state, since: '2026-10-12T03:00:00.000Z', minutes: 40,
    systems: { zabbix: { ok: false, lastOkAgoSec: 2400, failingMinutes: 40 }, omada: { ok: false, lastOkAgoSec: 2400, failingMinutes: 40 } },
  });
  const base = { now: 1_000_000, startedAt: 1_000_000 - 3_600_000, checkers: {}, line: { consecutive: 0, failed: 0, total: 5 } };

  it('unreachable แต่อย่างอื่นปกติ → ยัง ok (ไม่มี reasons) และมี connectivity ใน body', () => {
    const r = healthDeep.evaluate({ ...base, connectivity: snap('unreachable') });
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.body.connectivity.state).toBe('unreachable');
    expect(r.body.connectivity.systems.zabbix).toEqual({ ok: false, lastOkAgoSec: 2400, failingMinutes: 40 });
  });

  it('ไม่ส่ง connectivity → body ไม่มีฟิลด์นี้ (เข้ากันได้กับผู้เรียกเดิม)', () => {
    expect(healthDeep.evaluate({ ...base }).body.connectivity).toBeUndefined();
  });

  it('เหตุ 503 อื่นยังทำงาน (LINE ส่งล้ม) และ connectivity ไม่ลบ/ไม่เพิ่ม reason', () => {
    const line = { consecutive: 5, failed: 5, total: 5, lastFailureAt: base.now - 1000 };
    const r = healthDeep.evaluate({ ...base, line, connectivity: snap('ok') });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['line-push-failing']);
  });

  it('กรองฟิลด์: เก็บเฉพาะ state/since/minutes/systems(ชื่อมาตรฐาน) แม้ได้ object ที่มีที่อยู่ปนมา', () => {
    const dirty = { ...snap('degraded'), url: 'http://192.0.2.7/api', host: 'zabbix.example.test', systems: { ...snap('degraded').systems, rogue: { ok: false, addr: '192.0.2.9' } } };
    const json = JSON.stringify(healthDeep.evaluate({ ...base, connectivity: dirty }).body.connectivity);
    expect(json).not.toMatch(/192\.0\.2/);
    expect(json).not.toMatch(/example\.test/);
    expect(json).not.toMatch(/rogue/);
  });
});

describe('สรุปประจำวัน — เตือนเมื่อติดต่อระบบไม่ได้ และห้ามขึ้นว่าระบบปกติ', () => {
  const { run } = dailySummary;
  const mkLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });
  const T = Date.UTC(2026, 9, 12, 3, 0, 0);               // 10:00 ไทย
  const quiet = () => ({
    zabbix: { getEventsSince: async () => [], getProblems: async () => [] },
    omada: { getAPs: async () => ({ all: [{ name: 'AP1', status: 'up', type: 'ap' }] }) },
    hikcentral: { getCameras: async () => [{ name: 'CAM1', online: true }] },
  });
  const deps = (conn, extra = {}) => ({
    ...quiet(), listUsers: () => [{ id: 'U1', role: 'ADMIN' }], send: jest.fn(async () => {}), logger: mkLogger(),
    now: () => T, ...(conn === undefined ? {} : { getConnectivity: () => conn }), ...extra,
  });
  const flexText = (r) => JSON.stringify(r.flex);

  it('unreachable: มีบรรทัดเด่น "ติดต่อระบบมอนิเตอร์ไม่ได้ N นาที (ตั้งแต่ HH:mm)" เวลาไทย และไม่มี "ระบบปกติ"', async () => {
    const since = new Date(T - 25 * 60_000).toISOString();            // 09:35 ไทย
    const r = await run(deps(view('unreachable', 25, since)));
    const s = flexText(r);
    expect(s).toContain('ติดต่อระบบมอนิเตอร์ไม่ได้ 25 นาที (ตั้งแต่ 09:35)');
    expect(s).not.toContain('ระบบปกติ');
    expect(s).not.toContain('ไม่พบปัญหา');            // ห้ามพูดว่าไม่พบปัญหาทั้งที่ดึงข้อมูลไม่ได้
    expect(s).toContain('ข้อมูลในสรุปนี้อาจไม่ครบ');
  });

  it('degraded: บอกชื่อระบบที่ติดต่อไม่ได้ และไม่มี "ระบบปกติ"', async () => {
    const since = new Date(T - 12 * 60_000).toISOString();
    const conn = { ...view('degraded', 12, since), failing: ['zabbix', 'omada'] };
    const s = flexText(await run(deps(conn)));
    expect(s).toContain('ติดต่อระบบ zabbix, omada ไม่ได้ 12 นาที (ตั้งแต่ 09:48)');
    expect(s).not.toContain('ระบบปกติ');
  });

  it('ok → สรุป "วันนี้ระบบปกติ" เหมือนเดิม และไม่มีบรรทัดเตือน', async () => {
    const s = flexText(await run(deps(view('ok'))));
    expect(s).toContain('ระบบปกติ');
    expect(s).not.toContain('ติดต่อระบบ');
  });

  it('ไม่ได้ส่ง getConnectivity มา (ผู้เรียกเดิม) → พฤติกรรมเดิมทุกอย่าง', async () => {
    const s = flexText(await run(deps(undefined)));
    expect(s).toContain('ระบบปกติ');
  });

  it('ผู้รับยังได้ข้อความเมื่อ unreachable (สรุปยังถูกส่ง)', async () => {
    const d = deps(view('unreachable', 30, new Date(T - 30 * 60_000).toISOString()));
    const r = await run(d);
    expect(r.sent).toBe(1);
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it('อ่านสถานะ "หลัง" ดึงข้อมูลเสร็จ (ต้องไม่ใช้ค่าก่อนเรียก API รอบนี้)', async () => {
    const order = [];
    const d = deps(undefined, {
      zabbix: { getEventsSince: async () => { order.push('collect'); return []; }, getProblems: async () => [] },
      getConnectivity: () => { order.push('conn'); return view('ok'); },
    });
    await run(d);
    expect(order.indexOf('conn')).toBeGreaterThan(order.indexOf('collect'));
  });

  it('getConnectivity พัง → สรุปยังถูกส่ง (ไม่ล้ม)', async () => {
    const d = deps(undefined, { getConnectivity: () => { throw new Error('x'); } });
    const r = await run(d);
    expect(r.sent).toBe(1);
  });

  it('หัวการ์ดไม่เป็นสีเขียวเมื่อไม่ ok', async () => {
    const green = JSON.stringify((await run(deps(view('ok')))).flex.header.backgroundColor);
    const warn = JSON.stringify((await run(deps(view('unreachable', 20, new Date(T - 20 * 60_000).toISOString())))).flex.header.backgroundColor);
    expect(warn).not.toBe(green);
  });
});

describe('จุดบันทึกผลการเรียก API (ไม่เพิ่มการเรียกเครือข่ายใหม่)', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
  it('zabbix / omada / hikcentral บันทึกผลทั้งสำเร็จและล้มที่จุดเดียวกับ logger.apiCall', () => {
    for (const [file, system, minRecords] of [['services/zabbix.js', 'zabbix', 2], ['services/omada.js', 'omada', 4], ['services/hikcentral.js', 'hikcentral', 2]]) {
      const src = read(file);
      expect((src.match(new RegExp(`connectivity\\.record\\('${system}'`, 'g')) || []).length).toBeGreaterThanOrEqual(minRecords);
      expect((src.match(/logger\.apiCall\(/g) || []).length).toBe((src.match(/connectivity\.record\(/g) || []).length);
    }
  });

  it('index.js ส่ง connectivity.snapshot() เข้า /health/deep และ getConnectivity เข้าสรุปประจำวันกับ /health', () => {
    const src = read('index.js');
    expect(src).toMatch(/hikBreaker:[^\n]*\n\s*connectivity: connectivity\.snapshot\(\),/);
    expect(src).toMatch(/getConnectivity: \(\) => connectivity\.snapshot\(\),/);
    expect(src).toMatch(/getConnectivity: \(\) => connectivity\.publicView\(\),/);
  });

  it('index.js ตั้งรายการระบบที่เปิดใช้ให้ connectivity', () => {
    expect(read('index.js')).toMatch(/connectivity\.setEnabled\(Object\.keys\(enabledMonitors\)\)/);
  });
});
