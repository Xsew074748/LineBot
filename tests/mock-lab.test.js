'use strict';
// Unit + compat tests ของ mock-lab: ทดสอบโดยเรียก "service ของบอทจริง" (services/zabbix.js, omada.js, hikcentral.js)
// ให้ยิงเข้า mock ที่เปิดพอร์ตสุ่ม — ยืนยันว่า mock ตอบตรงรูปแบบที่บอทอ่านได้จริง (ไม่ใช่แค่เทสตัว mock เอง)

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), apiCall: jest.fn(), aiCall: jest.fn(), audit: jest.fn(), message: jest.fn(),
}));

const http = require('http');
const { createApp, loadConfig } = require('../mock-lab/server');
const { State } = require('../mock-lab/lib/state');
const { parseTime } = require('../mock-lab/lib/time');
const { loadScenarioFile, loadScenarioYaml, listScenarios } = require('../mock-lab/lib/scenario');

// ── unit: เวลา ───────────────────────────────────────────────────────────────
describe('mock-lab / parseTime', () => {
  test('รูปแบบย้อนหลัง -15m, -4d3h, -2h30m', () => {
    expect(parseTime('-15m', 1000)).toBe(1000 - 900);
    expect(parseTime('-4d3h', 1_000_000)).toBe(1_000_000 - (4 * 86400 + 3 * 3600));
    expect(parseTime('-2h30m', 100_000)).toBe(100_000 - 9000);
  });
  test('ISO และ epoch (วินาทีและมิลลิวินาที)', () => {
    expect(parseTime('2026-10-15T09:12:03Z')).toBe(Date.parse('2026-10-15T09:12:03Z') / 1000);
    expect(parseTime(1760000000)).toBe(1760000000);
    expect(parseTime(1760000000000)).toBe(1760000000);
  });
  test('รูปแบบผิด → error ที่บอกวิธีใช้', () => {
    expect(() => parseTime('เมื่อวาน')).toThrow(/รูปแบบเวลาไม่ถูกต้อง/);
  });
});

// ── unit: state / ลูกโซ่ / flap / ข้อมูลขัดแย้ง ──────────────────────────────
describe('mock-lab / State', () => {
  const mk = () => {
    const s = new State();
    s.upsert({ name: 'SW', kind: 'switch', ip: '10.0.0.2' });
    s.upsert({ name: 'AP', kind: 'ap', ip: '10.0.0.11', depends_on: 'SW' });
    s.upsert({ name: 'CAM', kind: 'camera', ip: '10.0.0.21', depends_on: 'SW', zabbix: true });
    s.upsert({ name: 'CAM-IND', kind: 'camera', ip: '10.0.0.22', depends_on: 'SW', ignore_dependency: true });
    return s;
  };
  test('แม่ down → ลูก down ตาม (เว้นแต่ ignore_dependency) และเวลา down ใช้ของแม่', () => {
    const s = mk();
    s.patch('SW', { status: 'down', down_since: '-10m' });
    const now = Math.floor(Date.now() / 1000);
    expect(s.physicalStatus(s.get('AP'), now)).toBe('down');
    expect(s.physicalStatus(s.get('CAM'), now)).toBe('down');
    expect(s.physicalStatus(s.get('CAM-IND'), now)).toBe('up');
    expect(now - s.downSince(s.get('AP'), now)).toBeGreaterThanOrEqual(599);
  });
  test('flap: down ในช่วง down_s แรกของทุกรอบ', () => {
    const s = mk();
    s.patch('AP', { flap: { period_s: 100, down_s: 20 } });
    expect(s.ownStatus(s.get('AP'), 1000)).toBe('down');   // 1000 % 100 = 0 < 20
    expect(s.ownStatus(s.get('AP'), 1050)).toBe('up');
  });
  test('zabbix_status ทับเฉพาะสิ่งที่ Zabbix เห็น', () => {
    const s = mk();
    s.patch('CAM', { zabbix_status: 'down' });
    const now = Math.floor(Date.now() / 1000);
    expect(s.viewStatus(s.get('CAM'), 'zabbix', now)).toBe('down');
    expect(s.viewStatus(s.get('CAM'), 'hikcentral', now)).toBe('up');
  });
  test('validate: kind ผิด / status ผิด / metrics นอกช่วง / flap ผิด', () => {
    const s = new State();
    expect(() => s.upsert({ name: 'x', kind: 'router' })).toThrow(/kind/);
    expect(() => s.upsert({ name: 'x', kind: 'ap', status: 'broken' })).toThrow(/status/);
    expect(() => s.upsert({ name: 'x', kind: 'host', metrics: { cpu: 140 } })).toThrow(/metrics\.cpu/);
    expect(() => s.upsert({ name: 'x', kind: 'ap', flap: { period_s: 10, down_s: 20 } })).toThrow(/flap/);
    expect(() => s.upsert({ kind: 'ap' })).toThrow(/name/);
  });
  test('validateDependencies: แม่ไม่มีอยู่ / วนลูป', () => {
    const s = new State();
    s.upsert({ name: 'A', kind: 'ap', depends_on: 'GHOST' });
    expect(() => s.validateDependencies()).toThrow(/ไม่มีในชุด/);
    const c = new State();
    c.upsert({ name: 'A', kind: 'ap', depends_on: 'B' });
    c.upsert({ name: 'B', kind: 'switch', depends_on: 'A' });
    expect(() => c.validateDependencies()).toThrow(/วนลูป/);
  });
});

