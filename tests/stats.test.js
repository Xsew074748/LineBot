'use strict';
// Unit Tests สำหรับ services/stats.js — ใช้โดย /stats endpoint (Manager poll เก็บสถิติ)

const { buildStats } = require('../services/stats');

function mockZabbix({ problems = [], hosts = [], cameras = [] } = {}) {
  return {
    getProblems: jest.fn().mockResolvedValue(problems),
    getHosts:    jest.fn().mockResolvedValue(hosts),
    getCameras:  jest.fn().mockResolvedValue(cameras),
  };
}

function mockOmada({ aps = [], switches = [] } = {}) {
  return { getAPs: jest.fn().mockResolvedValue({ aps, switches }) };
}

function mockHikcentral({ cameras = [] } = {}) {
  return { getCameras: jest.fn().mockResolvedValue(cameras) };
}

describe('buildStats()', () => {
  it('คืน shape ถูกต้องเมื่อทุก monitor ทำงานปกติ', async () => {
    const zabbix = mockZabbix({
      problems: [
        { priority: 5 }, { priority: 4 }, { priority: 3 }, { priority: 3 }, { priority: 2 },
      ],
      hosts: [
        { available: 1 }, { available: 1 }, { available: 2 },
      ],
      cameras: [{ available: 1 }, { available: 2 }],
    });
    const omada = mockOmada({
      aps:      [{ status: 'up' }, { status: 'up' }, { status: 'up' }],
      switches: [],
    });
    const hikcentral = mockHikcentral({ cameras: [{ online: false }] });

    const stats = await buildStats({
      monitorKeys: ['zabbix', 'omada', 'hikcentral'],
      zabbix,
      omada,
      hikcentral,
    });

    expect(stats.ok).toBe(true);
    expect(typeof stats.timestamp).toBe('string');
    expect(stats.monitors).toEqual(['zabbix', 'omada', 'hikcentral']);
    expect(stats.partial).toBeUndefined();
    expect(stats.failed).toBeUndefined();

    expect(stats.problems).toEqual({ total: 5, disaster: 1, high: 1, average: 2, warning: 1 });

    expect(stats.devices.hosts).toEqual({ total: 3, up: 2, down: 1, unknown: 0, unavailable: 1 });
    expect(stats.devices.aps).toEqual({ total: 3, up: 3, down: 0 });
    expect(stats.devices.switches).toEqual({ total: 0, up: 0, down: 0 });
    // cameras = zabbix (2) + hikcentral (1) รวมกัน
    expect(stats.devices.cameras).toEqual({ total: 3, up: 1, down: 2 });
  });

  it('monitor ล้มเหลว 1 ตัว (omada.getAPs ล้มเหลว) → ยังคืนผลลัพธ์ปกติพร้อมค่า 0 ไม่ throw', async () => {
    const zabbix = mockZabbix({
      problems: [{ priority: 4 }],
      hosts: [{ available: 1 }],
    });
    const omada = { getAPs: jest.fn().mockRejectedValue(new Error('omada down')) };

    const stats = await buildStats({
      monitorKeys: ['zabbix', 'omada'],
      zabbix,
      omada,
      hikcentral: null,
    });

    expect(stats.ok).toBe(true);
    expect(stats.problems).toEqual({ total: 1, disaster: 0, high: 1, average: 0, warning: 0 });
    expect(stats.devices.hosts).toEqual({ total: 1, up: 1, down: 0, unknown: 0, unavailable: 0 });
    expect(stats.devices.aps).toEqual({ total: 0, up: 0, down: 0 });
    expect(stats.devices.switches).toEqual({ total: 0, up: 0, down: 0 });
    // zabbix เปิดใช้งาน → ยังคง contribute cameras (จาก zabbix.getCameras()) แม้ omada ล้มเหลว
    expect(stats.devices.cameras).toEqual({ total: 0, up: 0, down: 0 });
  });

  it('ไม่มี monitor เลย → คืน monitors: [] และไม่มี problems/devices', async () => {
    const stats = await buildStats({
      monitorKeys: [],
      zabbix: null,
      omada: null,
      hikcentral: null,
    });

    expect(stats.ok).toBe(true);
    expect(stats.monitors).toEqual([]);
    expect(stats.problems).toBeUndefined();
    expect(stats.devices).toBeUndefined();
    expect(stats.partial).toBeUndefined();
  });

  it('hikcentral ล้มเหลว/timeout → partial: true, failed: ["hikcentral"], cameras ยังนับจาก zabbix ต่อ', async () => {
    const zabbix = mockZabbix({
      problems: [],
      hosts: [{ available: 1 }],
      cameras: [{ available: 1 }, { available: 1 }],
    });
    const hikcentral = { getCameras: jest.fn().mockRejectedValue(new Error('hikcentral timeout')) };

    const stats = await buildStats({
      monitorKeys: ['zabbix', 'hikcentral'],
      zabbix,
      omada: null,
      hikcentral,
    });

    expect(stats.ok).toBe(true);
    expect(stats.partial).toBe(true);
    expect(stats.failed).toEqual(['hikcentral']);
    // cameras ยังได้จาก zabbix (2 ตัว) แม้ hikcentral ล้มเหลว
    expect(stats.devices.cameras).toEqual({ total: 2, up: 2, down: 0 });
  });
});

