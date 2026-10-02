'use strict';
// สรุปปัญหาประจำวัน (services/daily-summary.js) — unit test ด้วย dependency ปลอม + compat กับ service จริงผ่าน mock-lab
// หมายเหตุ: เคสที่ใช้ mock-lab ตั้งเวลาเหตุการณ์เป็น "นาทีที่แล้ว" → ถ้ารันภายใน ~40 นาทีหลังเที่ยงคืนเวลาไทย
//           เหตุการณ์จะตกเป็นของเมื่อวานและตัวเลข "วันนี้" ไม่ตรง (ไม่ใช่บั๊กของโค้ด)

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), apiCall: jest.fn(), aiCall: jest.fn(), audit: jest.fn(), message: jest.fn(),
}));

const http = require('http');
const { createApp, loadConfig } = require('../mock-lab/server');

const flatText = (flex) => JSON.stringify(flex);
const mkLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

// ── unit: เวลาไทย + cron ──────────────────────────────────────────────────────
describe('daily-summary / เวลาไทยและ cron', () => {
  const ds = require('../services/daily-summary');

  test('startOfBangkokDay: 00:00 ไทย = 17:00 UTC ของวันก่อนหน้า (ไม่ขึ้นกับ TZ ของ process)', () => {
    expect(new Date(ds.startOfBangkokDay(Date.parse('2026-10-02T03:00:00Z'))).toISOString()).toBe('2026-10-01T17:00:00.000Z'); // 10:00 ไทย
    expect(new Date(ds.startOfBangkokDay(Date.parse('2026-10-01T17:30:00Z'))).toISOString()).toBe('2026-10-01T17:00:00.000Z'); // 00:30 ไทย ของ 2 ต.ค.
    expect(new Date(ds.startOfBangkokDay(Date.parse('2026-10-01T16:59:00Z'))).toISOString()).toBe('2026-09-30T17:00:00.000Z'); // 23:59 ไทย ของ 1 ต.ค.
  });

  test('clockTH แสดงเวลาไทย', () => {
    expect(ds.clockTH(Date.parse('2026-10-02T01:00:00Z'))).toBe('08:00');
    expect(ds.clockTH(Date.parse('2026-10-02T10:00:00Z'))).toBe('17:00');
  });

  test('startSchedule: 08:00 และ 17:00 ด้วย timezone Asia/Bangkok ระบุตรงๆ', () => {
    const cron = require('node-cron');
    const spy = jest.spyOn(cron, 'schedule').mockReturnValue({ stop: jest.fn() });
    ds.startSchedule(jest.fn(), mkLogger());
    expect(spy).toHaveBeenCalledWith('0 8,17 * * *', expect.any(Function), { timezone: 'Asia/Bangkok' });
    expect(cron.validate('0 8,17 * * *')).toBe(true);
    spy.mockRestore();
  });

  test('startSchedule: runFn โยน error → log แล้วไม่ล้ม', async () => {
    const cron = require('node-cron');
    let task;
    const spy = jest.spyOn(cron, 'schedule').mockImplementation((e, fn) => { task = fn; return {}; });
    const logger = mkLogger();
    ds.startSchedule(async () => { throw new Error('boom'); }, logger);
    await expect(task()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ── unit: run() ด้วย dependency ปลอม ──────────────────────────────────────────
describe('daily-summary / run (dependency ปลอม)', () => {
  const { run, APPROVED_ROLES } = require('../services/daily-summary');
  const users = [
    { id: 'U1', role: 'ADMIN' }, { id: 'U2', role: 'IT_STAFF' }, { id: 'U3', role: 'VIEWER' }, { id: 'U4', role: 'PENDING' },
  ];
  const quiet = () => ({
    zabbix: { getEventsSince: async () => [], getProblems: async () => [] },
    omada: { getAPs: async () => ({ all: [{ name: 'AP1', status: 'up', type: 'ap' }] }) },
    hikcentral: { getCameras: async () => [{ name: 'CAM1', online: true }] },
  });
  const mk = (over = {}) => {
    const sent = [];
    const deps = { ...quiet(), listUsers: () => users, send: jest.fn(async (id) => { sent.push(id); }), logger: mkLogger(), ...over };
    return { deps, sent };
  };

  test('ไม่มีปัญหาเลย → ส่ง "วันนี้ระบบปกติ" (ไม่ส่งข้อความเปล่า) ให้ approved ทุกคน ยกเว้น PENDING', async () => {
    const { deps, sent } = mk();
    const r = await run(deps, { label: '08:00' });
    expect(r.summary.total).toBe(0);
    expect(flatText(r.flex)).toContain('วันนี้ระบบปกติ');
    expect(sent).toEqual(['U1', 'U2', 'U3']);
    expect(APPROVED_ROLES).not.toContain('PENDING');
    expect(deps.send).toHaveBeenCalledWith('U1', expect.objectContaining({ type: 'bubble' }));
  });

  test('ปัญหาผสม: นับแก้แล้ว/ค้างอยู่ถูก, ค้างข้ามวันแยกต่างหาก, กล้องซ้ำ Zabbix/Hik นับครั้งเดียว', async () => {
    const t0 = Math.floor(Date.now() / 1000);
    const { deps } = mk({
      zabbix: {
        getEventsSince: async () => [
          { name: 'High CPU', host: 'SRV-A', resolved: true, rClock: t0 - 60 },
          { name: 'Disk full', host: 'SRV-B', resolved: true, rClock: t0 - 30 },
          { name: 'Unavailable by ICMP ping', host: 'CAM-1', resolved: false },
        ],
        getProblems: async () => [
          { host: 'SRV-OLD', description: 'Unavailable by ICMP ping', lastchangeTs: 1000 },     // ก่อนวันนี้ → carry
          { host: 'CAM-1', description: 'Unavailable by ICMP ping', lastchangeTs: t0 },         // วันนี้ → อยู่ใน events แล้ว ไม่นับซ้ำ
        ],
      },
      omada: { getAPs: async () => ({ all: [{ name: 'AP-9', status: 'down', type: 'ap' }, { name: 'AP-1', status: 'up', type: 'ap' }] }) },
      hikcentral: { getCameras: async () => [{ name: 'cam-1', online: false }, { name: 'CAM-2', online: false }, { name: 'CAM-3', online: true }] },
    });
    const { summary, flex } = await run(deps);
    expect(summary.resolved).toHaveLength(2);
    expect(summary.ongoing.map((i) => i.name).sort()).toEqual(['AP-9', 'CAM-1', 'CAM-2']); // cam-1 ซ้ำกับ Zabbix (ไม่สนตัวพิมพ์) ถูกตัด
    expect(summary.total).toBe(5);
    expect(summary.carry.map((i) => i.name)).toEqual(['SRV-OLD']);
    const txt = flatText(flex);
    expect(txt).toContain('ปัญหาวันนี้ 5 รายการ');
    expect(txt).toContain('แก้ไขแล้ว 2');
    expect(txt).toContain('ยังค้างอยู่ 3');
    expect(txt).toContain('ไม่ใช่ตลอดทั้งวัน'); // หมายเหตุ Omada/Hik นับ ณ เวลาสรุป
  });

  test('push ให้คนหนึ่งล้มเหลว → log แล้วคนอื่นยังได้รับครบ', async () => {
    const delivered = [];
    const { deps } = mk({
      send: jest.fn(async (id) => { if (id === 'U2') throw new Error('user blocked bot'); delivered.push(id); }),
    });
    const r = await run(deps);
    expect(delivered).toEqual(['U1', 'U3']);
    expect(r.sent).toBe(2);
    expect(r.failed).toEqual(['U2']);
    expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining('U2'));
  });

  test('ระบบหนึ่งดึงไม่ได้ → แจ้งในข้อความว่าข้อมูลไม่ครบ และไม่บอกว่า "ระบบปกติ"', async () => {
    const { deps } = mk({ omada: { getAPs: async () => { throw new Error('Omada timeout'); } } });
    const r = await run(deps);
    const txt = flatText(r.flex);
    expect(r.summary.warnings).toEqual(['Omada: Omada timeout']);
    expect(txt).toContain('ข้อมูลไม่ครบ');
    expect(txt).toContain('Omada timeout');
    expect(txt).not.toContain('วันนี้ระบบปกติ');
  });

  test('noSend → สร้างข้อความอย่างเดียว ไม่ push ใคร (คำสั่งแอดมิน reply เอง)', async () => {
    const { deps, sent } = mk();
    const r = await run(deps, { noSend: true });
    expect(sent).toEqual([]);
    expect(r.recipients).toBe(0);
    expect(r.flex.type).toBe('bubble');
  });

  test('ปัญหาเยอะมาก → จำกัดรายการต่อหมวด + payload ไม่เกินขีดจำกัด flex', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ name: `SRV-${i}`, host: `SRV-${i}`, resolved: i % 2 === 0, rClock: 1, name_: 'x' }));
    const { deps } = mk({
      zabbix: { getEventsSince: async () => many.map((e) => ({ ...e, name: 'Unavailable by ICMP ping — ' + 'ยาว'.repeat(60) })), getProblems: async () => [] },
    });
    const r = await run(deps);
    expect(r.summary.total).toBe(150);
    expect(flatText(r.flex)).toContain('…และอีก');
    expect(Buffer.byteLength(flatText(r.flex), 'utf8')).toBeLessThan(9000);
  });
});

