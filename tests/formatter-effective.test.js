'use strict';
// การ์ด LINE host/summary ใช้ effective เมื่อมี: host ที่ ping ตอบ = 🟢, ping ไม่ตอบ = 🔴, ไม่มีสัญญาณ = ❓
// เมื่อไม่มี effective ต้องทำงานเหมือนเดิมทุกประการ (ล็อกไว้ใน formatter-hosts.test.js)

jest.mock('../services/logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), apiCall: jest.fn(), aiCall: jest.fn(), audit: jest.fn(), message: jest.fn(),
}));

const fmt = require('../services/formatter');

const H = (name, available, effective, source) => ({ name, available, effective, effectiveSource: source, interfaces: [] });
const text = (x) => JSON.stringify(x);

describe('buildHosts() — effective', () => {
  const hosts = [
    H('agent-ok', 1, 'up', 'agent'), H('agent-bad', 2, 'down', 'agent'),
    H('icmp-up-1', 0, 'up', 'icmp'), H('icmp-up-2', 0, 'up', 'icmp'), H('icmp-down', 0, 'down', 'icmp'), H('no-signal', 0, 'unknown', 'none'),
  ];

  it('หัวการ์ดนับตาม effective: 3 เชื่อมต่อ... (ไม่ใช่ 1 เชื่อมต่อ จาก available)', () => {
    const s = text(fmt.buildHosts(hosts));
    expect(s).toContain('3 เชื่อมต่อ');
    expect(s).toContain('2 ไม่เชื่อมต่อ');
    expect(s).toContain('1 ไม่ทราบสถานะ');
  });

  it('ไอคอนแถวตาม effective: ping ตอบ = 🟢, ping ไม่ตอบ = 🔴, ไม่มีสัญญาณ = ❓', () => {
    const icon = (h) => text(fmt.buildHosts([h]));
    expect(icon(hosts[2])).toContain('"text":"🟢"');
    expect(icon(hosts[4])).toContain('"text":"🔴"');
    expect(icon(hosts[5])).toContain('"text":"❓"');
  });

  it('แถวที่ตัดสินจาก ping มีป้าย "ping" กำกับ แถวจาก agent ไม่มี', () => {
    expect(text(fmt.buildHosts([hosts[2]]))).toContain('ตรวจด้วย ping');
    expect(text(fmt.buildHosts([hosts[0]]))).not.toContain('ตรวจด้วย ping');
  });

  it('ใช้ statsFrom (ทั้งชุด) นับหัวการ์ดเมื่อแสดงแค่หน้าเดียว', () => {
    const s = text(fmt.buildHosts(hosts.slice(0, 1), null, 'สถานะ Host', '💻', null, { statsFrom: hosts }));
    expect(s).toContain('3 เชื่อมต่อ');
  });

  it('host ทั้งหมดตอบ ping → หัวการ์ดเขียว ไม่มีบรรทัด ไม่ทราบสถานะ', () => {
    const s = text(fmt.buildHosts(Array.from({ length: 4 }, (_, i) => H('p' + i, 0, 'up', 'icmp'))));
    expect(s).toContain('4 เชื่อมต่อ');
    expect(s).toContain('0 ไม่เชื่อมต่อ');
    expect(s).not.toContain('ไม่ทราบสถานะ');
  });

  it('ผสม host ที่มีและไม่มี effective ในรายการเดียว: ตัวที่ไม่มีใช้กติกา available เดิม', () => {
    const mixed = [H('with', 0, 'up', 'icmp'), { name: 'legacy-unknown', available: 0, interfaces: [] }, { name: 'legacy-down', available: 2, interfaces: [] }];
    const s = text(fmt.buildHosts(mixed));
    expect(s).toContain('1 เชื่อมต่อ');
    expect(s).toContain('1 ไม่เชื่อมต่อ');
    expect(s).toContain('1 ไม่ทราบสถานะ');
  });
});

describe('buildSummary() — effective', () => {
  const z = (hosts) => ({ zabbix: { problems: [], hosts }, omada: {}, hik: null });

  it('ออนไลน์ใช้ effective up และแสดงไม่ทราบสถานะเฉพาะ effective unknown', () => {
    const s = text(fmt.buildSummary(z([H('a', 0, 'up', 'icmp'), H('b', 0, 'up', 'icmp'), H('c', 0, 'down', 'icmp'), H('d', 0, 'unknown', 'none')])));
    expect(s).toContain('ไม่ทราบสถานะ');
    expect(s).toMatch(/"text":"2"/);       // ออนไลน์ = 2 (ไม่ใช่ 0 จาก available)
  });

  it('ไม่มี effective unknown → ไม่มีแถว ไม่ทราบสถานะ แม้ available=0 (เพราะ ping ตอบ)', () => {
    const s = text(fmt.buildSummary(z([H('a', 0, 'up', 'icmp'), H('b', 0, 'up', 'icmp')])));
    expect(s).not.toContain('ไม่ทราบสถานะ');
  });
});