// ── unit: scenario loader ────────────────────────────────────────────────────
describe('mock-lab / scenario loader', () => {
  test('ทุกไฟล์ใน scenarios/ โหลดได้และมีอุปกรณ์', () => {
    const files = listScenarios();
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const f of files) expect(loadScenarioFile(f.file).devices.size).toBeGreaterThan(0);
  });
  test('baseline: ทุกอย่างปกติ ไม่มีอุปกรณ์ down', () => {
    const s = loadScenarioFile('01-baseline-office.yaml');
    const now = Math.floor(Date.now() / 1000);
    expect(s.devices.size).toBe(27);
    expect(s.list().filter((d) => s.physicalStatus(d, now) === 'down')).toHaveLength(0);
  });
  test('extends + patch: switch ชั้น 2 ดับ → AP 2 + กล้อง 5 ดับตาม (รวม switch = 8)', () => {
    const s = loadScenarioFile('02-floor2-switch-down.yaml');
    const now = Math.floor(Date.now() / 1000);
    const down = s.list().filter((d) => s.physicalStatus(d, now) === 'down').map((d) => d.name).sort();
    expect(down).toEqual(['AP-FL2-01', 'AP-FL2-02', 'HQ-CAM-201', 'HQ-CAM-202', 'HQ-CAM-203', 'HQ-CAM-204', 'HQ-CAM-205', 'SW-FL2-01']);
  });
  test('inline YAML + ข้อผิดพลาดที่อ่านออก', () => {
    const s = loadScenarioYaml('name: t\ndevices:\n  - {name: A, kind: switch}\n  - {name: B, kind: ap, depends_on: A, status: up}\n');
    expect(s.devices.size).toBe(2);
    expect(() => loadScenarioYaml('devices:\n  - {name: A, kind: nope}\n')).toThrow(/kind/);
    expect(() => loadScenarioYaml('devices: []\n')).toThrow(/ไม่มีอุปกรณ์/);
    expect(() => loadScenarioYaml('extends: ../../.env\ndevices: []\n')).toThrow(/ไม่พบไฟล์สถานการณ์/); // กัน path traversal
    expect(() => loadScenarioYaml('devices:\n  - {name: A, kind: ap}\npatch:\n  - {name: GHOST, set: {status: down}}\n')).toThrow(/patch.*GHOST/);
  });
});

