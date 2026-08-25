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

    expect(stats.devices.hosts).toEqual({ total: 3, up: 2, down: 1 });
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
    expect(stats.devices.hosts).toEqual({ total: 1, up: 1, down: 0 });
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
