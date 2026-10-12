'use strict';
// services/log-scrub.js — ปิดบังที่อยู่เครือข่ายในข้อความ log (IPv4/IPv6, URL, hostname) โดยคงรหัส error และเฟรม stack ไว้

const { scrubNetwork, scrubForLog } = require('../services/log-scrub');

describe('scrubNetwork — IPv4', () => {
  test.each([
    ['connect ECONNREFUSED 10.1.2.3:4100', '10.1.2.3'],
    ['connect ETIMEDOUT 172.16.0.5:443', '172.16.0.5'],
    ['connect EHOSTUNREACH 192.168.50.20:80', '192.168.50.20'],
    ['connect ECONNREFUSED 8.8.8.8:53', '8.8.8.8'],
    ['connect ECONNREFUSED 100.64.1.9', '100.64.1.9'],
    ['connect ECONNREFUSED 169.254.10.10:80', '169.254.10.10'],
  ])('%s', (text, ip) => {
    const out = scrubNetwork(text);
    expect(out).not.toContain(ip);
    expect(out).toMatch(/^connect E[A-Z]+ /); // รหัส error ยังอยู่
    expect(out).toContain('<ip>');
  });

  test('พอร์ตหลัง IP ถูกตัดด้วย (บอกว่าเป็นบริการอะไรของออฟฟิศ)', () => {
    expect(scrubNetwork('connect ECONNREFUSED 10.1.2.3:4100')).toBe('connect ECONNREFUSED <ip>');
  });

  test('หลาย IP ในบรรทัดเดียว', () => {
    const out = scrubNetwork('a 10.0.0.1 b 10.0.0.2:80 c 203.0.113.9');
    expect(out).toBe('a <ip> b <ip> c <ip>');
  });

  test('127.0.0.1 (loopback) คงไว้ — ไม่บอกอะไรเกี่ยวกับออฟฟิศ และ log ภายในใช้ตรวจ health', () => {
    expect(scrubNetwork('connect ECONNREFUSED 127.0.0.1:3000')).toBe('connect ECONNREFUSED 127.0.0.1:3000');
  });

  test('เลขเวอร์ชัน 3 ส่วน/เวลา/ตัวเลขทั่วไปไม่ถูกแตะ', () => {
    const t = 'node v20.11.1 axios 1.6.2 เวลา 05:32:59 ใช้ 1234.5 ms';
    expect(scrubNetwork(t)).toBe(t);
  });
});

describe('scrubNetwork — IPv6', () => {
  test.each([
    'connect ECONNREFUSED fe80::1ff:fe23:4567:890a',
    'connect ETIMEDOUT 2001:db8::1',
    'connect ETIMEDOUT 2001:0db8:0000:0000:0000:0000:0000:0001',
    'connect ETIMEDOUT [2001:db8::1]:443',
  ])('%s', (text) => {
    const out = scrubNetwork(text);
    expect(out).not.toMatch(/2001|fe80/i);
    expect(out).toContain('<ip>');
    expect(out).toMatch(/^connect E[A-Z]+ /);
  });

  test('IPv6 ในวงเล็บเหลี่ยมพร้อมพอร์ตถูกปิดทั้งก้อน (ไม่เหลือ [ ] หรือพอร์ต)', () => {
    expect(scrubNetwork('connect ETIMEDOUT [2001:db8::1]:443')).toBe('connect ETIMEDOUT <ip>');
  });

  test('::1 ของ loopback คงไว้ และเวลา/ไฟล์:บรรทัด:คอลัมน์ ไม่ถูกมองเป็น IPv6', () => {
    expect(scrubNetwork('connect ECONNREFUSED ::1')).toBe('connect ECONNREFUSED ::1');
    const t = '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1555:16) 05:32:59 std::string';
    expect(scrubNetwork(t)).toBe(t);
  });
});