// ── compat: service จริง + mock-lab ───────────────────────────────────────────
describe('daily-summary / compat กับ service จริงผ่าน mock-lab', () => {
  let server, base, cfg, zabbix, omada, hikcentral, run;
  const load = (file) => fetch(`${base}/mock/scenario/load`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }) });
  const users = [{ id: 'U1', role: 'ADMIN' }, { id: 'U2', role: 'IT_STAFF' }, { id: 'U3', role: 'PENDING' }];

  beforeAll(async () => {
    cfg = loadConfig({});
    const created = createApp({ scenarioFile: '01-baseline-office.yaml', config: cfg });
    server = http.createServer(created.app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    Object.assign(process.env, {
      ZABBIX_URL: `${base}/api_jsonrpc.php`, ZABBIX_API_TOKEN: cfg.zabbixToken,
      OMADA_URL: base, OMADA_OMADAC_ID: cfg.omadacId, OMADA_SITE_ID: cfg.siteId, OMADA_CLIENT_ID: cfg.omadaClientId, OMADA_CLIENT_SECRET: cfg.omadaClientSecret,
      HIKCENTRAL_URL: base, HIKCENTRAL_APP_KEY: cfg.hikAppKey, HIKCENTRAL_APP_SECRET: cfg.hikAppSecret,
    });
    jest.resetModules();
    zabbix = require('../services/zabbix');
    omada = require('../services/omada');
    hikcentral = require('../services/hikcentral');
    run = require('../services/daily-summary').run;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  const mkDeps = (send) => ({ zabbix, omada, hikcentral, listUsers: () => users, send, logger: mkLogger() });

  test('zabbix.getEventsSince: แยกแก้แล้ว (มีเวลาแก้) กับยังค้าง', async () => {
    await load('09-daily-mixed.yaml');
    const since = Math.floor(Date.now() / 1000) - 3600;
    const ev = await zabbix.getEventsSince(since);
    const resolved = ev.filter((e) => e.resolved);
    expect(resolved.map((e) => e.host).sort()).toEqual(['SRV-APP-01', 'SRV-WEB-01']);
    expect(resolved.every((e) => e.rClock > e.clock)).toBe(true);
    expect(ev.filter((e) => !e.resolved).map((e) => e.host)).toEqual(expect.arrayContaining(['SRV-DB-01', 'HQ-CAM-101']));
    expect(ev.find((e) => e.host === 'SRV-FILE-01')).toBeUndefined(); // ดับตั้งแต่ 30 ชม.ก่อน — อยู่นอกช่วง time_from
  });

  test('สถานการณ์ไม่มีปัญหา → "วันนี้ระบบปกติ" ส่งให้ approved 2 คน', async () => {
    await load('10-daily-quiet.yaml');
    const send = jest.fn(async () => {});
    const r = await run(mkDeps(send), { label: '17:00' });
    expect(r.summary.total).toBe(0);
    expect(r.summary.carry).toHaveLength(0);
    expect(r.summary.warnings).toHaveLength(0);
    expect(flatText(r.flex)).toContain('วันนี้ระบบปกติ');
    expect(send.mock.calls.map((c) => c[0])).toEqual(['U1', 'U2']);
  });

  test('สถานการณ์ผสม 3 ระบบ → นับและแยกประเภทถูก + user หนึ่งคน push fail คนอื่นยังได้', async () => {
    await load('09-daily-mixed.yaml');
    const delivered = [];
    const send = jest.fn(async (id) => { if (id === 'U1') throw new Error('push failed'); delivered.push(id); });
    const r = await run(mkDeps(send));
    const names = (a) => a.map((i) => i.name).sort();
    expect(names(r.summary.resolved)).toEqual(['SRV-APP-01', 'SRV-WEB-01']);
    expect(names(r.summary.ongoing)).toEqual(['AP-FL3-01', 'HQ-CAM-101', 'SRV-DB-01']); // กล้อง HQ-CAM-101 อยู่ทั้ง Zabbix+Hik นับครั้งเดียว
    expect(names(r.summary.carry)).toEqual(['SRV-FILE-01']);
    expect(r.summary.total).toBe(5);
    expect(r.summary.warnings).toHaveLength(0);
    expect(delivered).toEqual(['U2']);
    expect(r.failed).toEqual(['U1']);
  });
});