// ── compat: ให้ service ของบอทจริงยิงเข้า mock ────────────────────────────────
describe('mock-lab / compat กับ service ของบอทจริง', () => {
  let server, base, holder, cfg, zabbix, omada, hik;
  const api = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };

  beforeAll(async () => {
    cfg = loadConfig({});
    const created = createApp({ scenarioFile: '01-baseline-office.yaml', config: cfg });
    holder = created.holder;
    server = http.createServer(created.app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    // service ของบอทอ่าน env ตอนโหลดโมดูล → ตั้งก่อน require (dotenv ไม่ทับค่าที่ตั้งไว้แล้ว)
    Object.assign(process.env, {
      ZABBIX_URL: `${base}/api_jsonrpc.php`, ZABBIX_API_TOKEN: cfg.zabbixToken,
      OMADA_URL: base, OMADA_OMADAC_ID: cfg.omadacId, OMADA_SITE_ID: cfg.siteId, OMADA_CLIENT_ID: cfg.omadaClientId, OMADA_CLIENT_SECRET: cfg.omadaClientSecret,
      HIKCENTRAL_URL: base, HIKCENTRAL_APP_KEY: cfg.hikAppKey, HIKCENTRAL_APP_SECRET: cfg.hikAppSecret,
    });
    jest.resetModules();
    zabbix = require('../services/zabbix');
    omada = require('../services/omada');
    hik = require('../services/hikcentral');
  });
  afterAll(() => new Promise((r) => server.close(r)));
  afterEach(async () => { await api('POST', '/mock/reset'); });

  test('Zabbix: healthCheck + getHosts + getCameras อ่านสถานะจาก interfaces[].available', async () => {
    expect((await zabbix.healthCheck()).ok).toBe(true);
    const hosts = await zabbix.getHosts(200);
    expect(hosts.length).toBe(4 + 5 + 12); // server 4 + อุปกรณ์เครือข่าย 5 (switch 4 + gateway 1 สะท้อนเข้า Zabbix) + กล้อง 12
    expect(hosts.every((h) => h.available === 1)).toBe(true);
    const cams = await zabbix.getCameras();
    expect(cams).toHaveLength(12);
    expect(cams[0].groups).toContain('Camera');
  });

  test('Zabbix: token ผิด → error (Not authorized)', async () => {
    const bad = await zabbix.checkAuth({ url: `${base}/api_jsonrpc.php`, apiToken: 'wrong' }).catch((e) => e);
    expect(String(bad.message)).toMatch(/Not authorized/);
    await expect(zabbix.checkAuth({ url: `${base}/api_jsonrpc.php`, apiToken: cfg.zabbixToken })).resolves.toBeUndefined();
  });

  test('ลูกโซ่: switch ชั้น 2 ดับ → Zabbix มี trigger ICMP ของ switch + กล้อง 5 ตัว, offline cameras = 5', async () => {
    await api('POST', '/mock/devices/SW-FL2-01/down');
    const problems = await zabbix.getProblems(50);
    expect(problems.map((p) => p.host).sort()).toEqual(['HQ-CAM-201', 'HQ-CAM-202', 'HQ-CAM-203', 'HQ-CAM-204', 'HQ-CAM-205', 'SW-FL2-01']);
    expect(problems.every((p) => p.description === 'Unavailable by ICMP ping' && p.priority === 4)).toBe(true);
    const raw = await zabbix.fetchOfflineCamerasRaw();
    expect(raw.total).toBe(5);
    expect(raw.groups[0].location).toBe('ชั้น 2');
  });

  test('metrics เกินเกณฑ์ → trigger อัตโนมัติ + getHostMetrics อ่านค่าได้ตามที่ตั้ง', async () => {
    await api('PATCH', '/mock/devices/SRV-DB-01', { metrics: { cpu: 96, memory_used: 97.9 } });
    const problems = await zabbix.getProblems(50);
    expect(problems.filter((p) => p.host === 'SRV-DB-01').map((p) => p.description).sort())
      .toEqual(['High CPU utilization (over 90% for 5m)', 'Lack of available memory (<10% of total)']);
    const [h] = await zabbix.findHosts('SRV-DB-01');
    const m = await zabbix.getHostMetrics(h.id);
    expect(m.cpu.percent).toBeCloseTo(96, 1);
    expect(m.memory.percent).toBeCloseTo(97.9, 1);
    expect(m.disk.percent).toBeCloseTo(57, 1);
  });

  test('Omada: token + getAPs แยก AP/Switch/Gateway + getClients + getSwitchPorts', async () => {
    expect(await omada.getToken()).toMatch(/^mock-omada-/);
    const { aps, switches, gateways } = await omada.getAPs();
    expect([aps.length, switches.length, gateways.length]).toEqual([6, 4, 1]);
    expect(aps.every((a) => a.status === 'up')).toBe(true);
    const clients = await omada.getClients();
    expect(clients.total).toBeGreaterThan(0);
    expect(clients.wireless).toBe(clients.total);
    const sw = switches.find((s) => s.name === 'SW-FL1-01');
    const list = await omada.getSwitchPorts(sw.mac);
    expect(list.length).toBeGreaterThanOrEqual(8);
    expect(list.filter((p) => p.status === 'up').length).toBe(6); // AP 2 + กล้อง 4 ที่เชื่อมอยู่
  });

  test('Omada: switch ดับ → AP ใต้มันเป็น down, client หาย, ports ทั้งหมด down', async () => {
    await api('POST', '/mock/devices/SW-FL2-01/down');
    const { aps, switches } = await omada.getAPs();
    expect(aps.filter((a) => a.status === 'down').map((a) => a.name).sort()).toEqual(['AP-FL2-01', 'AP-FL2-02']);
    const ports = await omada.getSwitchPorts(switches.find((s) => s.name === 'SW-FL2-01').mac);
    expect(ports.every((p) => p.status === 'down')).toBe(true);
    const clients = await omada.getClients();
    expect(clients.clients.some((c) => /AP-FL2-0/.test(c.ap || ''))).toBe(false);
  });

  test('Omada: credential ผิด → ok:false; ถูก → ok:true (requestToken)', async () => {
    await expect(omada.requestToken({ url: base, omadacId: cfg.omadacId, clientId: 'x', clientSecret: 'y' })).rejects.toThrow(/token failed/);
    await expect(omada.requestToken({ url: base, omadacId: cfg.omadacId, clientId: cfg.omadaClientId, clientSecret: cfg.omadaClientSecret })).resolves.toHaveProperty('token');
  });

  test('HikCentral: ลายเซ็น AK/SK ถูกต้อง → getCameras คืน 12 ตัว พร้อมชื่อพื้นที่จาก regions', async () => {
    expect((await hik.healthCheck()).ok).toBe(true);
    const cams = await hik.getCameras(1, 100);
    expect(cams).toHaveLength(12);
    expect(cams.every((c) => c.online)).toBe(true);
    expect(new Set(cams.map((c) => c.location))).toEqual(new Set(['ชั้น 1', 'ชั้น 2', 'ชั้น 3']));
    expect((await hik.getRegions()).map((r) => r.name).sort()).toEqual(['ชั้น 1', 'ชั้น 2', 'ชั้น 3']);
  });

  test('HikCentral: SK ผิด → 401 (healthCheck ok:false ไม่ throw); กล้องที่ดับเห็น offline + events', async () => {
    await expect(hik.checkAuth({ url: base, appKey: cfg.hikAppKey, appSecret: 'wrong' })).rejects.toThrow(/401/);
    await api('POST', '/mock/devices/SW-FL2-01/down');
    const cams = await hik.getCameras(1, 100);
    expect(cams.filter((c) => !c.online).map((c) => c.id).sort()).toEqual(['HQ-CAM-201', 'HQ-CAM-202', 'HQ-CAM-203', 'HQ-CAM-204', 'HQ-CAM-205']);
    expect((await hik.getCameraStatus('HQ-CAM-201')).online).toBe(false);
    expect((await hik.getEvents(10)).length).toBe(5);
  });

  test('ข้อมูลขัดแย้ง: Zabbix เห็นกล้องดับ แต่ HikCentral เห็นออนไลน์ (zabbix_status)', async () => {
    await api('PATCH', '/mock/devices/HQ-CAM-101', { zabbix_status: 'down' });
    const zc = await zabbix.getCameras();
    expect(zc.find((c) => c.name === 'HQ-CAM-101').available).toBe(2);
    expect((await hik.getCameraStatus('HQ-CAM-101')).online).toBe(true);
  });

  test('control API: เพิ่ม/แก้/ลบ device, โหลดสถานการณ์อื่น, reset, ตรวจ error', async () => {
    let r = await api('POST', '/mock/devices', { name: 'HQ-CAM-999', kind: 'camera', ip: '192.168.90.9', location: 'ชั้น 9', depends_on: 'SW-FL1-01', zabbix: true });
    expect(r.status).toBe(201);
    expect((await hik.getCameras(1, 100))).toHaveLength(13);
    r = await api('POST', '/mock/devices/HQ-CAM-999/down');
    expect(r.body.device.effective.hikcentral).toBe('down');
    r = await api('DELETE', '/mock/devices/HQ-CAM-999');
    expect(r.body.ok).toBe(true);
    expect((await api('DELETE', '/mock/devices/HQ-CAM-999')).status).toBe(404);
    expect((await api('POST', '/mock/devices', { name: 'X', kind: 'nope' })).status).toBe(400);
    expect((await api('POST', '/mock/devices', { name: 'X', kind: 'ap', depends_on: 'GHOST' })).status).toBe(400);

    r = await api('POST', '/mock/scenario/load', { file: '08-gateway-down.yaml' });
    expect(r.body.ok).toBe(true);
    const { switches, gateways, aps } = await omada.getAPs();
    expect(gateways[0].status).toBe('down');
    expect(aps.every((a) => a.status === 'up')).toBe(true);
    expect(switches.every((s) => s.status === 'up')).toBe(true);
    expect((await api('POST', '/mock/scenario/load', { file: '../../.env' })).status).toBe(400);
    r = await api('POST', '/mock/reset');
    expect(r.body.scenario.source).toBe('08-gateway-down.yaml'); // reset = กลับไปสถานการณ์ที่โหลดล่าสุด
    expect((await api('GET', '/mock/requests?limit=5')).body.length).toBeGreaterThan(0);
  });

  test('ไม่มีข้อมูล secret ใน /mock/requests และ / แสดงค่า .env สำหรับบอท', async () => {
    await zabbix.getHosts(5);
    const reqs = JSON.stringify((await api('GET', '/mock/requests')).body);
    expect(reqs).not.toContain(cfg.zabbixToken);
    expect(reqs).not.toContain(cfg.hikAppSecret);
    const root = (await api('GET', '/')).body;
    expect(root.botEnv.ZABBIX_API_TOKEN).toBe(cfg.zabbixToken);
  });
});