describe('scrubNetwork — URL', () => {
  test.each([
    'http://10.0.0.1:8080/api/v2/hotspot?token=abc123',
    'https://user:pw@zabbix.office.example:8443/api_jsonrpc.php',
    'http://netguard-itmonitor:3000/health',
    'https://bot.example.org/webhook?x=1',
  ])('ปิดทั้ง URL: %s', (url) => {
    const out = scrubNetwork(`Request to ${url} failed`);
    expect(out).toBe('Request to <url> failed');
  });

  test('URL ท้ายประโยคไม่ดูดเครื่องหมายวรรคตอนไปด้วย', () => {
    expect(scrubNetwork('ต่อ http://zabbix.office.example/x, แล้วล้ม.')).toBe('ต่อ <url>, แล้วล้ม.');
    expect(scrubNetwork('(http://zabbix.office.example/x)')).toBe('(<url>)');
  });

  test('file:// (เฟรม stack แบบ ESM) ไม่ถูกมองเป็น URL', () => {
    const t = '    at run (file:///app/services/x.js:12:3)';
    expect(scrubNetwork(t)).toBe(t);
  });

  test('ไม่แตะ file:// และ path ใน stack', () => {
    const t = '    at Object.<anonymous> (/app/services/zabbix.js:120:15)';
    expect(scrubNetwork(t)).toBe(t);
  });
});

describe('scrubNetwork — hostname', () => {
  test.each([
    ['getaddrinfo ENOTFOUND zabbix.corp.example', 'ENOTFOUND <host>'],
    ['getaddrinfo EAI_AGAIN omada-ctrl', 'EAI_AGAIN <host>'],
    ['getaddrinfo ENOTFOUND hikcentral.office.lan', 'ENOTFOUND <host>'],
  ])('%s', (text, expected) => {
    const out = scrubNetwork(text);
    expect(out).toContain(expected);
    expect(out).not.toMatch(/zabbix|omada|hikcentral/i);
    expect(out).toContain('getaddrinfo');
  });

  test('ชื่อเครื่องท้าย .local/.lan/.internal ในข้อความอื่นๆ', () => {
    expect(scrubNetwork('ตอบจาก nvr-2.office.lan ช้า')).toBe('ตอบจาก <host> ช้า');
    expect(scrubNetwork('ตอบจาก cam01.local ช้า')).toBe('ตอบจาก <host> ช้า');
  });

  test('ข้อความ certificate hostname mismatch', () => {
    // ชื่อที่ไม่ลงท้าย .lan/.local ฯลฯ — ต้องถูกปิดด้วยกฎ Host:/DNS: เท่านั้น
    const out = scrubNetwork("Hostname/IP does not match certificate's altnames: Host: omada-ctrl is not in the cert's altnames: DNS:other-host, DNS:third-host");
    expect(out).toBe("Hostname/IP does not match certificate's altnames: Host: <host> is not in the cert's altnames: DNS: <host>, DNS: <host>");
  });

  test('ข้อความ error ทั่วไปที่ไม่มีที่อยู่ไม่ถูกแก้', () => {
    for (const t of ['timeout of 10000ms exceeded', 'Request failed with status code 401', 'socket hang up', 'read ECONNRESET', 'ZabbixAdapter.getProblems', 'ดึงข้อมูลไม่ได้ (index.js)']) {
      expect(scrubNetwork(t)).toBe(t);
    }
  });
});

describe('scrubNetwork — ความทนทาน', () => {
  test('idempotent', () => {
    const once = scrubNetwork('connect ECONNREFUSED 10.1.2.3:4100 at http://10.1.2.3/x getaddrinfo ENOTFOUND a.b.lan');
    expect(scrubNetwork(once)).toBe(once);
  });

  test('ไม่ใช่สตริง/ว่าง ไม่ throw', () => {
    expect(scrubNetwork(null)).toBe('');
    expect(scrubNetwork(undefined)).toBe('');
    expect(scrubNetwork(42)).toBe('42');
    expect(scrubNetwork(new Error('connect ECONNREFUSED 10.9.9.9:1'))).not.toContain('10.9.9.9');
  });

  test('ข้อความยาวมากไม่ค้าง (ไม่มี backtracking หายนะ)', () => {
    const big = ('a:'.repeat(5000) + ' 10.0.0.1 ').repeat(20);
    const t0 = Date.now();
    scrubNetwork(big);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('scrubForLog = ที่อยู่เครือข่าย + redact เดิม (token/Bearer/userId)', () => {
  test('Bearer และที่อยู่ถูกปิดพร้อมกัน', () => {
    const out = scrubForLog('POST http://10.0.0.1/x Authorization: Bearer abcdefgh12345678 ECONNREFUSED 10.0.0.1:80');
    expect(out).not.toMatch(/10\.0\.0\.1|abcdefgh12345678/);
    expect(out).toContain('Bearer [redacted]');
    expect(out).toContain('ECONNREFUSED');
  });
  test('userId ของ LINE ถูกปิด', () => {
    expect(scrubForLog('to U' + 'a'.repeat(32) + ' failed')).not.toMatch(/a{32}/);
  });
});
