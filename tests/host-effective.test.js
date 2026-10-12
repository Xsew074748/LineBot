'use strict';
// สถานะ "ที่แท้จริง" (effective) ของ host: agent ชนะ; ถ้าไม่เคยคุยกับ agent (available=0) ใช้ item icmpping ที่สด (<= 10 นาที)
// ไม่มีสัญญาณที่เชื่อถือได้ = unknown (ไม่ใช่ down) — ไม่เปลี่ยนความหมายของ available / hosts.up / down เดิม

const {
  EFFECTIVE_FRESH_SEC, classifyEffective, countEffective, viewStatus, countView, buildHostContextText,
} = require('../services/host-status');

const NOW = 1_800_000_000;
const ping = (over = {}) => ({ key_: 'icmpping', lastvalue: '1', lastclock: String(NOW - 30), status: '0', state: '0', ...over });
const host = (available, items) => ({ available, name: 'h' });
const cls = (available, items, now = NOW) => classifyEffective({ available }, items, now);

describe('classifyEffective() — agent (available 1/2) มาก่อน', () => {
  it('available=1 → up/agent, available=2 → down/agent แม้ไม่มี icmpping', () => {
    expect(cls(1, [])).toMatchObject({ effective: 'up', source: 'agent', conflict: false });
    expect(cls(2, [])).toMatchObject({ effective: 'down', source: 'agent', conflict: false });
  });

  it('agent ชนะ icmpping เมื่อขัดกัน และตั้ง conflict=true (ทั้งสองทิศ)', () => {
    expect(cls(1, [ping({ lastvalue: '0' })])).toMatchObject({ effective: 'up', source: 'agent', conflict: true });
    expect(cls(2, [ping({ lastvalue: '1' })])).toMatchObject({ effective: 'down', source: 'agent', conflict: true });
  });

  it('agent กับ icmpping ตรงกัน หรือ icmpping เก่า/ใช้ไม่ได้ → ไม่ถือว่าขัดกัน', () => {
    expect(cls(1, [ping({ lastvalue: '1' })]).conflict).toBe(false);
    expect(cls(1, [ping({ lastvalue: '0', lastclock: String(NOW - 9999) })]).conflict).toBe(false);
    expect(cls(2, [ping({ lastvalue: '1', state: '1' })]).conflict).toBe(false);
  });
});

describe('classifyEffective() — available=0 ใช้ icmpping', () => {
  it('lastvalue 1 สด → up/icmp; 0 สด → down/icmp', () => {
    expect(cls(0, [ping({ lastvalue: '1' })])).toMatchObject({ effective: 'up', source: 'icmp' });
    expect(cls(0, [ping({ lastvalue: '0' })])).toMatchObject({ effective: 'down', source: 'icmp' });
  });

  it('ขอบความสด: อายุ 599/600 วินาที = สด, 601 = เก่า (unknown/none)', () => {
    expect(EFFECTIVE_FRESH_SEC).toBe(600);
    expect(cls(0, [ping({ lastclock: String(NOW - 599) })]).effective).toBe('up');
    expect(cls(0, [ping({ lastclock: String(NOW - 600) })]).effective).toBe('up');
    expect(cls(0, [ping({ lastclock: String(NOW - 601) })])).toMatchObject({ effective: 'unknown', source: 'none' });
  });

  it('icmpping เก่า "ที่ค่าเป็น 0" ก็ไม่ใช่ down (ไม่ทราบ — ไม่เดา)', () => {
    expect(cls(0, [ping({ lastvalue: '0', lastclock: String(NOW - 5000) })])).toMatchObject({ effective: 'unknown', source: 'none' });
  });

  it('ไม่มี item / รายการว่าง / undefined / null → unknown/none', () => {
    for (const items of [[], undefined, null]) expect(cls(0, items)).toMatchObject({ effective: 'unknown', source: 'none', conflict: false });
  });

  it('item ถูกปิด (status=1) หรือ not supported (state=1) → ไม่ใช้', () => {
    expect(cls(0, [ping({ status: '1' })]).effective).toBe('unknown');
    expect(cls(0, [ping({ state: '1' })]).effective).toBe('unknown');
  });

  it('lastvalue แปลก (ว่าง / ข้อความ / 2 / ติดลบ) → unknown', () => {
    for (const v of ['', 'ok', '2', '-1', null, undefined]) expect(cls(0, [ping({ lastvalue: v })]).effective).toBe('unknown');
  });

  it('lastclock ผิดปกติ: ว่าง / 0 / ข้อความ → unknown; อนาคตเกิน 60 วินาที → unknown, เหลื่อมไม่เกิน 60 วินาทีรับได้', () => {
    for (const c of ['', '0', 'abc', null, undefined]) expect(cls(0, [ping({ lastclock: c })]).effective).toBe('unknown');
    expect(cls(0, [ping({ lastclock: String(NOW + 61) })]).effective).toBe('unknown');
    expect(cls(0, [ping({ lastclock: String(NOW + 30) })]).effective).toBe('up');
  });

  it('หลาย item: ใช้ตัวที่ lastclock ใหม่สุด; เวลาเท่ากันแต่ขัดกัน → down', () => {
    expect(cls(0, [ping({ lastvalue: '0', lastclock: String(NOW - 300) }), ping({ lastvalue: '1', lastclock: String(NOW - 20) })]).effective).toBe('up');
    expect(cls(0, [ping({ lastvalue: '1', lastclock: String(NOW - 20) }), ping({ lastvalue: '0', lastclock: String(NOW - 20) })]).effective).toBe('down');
  });

  it('item ที่ใช้ไม่ได้ปนกับตัวที่ใช้ได้ → ใช้ตัวที่ใช้ได้', () => {
    expect(cls(0, [ping({ status: '1', lastvalue: '0' }), ping({ lastvalue: '1' })]).effective).toBe('up');
  });

  it('ค่า available แปลก (undefined/9) ถือเป็น 0 และใช้ icmpping', () => {
    expect(classifyEffective({}, [ping()], NOW).effective).toBe('up');
    expect(classifyEffective({ available: 9 }, [ping({ lastvalue: '0' })], NOW).effective).toBe('down');
  });

  it('host เป็น null/undefined ไม่ throw', () => {
    expect(() => classifyEffective(null, [ping()], NOW)).not.toThrow();
    expect(classifyEffective(undefined, [], NOW).effective).toBe('unknown');
  });
});