describe('buildStats() — hosts.unknown / hosts.unavailable (เพิ่มเฉพาะฟิลด์ ไม่เปลี่ยนความหมาย up/total/down เดิม)', () => {
  const run = (hosts) => buildStats({ monitorKeys: ['zabbix'], zabbix: mockZabbix({ hosts }), omada: null, hikcentral: null });

  it('แยก available=0 (ไม่ทราบ) กับ available=2 (ผิดปกติ); down ยังเท่ากับ total-up เหมือนเดิม', async () => {
    const stats = await run([
      { available: 1 }, { available: 1 },
      { available: 2 },
      ...Array.from({ length: 10 }, () => ({ available: 0 })),
    ]);
    expect(stats.devices.hosts).toEqual({ total: 13, up: 2, down: 11, unknown: 10, unavailable: 1 });
  });

  it('ค่า available ที่ไม่รู้จัก/ไม่มี นับเป็น unknown (ไม่หายจากผลรวม)', async () => {
    const stats = await run([{ available: 1 }, {}, { available: 9 }, { available: null }]);
    const h = stats.devices.hosts;
    expect(h.total).toBe(4);
    expect(h.up).toBe(1);
    expect(h.unknown).toBe(3);
    expect(h.up + h.unknown + h.unavailable).toBe(h.total);
    expect(h.down).toBe(h.total - h.up);
  });

  it('invariant: up + unknown + unavailable = total และ down = unknown + unavailable เสมอ', async () => {
    for (const mix of [[], [{ available: 0 }], [{ available: 2 }, { available: 2 }], [{ available: 1 }, { available: 0 }, { available: 2 }]]) {
      const h = (await run(mix)).devices.hosts;
      expect(h.up + h.unknown + h.unavailable).toBe(h.total);
      expect(h.down).toBe(h.unknown + h.unavailable);
    }
  });

  it('Zabbix ล้มเหลว → hosts เป็นศูนย์ทั้งหมด (ไม่แต่งตัวเลข) และ partial: true', async () => {
    const zabbix = {
      getProblems: jest.fn().mockRejectedValue(new Error('x')),
      getHosts: jest.fn().mockRejectedValue(new Error('x')),
      getCameras: jest.fn().mockRejectedValue(new Error('x')),
    };
    const stats = await buildStats({ monitorKeys: ['zabbix'], zabbix, omada: null, hikcentral: null });
    expect(stats.devices.hosts).toEqual({ total: 0, up: 0, down: 0, unknown: 0, unavailable: 0 });
    expect(stats.partial).toBe(true);
  });
});

describe('buildStats() — refreshedAt ต่อระบบ (เฉพาะระบบที่ดึงสำเร็จ)', () => {
  const NOW = Date.parse('2026-10-12T03:00:00.000Z');
  const now = () => NOW;
  const okZ = () => mockZabbix({ hosts: [{ available: 1 }] });

  it('ทุกระบบสำเร็จ → มี refreshedAt ครบ 3 ระบบ เป็น ISO', async () => {
    const stats = await buildStats({
      monitorKeys: ['zabbix', 'omada', 'hikcentral'], zabbix: okZ(), omada: mockOmada(), hikcentral: mockHikcentral(), now,
    });
    expect(stats.refreshedAt).toEqual({
      zabbix: '2026-10-12T03:00:00.000Z', omada: '2026-10-12T03:00:00.000Z', hikcentral: '2026-10-12T03:00:00.000Z',
    });
  });

  it('ระบบที่ล้มเหลวไม่มี key ใน refreshedAt; ระบบที่ไม่ได้เปิดใช้ก็ไม่มี', async () => {
    const stats = await buildStats({
      monitorKeys: ['zabbix', 'hikcentral'], zabbix: okZ(), omada: null,
      hikcentral: { getCameras: jest.fn().mockRejectedValue(new Error('timeout')) }, now,
    });
    expect(stats.refreshedAt).toEqual({ zabbix: '2026-10-12T03:00:00.000Z' });
    expect(stats.refreshedAt.hikcentral).toBeUndefined();
    expect(stats.refreshedAt.omada).toBeUndefined();
    expect(stats.failed).toEqual(['hikcentral']);
  });

  it('Zabbix ล้มแค่ส่วนเดียว (hosts) ก็ถือว่า zabbix ไม่สำเร็จ → ไม่มี refreshedAt.zabbix', async () => {
    const zabbix = {
      getProblems: jest.fn().mockResolvedValue([]),
      getHosts: jest.fn().mockRejectedValue(new Error('t')),
      getCameras: jest.fn().mockResolvedValue([]),
    };
    const stats = await buildStats({ monitorKeys: ['zabbix'], zabbix, omada: null, hikcentral: null, now });
    expect(stats.refreshedAt.zabbix).toBeUndefined();
  });

  it('ไม่มี monitor เลย → ไม่มี refreshedAt; ฟิลด์เดิม (timestamp, ok, monitors) ยังอยู่ครบ', async () => {
    const stats = await buildStats({ monitorKeys: [], zabbix: null, omada: null, hikcentral: null, now });
    expect(stats.refreshedAt).toBeUndefined();
    expect(stats.ok).toBe(true);
    expect(stats.monitors).toEqual([]);
    expect(typeof stats.timestamp).toBe('string');
  });
});
