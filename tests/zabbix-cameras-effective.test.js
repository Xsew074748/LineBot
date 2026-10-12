'use strict';
// กล้องที่อยู่ใน Zabbix ใช้ logic เดียวกับ host: ตรวจด้วย ICMP อย่างเดียว → available ค้างที่ 0 → เดิมถูกนับเป็น "ดับ"
// เฟสนี้: getCameras({ effective }) / fetchOfflineCamerasRaw ใช้ผลของ ping; /stats และการ์ดกล้องใช้ isCameraUp
// และกล้องตัวเดียวที่อยู่ทั้ง Zabbix และ HikCentral ต้องไม่ถูกนับซ้ำ

jest.mock('../services/logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), apiCall: jest.fn(), aiCall: jest.fn(), audit: jest.fn(), message: jest.fn(),
}));
jest.mock('axios');
const axios = require('axios');
axios.post = jest.fn();

const logger = require('../services/logger');
const zabbix = require('../services/zabbix');
const { isCameraUp } = require('../services/host-status');
const { buildStats } = require('../services/stats');

const NOW = 1_800_000_000;
let nowSpy;
beforeEach(() => {
  axios.post.mockReset();
  logger.warn.mockClear();
  zabbix._resetEffectiveLogState();
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
});
afterEach(() => nowSpy.mockRestore());

const rawCam = (id, name, available) => ({
  hostid: String(id), host: name, name, status: '0',
  groups: [{ name: 'Cameras' }],
  interfaces: [{ ip: '192.0.2.' + id, available: String(available), main: '1', type: '1' }],
  inventory: { location: 'Building A' },
});
const ping = (hostid, value, ageSec = 30, over = {}) => ({ hostid: String(hostid), lastvalue: String(value), lastclock: String(NOW - ageSec), status: '0', state: '0', ...over });

function api({ cams, items = [], itemsError = null }) {
  axios.post.mockImplementation(async (_u, body) => {
    switch (body.method) {
      case 'hostgroup.get': return { data: { result: [{ groupid: '10', name: 'Cameras' }] } };
      case 'host.get': return { data: { result: cams } };
      case 'item.get': if (itemsError) throw itemsError; return { data: { result: items } };
      case 'problem.get': return { data: { result: [] } };
      default: throw new Error('unexpected ' + body.method);
    }
  });
}
const methods = () => axios.post.mock.calls.map((c) => c[1].method);

describe('isCameraUp()', () => {
  it('effective มาก่อน; ไม่มี effective → available; ไม่มี available → online (HikCentral)', () => {
    expect(isCameraUp({ effective: 'up', available: 0 })).toBe(true);
    expect(isCameraUp({ effective: 'down', available: 1 })).toBe(false);
    expect(isCameraUp({ effective: 'unknown', available: 1 })).toBe(false);
    expect(isCameraUp({ available: 1 })).toBe(true);
    expect(isCameraUp({ available: 2 })).toBe(false);
    expect(isCameraUp({ available: 0 })).toBe(false);
    expect(isCameraUp({ online: true })).toBe(true);
    expect(isCameraUp({ online: false })).toBe(false);
    expect(isCameraUp(null)).toBe(false);
  });
});

describe('getCameras({ effective: true })', () => {
  const CAMS = [rawCam(1, 'cam-agent-ok', 1), rawCam(2, 'cam-ping-up', 0), rawCam(3, 'cam-ping-down', 0), rawCam(4, 'cam-none', 0)];
  const ITEMS = [ping(2, 1), ping(3, 0)];

  it('ไม่ opt-in: ไม่เรียก item.get ไม่มี effective (พฤติกรรมเดิม)', async () => {
    api({ cams: CAMS, items: ITEMS });
    const out = await zabbix.getCameras();
    expect(methods()).not.toContain('item.get');
    expect(out.every((c) => c.effective === undefined)).toBe(true);
    expect(out.map((c) => c.available)).toEqual([1, 0, 0, 0]);
  });

  it('opt-in: host.get กับ item.get(icmpping) ครั้งเดียวต่อรอบ, effective ถูก, available ไม่ถูกแตะ', async () => {
    api({ cams: CAMS, items: ITEMS });
    const out = await zabbix.getCameras({ effective: true });
    expect(methods().filter((m) => m === 'item.get')).toHaveLength(1);
    expect(axios.post.mock.calls.find((c) => c[1].method === 'item.get')[1].params.filter).toEqual({ key_: 'icmpping' });
    const by = Object.fromEntries(out.map((c) => [c.name, c]));
    expect([by['cam-agent-ok'].effective, by['cam-agent-ok'].effectiveSource]).toEqual(['up', 'agent']);
    expect([by['cam-ping-up'].effective, by['cam-ping-up'].effectiveSource]).toEqual(['up', 'icmp']);
    expect([by['cam-ping-down'].effective, by['cam-ping-down'].effectiveSource]).toEqual(['down', 'icmp']);
    expect([by['cam-none'].effective, by['cam-none'].effectiveSource]).toEqual(['unknown', 'none']);
    expect(out.map((c) => c.available)).toEqual([1, 0, 0, 0]);
  });

  it('item.get ล้ม → ไม่ throw, กล้อง ICMP-only เป็น unknown', async () => {
    api({ cams: CAMS, itemsError: Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }) });
    const out = await zabbix.getCameras({ effective: true });
    expect(out).toHaveLength(4);
    expect(out.find((c) => c.name === 'cam-ping-up').effective).toBe('unknown');
    expect(out.find((c) => c.name === 'cam-agent-ok').effective).toBe('up');
  });
});

