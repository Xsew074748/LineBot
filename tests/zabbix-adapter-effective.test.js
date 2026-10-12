'use strict';
// adapters/zabbix.js getDevices(): status ตาม effective (up / down / unknown) — unknown ต้องไม่ถูกแปลงเป็น down
// หมายเหตุ: getDevices() ถูกใช้โดย mcp-server (list_devices / get_status_summary) ไม่ได้ป้อน correlate โดยตรง
//           (correlate รับ getProblems() ที่ status = 'problem') เทสต์ correlate ด้านล่างล็อกสัญญาไว้ ถ้าวันหนึ่งนำ devices ไปป้อน correlate

jest.mock('../services/logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), apiCall: jest.fn(), aiCall: jest.fn(), audit: jest.fn(), message: jest.fn(),
}));
jest.mock('../services/zabbix', () => ({ getHosts: jest.fn(), getProblems: jest.fn(), healthCheck: jest.fn() }));

const zabbixService = require('../services/zabbix');
const ZabbixAdapter = require('../adapters/zabbix');
const { correlate } = require('../services/correlate');

const Adapter = ZabbixAdapter.ZabbixAdapter || ZabbixAdapter;
const H = (name, available, effective, extra = {}) => ({ name, available, effective, groups: 'Servers', interfaces: [{ ip: '192.0.2.1' }], ...extra });

describe('ZabbixAdapter.getDevices()', () => {
  beforeEach(() => zabbixService.getHosts.mockReset());

  it('ขอ getHosts แบบ effective และแปลง up / down / unknown ตามนั้น', async () => {
    zabbixService.getHosts.mockResolvedValue([H('A-1', 1, 'up'), H('B-1', 0, 'up'), H('C-1', 2, 'down'), H('D-1', 0, 'down'), H('E-1', 0, 'unknown')]);
    const devices = await new Adapter().getDevices();
    expect(zabbixService.getHosts).toHaveBeenCalledWith(200, { effective: true });
    expect(devices.map((d) => d.status)).toEqual(['up', 'up', 'down', 'down', 'unknown']);
  });

  it('host ที่ available=0 แต่ ping ตอบ ไม่ใช่ down อีกต่อไป (บั๊กเดิม: ถูกนับเป็น down)', async () => {
    zabbixService.getHosts.mockResolvedValue([H('P-1', 0, 'up')]);
    expect((await new Adapter().getDevices())[0].status).toBe('up');
  });

  it('ไม่มีฟิลด์ effective (service รุ่นเก่า/ item.get ล้ม) → ถอยกลับไปใช้ available: 1=up, 2=down, 0=unknown (ไม่ใช่ down)', async () => {
    zabbixService.getHosts.mockResolvedValue([{ name: 'X-1', available: 1, groups: '', interfaces: [] }, { name: 'Y-1', available: 2, groups: '', interfaces: [] }, { name: 'Z-1', available: 0, groups: '', interfaces: [] }]);
    expect((await new Adapter().getDevices()).map((d) => d.status)).toEqual(['up', 'down', 'unknown']);
  });
});

describe('correlate() — สัญญา: unknown ไม่ถูกนับเป็น down, down จริงยังถูกจับ', () => {
  const now = Math.floor(Date.now() / 1000);
  const dev = (device, status) => ({ source: 'zabbix', device, zone: 'อาคาร A', type: 'host', status, timestamp: now, severity: 4 });

  it('อุปกรณ์ status "down" สองตัวในโซนเดียวกัน → ถูกจับเป็นกลุ่ม', () => {
    const groups = correlate([dev('A-1', 'down'), dev('A-2', 'down')], { lookbackSec: 300, timeWindowSec: 120 });
    expect(groups).toHaveLength(1);
    expect(groups[0].devices.map((d) => d.device).sort()).toEqual(['A-1', 'A-2']);
  });

  it('อุปกรณ์ status "unknown" ทั้งหมด → ไม่มีกลุ่ม', () => {
    expect(correlate([dev('A-1', 'unknown'), dev('A-2', 'unknown'), dev('A-3', 'unknown')], { lookbackSec: 300, timeWindowSec: 120 })).toEqual([]);
  });

  it('ปน down 2 + unknown 3 → กลุ่มมีเฉพาะ down 2 ตัว', () => {
    const alerts = [dev('A-1', 'down'), dev('A-2', 'down'), dev('U-1', 'unknown'), dev('U-2', 'unknown'), dev('U-3', 'unknown')];
    const groups = correlate(alerts, { lookbackSec: 300, timeWindowSec: 120 });
    expect(groups).toHaveLength(1);
    expect(groups[0].devices).toHaveLength(2);
    expect(groups[0].devices.map((d) => d.device)).not.toContain('U-1');
  });
});
