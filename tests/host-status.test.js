'use strict';
// แยกสถานะ host ของ Zabbix เป็น 3 แบบ: ปกติ (available=1) / ผิดปกติจริง (2) / ไม่ทราบสถานะ (0 หรือค่าอื่น)
// เดิม /stats, การ์ด LINE และข้อความบริบท AI รวม "ไม่ทราบ" เข้ากับ "ออฟไลน์" ทำให้ดูเหมือนดับทั้งที่แค่ Zabbix ยังไม่ยืนยันสถานะ

const { classifyHost, countHostStatus, buildHostContextText } = require('../services/host-status');

const H = (available, name = 'h') => ({ available, name });

describe('classifyHost()', () => {
  it.each([
    [1, 'up'], [2, 'unavailable'], [0, 'unknown'],
    [undefined, 'unknown'], [null, 'unknown'], ['1', 'unknown'], [3, 'unknown'], [-1, 'unknown'],
  ])('available=%p → %s', (available, expected) => {
    expect(classifyHost({ available })).toBe(expected);
  });

  it('host เป็น null/undefined ไม่ throw และนับเป็น unknown', () => {
    expect(classifyHost(null)).toBe('unknown');
    expect(classifyHost(undefined)).toBe('unknown');
  });
});

describe('countHostStatus()', () => {
  it('นับ up / unavailable / unknown และผลรวมเท่า total เสมอ', () => {
    const c = countHostStatus([H(1), H(1), H(2), H(0), H(0), H(0), H(undefined)]);
    expect(c).toEqual({ total: 7, up: 2, unavailable: 1, unknown: 4 });
    expect(c.up + c.unavailable + c.unknown).toBe(c.total);
  });

  it('รายการว่าง / ไม่ใช่ array → ศูนย์ทั้งหมด ไม่ throw', () => {
    const zero = { total: 0, up: 0, unavailable: 0, unknown: 0 };
    expect(countHostStatus([])).toEqual(zero);
    expect(countHostStatus(undefined)).toEqual(zero);
    expect(countHostStatus(null)).toEqual(zero);
  });
});

describe('buildHostContextText() — ข้อความบริบทที่ส่งให้ AI', () => {
  it('ไม่นับ "ไม่ทราบ" เป็นออฟไลน์ และบอกชัดว่าไม่ทราบสถานะ (ไม่ได้แปลว่าดับ)', () => {
    const hosts = [H(1, 'a'), H(2, 'dead-1'), ...Array.from({ length: 10 }, (_, i) => H(0, `unk-${i}`))];
    const text = buildHostContextText(hosts);
    expect(text).toContain('ทั้งหมด 12 เครื่อง');
    expect(text).toMatch(/ออนไลน์ 1(?!\d)/);
    expect(text).toMatch(/ออฟไลน์ 1(?!\d)/);       // เฉพาะ available=2 (ไม่ใช่ 11 = รวม unknown)
    expect(text).toContain('ไม่ทราบสถานะ 10');
    expect(text).toMatch(/ไม่ได้แปลว่า(ดับ|ออฟไลน์)/);
    expect(text).toContain('dead-1');               // ระบุชื่อเฉพาะตัวที่ดับจริง
    expect(text).not.toContain('unk-0');            // ไม่ยัด host ที่ไม่ทราบสถานะลงรายชื่อออฟไลน์
  });

  it('ไม่มี host ที่ไม่ทราบสถานะ → ไม่มีวลี "ไม่ทราบสถานะ" (ข้อความเดิมยังอ่านเหมือนเดิม)', () => {
    const text = buildHostContextText([H(1), H(2, 'dead')]);
    expect(text).not.toContain('ไม่ทราบสถานะ');
    expect(text).toMatch(/ออฟไลน์ 1(?!\d)/);
    expect(text).toContain('dead');
  });

  it('จำกัดรายชื่อออฟไลน์ไม่เกิน 10 ชื่อ', () => {
    const hosts = Array.from({ length: 15 }, (_, i) => H(2, `down-${i}`));
    const text = buildHostContextText(hosts);
    expect(text).toContain('down-9');
    expect(text).not.toContain('down-10');
  });
});