describe('fetchOfflineCamerasRaw() — คำสั่ง "กล้องดับ"', () => {
  it('กล้องที่ ping ไม่ตอบ (available=0) ถูกนับว่าดับ; ที่ ping ตอบหรือไม่ทราบ ไม่ถูกนับ; agent available=2 ยังนับตามเดิม', async () => {
    api({
      cams: [rawCam(1, 'agent-bad', 2), rawCam(2, 'ping-down', 0), rawCam(3, 'ping-up', 0), rawCam(4, 'no-signal', 0), rawCam(5, 'agent-ok', 1)],
      items: [ping(2, 0), ping(3, 1)],
    });
    const raw = await zabbix.fetchOfflineCamerasRaw();
    expect(raw.total).toBe(2);
    expect(raw.allOffline.map((h) => h.name).sort()).toEqual(['agent-bad', 'ping-down']);
  });

  it('item.get ล้ม → ยังได้ผลจาก agent (available=2) และไม่ประกาศว่ากล้อง ICMP-only ดับ', async () => {
    api({ cams: [rawCam(1, 'agent-bad', 2), rawCam(2, 'ping-only', 0)], itemsError: Object.assign(new Error('x'), { code: 'ECONNABORTED' }) });
    const raw = await zabbix.fetchOfflineCamerasRaw();
    expect(raw.allOffline.map((h) => h.name)).toEqual(['agent-bad']);
  });
});

describe('/stats cameras — ใช้ effective และไม่นับกล้องซ้ำข้ามระบบ', () => {
  const zCam = (name, available, effective) => ({ name, available, effective, effectiveSource: effective ? 'icmp' : undefined });
  const mk = (cameras) => ({ getProblems: jest.fn().mockResolvedValue([]), getHosts: jest.fn().mockResolvedValue([]), getCameras: jest.fn().mockResolvedValue(cameras) });
  const hik = (cameras) => ({ getCameras: jest.fn().mockResolvedValue(cameras) });

  it('กล้อง Zabbix ที่ ping ตอบ (available=0) นับเป็น up ไม่ใช่ down', async () => {
    const stats = await buildStats({
      monitorKeys: ['zabbix', 'hikcentral'],
      zabbix: mk([zCam('Z1', 0, 'up'), zCam('Z2', 0, 'up'), zCam('Z3', 0, 'down'), zCam('Z4', 0, 'unknown')]),
      hikcentral: hik([{ name: 'H1', online: true }, { name: 'H2', online: false }]),
      omada: null,
    });
    expect(stats.devices.cameras).toEqual({ total: 6, up: 3, down: 3 });
  });

  it('ขอ getCameras แบบ effective จาก /stats', async () => {
    const z = mk([]);
    await buildStats({ monitorKeys: ['zabbix'], zabbix: z, omada: null, hikcentral: null });
    expect(z.getCameras).toHaveBeenCalledWith({ effective: true });
  });

  it('กล้องตัวเดียวที่อยู่ทั้ง Zabbix และ HikCentral (ชื่อตรงกัน) นับครั้งเดียว และใช้สถานะฝั่ง Zabbix (effective)', async () => {
    const stats = await buildStats({
      monitorKeys: ['zabbix', 'hikcentral'],
      zabbix: mk([zCam('Gate-Cam-01', 0, 'up'), zCam('Lobby-Cam-02', 0, 'down')]),
      hikcentral: hik([{ name: 'gate-cam-01 ', online: false }, { name: 'LOBBY-CAM-02', online: true }, { name: 'Hik-Only-03', online: true }]),
      omada: null,
    });
    // รวม 3 ตัว (ไม่ใช่ 5): Gate (Zabbix up), Lobby (Zabbix down), Hik-Only (Hik up)
    expect(stats.devices.cameras).toEqual({ total: 3, up: 2, down: 1 });
  });

  it('กล้อง Zabbix ที่ไม่มีคู่ใน HikCentral ไม่ถูกตัดทิ้ง และกล้อง Hik ที่ไม่มีคู่ไม่ถูกตัดทิ้ง', async () => {
    const stats = await buildStats({
      monitorKeys: ['zabbix', 'hikcentral'],
      zabbix: mk([zCam('Only-Z', 0, 'up')]),
      hikcentral: hik([{ name: 'Only-H', online: false }]),
      omada: null,
    });
    expect(stats.devices.cameras).toEqual({ total: 2, up: 1, down: 1 });
  });
});

describe('ซอร์ส: จุดตัดสินกล้อง "ออนไลน์" ใช้ isCameraUp ตัวเดียวกัน', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

  it('index.js: getAllCameras ขอ effective และ isCamOnline = isCameraUp', () => {
    const src = read('index.js');
    expect(src).toMatch(/zabbix\.getCameras\(\{\s*effective:\s*true\s*\}\)/);
    expect(src).toMatch(/const isCamOnline\s*=\s*isCameraUp;/);
  });

  it('formatter.js และ stats.js ไม่มี predicate กล้องแบบเก่า (available === 1 : online === true) เหลืออยู่', () => {
    expect(read('services/formatter.js')).not.toMatch(/c\.available !== undefined \? c\.available === 1 : c\.online === true/);
    expect(read('services/stats.js')).not.toMatch(/c\.available !== undefined \? c\.available === 1 : c\.online === true/);
  });
});
