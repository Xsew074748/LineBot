'use strict';
// /stats: เพิ่ม hosts.effectiveUp / effectiveDown / effectiveUnknown / effectiveSources (เฉพาะฟิลด์เสริม)
// up / total / down / unknown / unavailable เดิมต้องไม่เปลี่ยนความหมาย — Manager คำนวณ "Host ที่ down" = total - up จากฟิลด์เดิม

const { buildStats } = require('../services/stats');

const E = (available, effective, source) => ({ available, effective, effectiveSource: source });
const mk = (hosts) => ({
  getProblems: jest.fn().mockResolvedValue([]),
  getHosts: jest.fn().mockResolvedValue(hosts),
  getCameras: jest.fn().mockResolvedValue([]),
});
const run = (hosts) => buildStats({ monitorKeys: ['zabbix'], zabbix: mk(hosts), omada: null, hikcentral: null });

// ไซต์จริงตอนสืบสวน: agent 2 ตัวปกติ + 1 ตัวผิดปกติ; ICMP-only 10 ตัว (ตอบ 8, ไม่ตอบ 2) — available ของ 10 ตัวหลังเป็น 0 ทั้งหมด
const SITE = [
  E(1, 'up', 'agent'), E(1, 'up', 'agent'), E(2, 'down', 'agent'),
  ...Array.from({ length: 8 }, () => E(0, 'up', 'icmp')), E(0, 'down', 'icmp'), E(0, 'down', 'icmp'),
];

describe('buildStats() — hosts.effective*', () => {
  it('ตัวเลขไซต์จริง: effective up 10 / down 3 / unknown 0, แหล่ง agent 3 / icmp 10 / none 0', async () => {
    const h = (await run(SITE)).devices.hosts;
    expect(h).toMatchObject({ effectiveUp: 10, effectiveDown: 3, effectiveUnknown: 0, effectiveSources: { agent: 3, icmp: 10, none: 0 } });
  });

  it('ล็อกสัญญาเดิม: up/total/down/unknown/unavailable ยังคิดจาก available เหมือนเดิม (up 2, total 13, down 11, unknown 10, unavailable 1)', async () => {
    const h = (await run(SITE)).devices.hosts;
    expect(h).toMatchObject({ total: 13, up: 2, down: 11, unknown: 10, unavailable: 1 });
    expect(h.down).toBe(h.total - h.up);
  });

  it('invariant: effectiveUp + effectiveDown + effectiveUnknown = total และผลรวมแหล่ง = total', async () => {
    for (const mix of [SITE, [E(0, 'unknown', 'none')], [E(1, 'up', 'agent'), E(0, 'down', 'icmp'), E(0, 'unknown', 'none')]]) {
      const h = (await run(mix)).devices.hosts;
      expect(h.effectiveUp + h.effectiveDown + h.effectiveUnknown).toBe(h.total);
      const s = h.effectiveSources;
      expect(s.agent + s.icmp + s.none).toBe(h.total);
    }
  });

  it('ขอ getHosts แบบ effective จาก /stats', async () => {
    const zabbix = mk(SITE);
    await buildStats({ monitorKeys: ['zabbix'], zabbix, omada: null, hikcentral: null });
    expect(zabbix.getHosts).toHaveBeenCalledWith(200, { effective: true });
  });

  it('host ที่ไม่มี effective (service ไม่รองรับ) → ไม่ใส่ฟิลด์ effective* เลย (ไม่แต่งตัวเลข) แต่ฟิลด์เดิมครบ', async () => {
    const h = (await run([{ available: 1 }, { available: 0 }])).devices.hosts;
    expect(h).toEqual({ total: 2, up: 1, down: 1, unknown: 1, unavailable: 0 });
    expect(h.effectiveUp).toBeUndefined();
  });

  it('Zabbix ล้ม / ไม่มี host เลย → ไม่ใส่ effective* (ไม่แต่งตัวเลข) ฟิลด์เดิมเป็นศูนย์ตามสัญญาเดิม และ partial: true', async () => {
    const zabbix = { getProblems: jest.fn().mockRejectedValue(new Error('x')), getHosts: jest.fn().mockRejectedValue(new Error('x')), getCameras: jest.fn().mockRejectedValue(new Error('x')) };
    const stats = await buildStats({ monitorKeys: ['zabbix'], zabbix, omada: null, hikcentral: null });
    expect(stats.devices.hosts).toEqual({ total: 0, up: 0, down: 0, unknown: 0, unavailable: 0 });
    expect(stats.partial).toBe(true);
    expect((await run([])).devices.hosts).toEqual({ total: 0, up: 0, down: 0, unknown: 0, unavailable: 0 });
  });

  it('Manager ยังอ่านได้: ฟิลด์เดิมทุกตัวยังเป็นตัวเลข และ JSON ปกติ', async () => {
    const h = JSON.parse(JSON.stringify((await run(SITE)).devices.hosts));
    for (const k of ['total', 'up', 'down', 'unknown', 'unavailable']) expect(typeof h[k]).toBe('number');
  });
});
