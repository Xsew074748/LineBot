'use strict';
// การ์ด LINE ของ host: แยก "ไม่ทราบสถานะ" ออกจาก "ไม่เชื่อมต่อ" (เดิมนับรวมเป็น 🔴 ทั้งหมด)

jest.mock('../services/logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), apiCall: jest.fn(), aiCall: jest.fn(), audit: jest.fn(), message: jest.fn(),
}));

const fmt = require('../services/formatter');

const H = (available, name) => ({ available, name, interfaces: [] });
const text = (flex) => JSON.stringify(flex);

describe('buildHosts() — host ที่ไม่ทราบสถานะ', () => {
  const hosts = [H(1, 'ok-1'), H(2, 'dead-1'), H(0, 'unk-1'), H(0, 'unk-2'), H(0, 'unk-3')];

  it('หัวการ์ดแสดง "ไม่ทราบสถานะ" แยก และ "ไม่เชื่อมต่อ" นับเฉพาะ available=2', () => {
    const s = text(fmt.buildHosts(hosts));
    expect(s).toContain('1 เชื่อมต่อ');
    expect(s).toContain('1 ไม่เชื่อมต่อ');
    expect(s).toContain('3 ไม่ทราบสถานะ');
  });

  it('แถวของ host ที่ไม่ทราบสถานะใช้ ❓ ไม่ใช่ 🔴 และ host ที่ดับจริงยังเป็น 🔴', () => {
    // ตรวจไอคอนของแถวโดยเฉพาะ (ข้อความ text เท่ากับไอคอนล้วน) — หัวการ์ดมี ❓ ในประโยคอยู่แล้ว จึงเทียบ substring ธรรมดาไม่ได้
    const unk = JSON.stringify(fmt.buildHosts([H(0, 'unk-1')]));
    expect(unk).toContain('"text":"❓"');
    expect(unk).not.toContain('"text":"🔴"');
    const dead = JSON.stringify(fmt.buildHosts([H(2, 'dead-1')]));
    expect(dead).toContain('"text":"🔴"');
    expect(dead).not.toContain('"text":"❓"');
  });

  it('ใช้ statsFrom (ทั้งชุด) นับหัวการ์ดเมื่อแสดงแค่หน้าเดียว', () => {
    const s = text(fmt.buildHosts(hosts.slice(0, 1), null, 'สถานะ Host', '💻', null, { statsFrom: hosts }));
    expect(s).toContain('3 ไม่ทราบสถานะ');
  });

  it('ไม่มี host ที่ไม่ทราบสถานะ → ไม่มีบรรทัด "ไม่ทราบสถานะ" (การ์ดเดิมไม่เปลี่ยน)', () => {
    const s = text(fmt.buildHosts([H(1, 'a'), H(2, 'b')]));
    expect(s).not.toContain('ไม่ทราบสถานะ');
    expect(s).toContain('1 เชื่อมต่อ');
    expect(s).toContain('1 ไม่เชื่อมต่อ');
  });

  it('อุปกรณ์ที่ไม่ใช่ Zabbix (Omada AP: status up/down ไม่มี available) ไม่ถูกนับเป็นไม่ทราบสถานะ', () => {
    const aps = [{ name: 'ap1', status: 'up' }, { name: 'ap2', status: 'down' }];
    const s = text(fmt.buildHosts(aps, null, 'สถานะ AP', '📶', null, { deviceType: 'ap' }));
    expect(s).not.toContain('ไม่ทราบสถานะ');
    expect(s).toContain('1 เชื่อมต่อ');
    expect(s).toContain('1 ไม่เชื่อมต่อ');
  });
});

describe('buildSummary() — การ์ดสรุป', () => {
  it('Zabbix host: แสดงจำนวนที่ไม่ทราบสถานะเมื่อมี และไม่แสดงเมื่อไม่มี', () => {
    const withUnknown = text(fmt.buildSummary({ zabbix: { problems: [], hosts: [H(1, 'a'), H(0, 'b'), H(0, 'c')] }, omada: {}, hik: null }));
    expect(withUnknown).toContain('ไม่ทราบสถานะ');
    const clean = text(fmt.buildSummary({ zabbix: { problems: [], hosts: [H(1, 'a'), H(2, 'b')] }, omada: {}, hik: null }));
    expect(clean).not.toContain('ไม่ทราบสถานะ');
  });
});