describe('countEffective()', () => {
  const E = (effective, source = 'none') => ({ effective, effectiveSource: source });

  it('นับ up/down/unknown และแหล่งข้อมูล; ผลรวมเท่า total เสมอ', () => {
    const c = countEffective([E('up', 'agent'), E('up', 'icmp'), E('up', 'icmp'), E('down', 'agent'), E('down', 'icmp'), E('unknown')]);
    expect(c).toEqual({ effectiveUp: 3, effectiveDown: 2, effectiveUnknown: 1, effectiveSources: { agent: 2, icmp: 3, none: 1 } });
    expect(c.effectiveUp + c.effectiveDown + c.effectiveUnknown).toBe(6);
  });

  it('ว่าง/ไม่ใช่ array → ศูนย์ทั้งหมด; host ที่ไม่มี effective นับเป็น unknown/none', () => {
    const zero = { effectiveUp: 0, effectiveDown: 0, effectiveUnknown: 0, effectiveSources: { agent: 0, icmp: 0, none: 0 } };
    expect(countEffective([])).toEqual(zero);
    expect(countEffective(undefined)).toEqual(zero);
    expect(countEffective([{ available: 1 }])).toMatchObject({ effectiveUnknown: 1, effectiveSources: { none: 1 } });
  });

  it('ตัวเลขอ้างอิงจากการสืบสวนไซต์จริง: agent 2 ปกติ + 1 ดับ, ICMP 8 ตอบ + 2 ไม่ตอบ → up 10 / down 3 / unknown 0', () => {
    const hosts = [
      E('up', 'agent'), E('up', 'agent'), E('down', 'agent'),
      ...Array.from({ length: 8 }, () => E('up', 'icmp')), E('down', 'icmp'), E('down', 'icmp'),
    ];
    expect(countEffective(hosts)).toEqual({ effectiveUp: 10, effectiveDown: 3, effectiveUnknown: 0, effectiveSources: { agent: 3, icmp: 10, none: 0 } });
  });
});

describe('viewStatus() / countView() — ใช้ effective เมื่อมี ไม่งั้นถอยกลับไปใช้ available เดิม', () => {
  it('มี effective → ใช้ effective; ไม่มี → up / down(unavailable) / unknown ตาม available', () => {
    expect(viewStatus({ effective: 'up', available: 0 })).toBe('up');
    expect(viewStatus({ effective: 'down', available: 1 })).toBe('down');
    expect(viewStatus({ available: 1 })).toBe('up');
    expect(viewStatus({ available: 2 })).toBe('down');
    expect(viewStatus({ available: 0 })).toBe('unknown');
    expect(viewStatus(null)).toBe('unknown');
  });

  it('countView รวมกันเท่า total', () => {
    const c = countView([{ effective: 'up' }, { effective: 'down' }, { effective: 'unknown' }, { available: 1 }, { available: 0 }]);
    expect(c).toEqual({ total: 5, up: 2, down: 1, unknown: 2 });
  });
});

describe('buildHostContextText() — ข้อความบริบท AI เมื่อมี effective', () => {
  const E = (effective, name, source = 'none') => ({ available: 0, effective, effectiveSource: source, name });

  it('ออฟไลน์ = effective down เท่านั้น; ไม่ทราบสถานะแยก; บอกจำนวนที่ตัดสินจากการ ping', () => {
    const hosts = [E('up', 'a', 'agent'), E('up', 'b', 'icmp'), E('down', 'dead-icmp', 'icmp'), E('down', 'dead-agent', 'agent'), E('unknown', 'unk-1')];
    const t = buildHostContextText(hosts);
    expect(t).toMatch(/ทั้งหมด 5 เครื่อง/);
    expect(t).toMatch(/ออนไลน์ 2(?!\d)/);
    expect(t).toMatch(/ออฟไลน์ 2(?!\d)/);
    expect(t).toContain('dead-icmp');
    expect(t).toContain('dead-agent');
    expect(t).not.toContain('unk-1');
    expect(t).toMatch(/ไม่ทราบสถานะ 1/);
    expect(t).toMatch(/ping/i);
  });

  it('available=0 ที่ ping ตอบ ไม่ถูกนับเป็นออฟไลน์/ไม่ทราบอีก (จุดประสงค์ของเฟส 2)', () => {
    const hosts = Array.from({ length: 10 }, (_, i) => E('up', `p${i}`, 'icmp'));
    const t = buildHostContextText(hosts);
    expect(t).toMatch(/ออนไลน์ 10(?!\d)/);
    expect(t).toMatch(/ออฟไลน์ 0(?!\d)/);
    expect(t).not.toContain('ไม่ทราบสถานะ');
  });
});
