'use strict';
// safeError / safeMessage ต้องปิด URL และ hostname ด้วย (ไม่ใช่แค่ IPv4) โดยคงรหัส error และเฟรม stack

const { safeError, safeMessage } = require('../services/send-error');

function netError(msg, code) {
  const e = new Error(msg);
  e.code = code;
  e.stack = `Error: ${msg}\n    at AxiosError.from (/app/node_modules/axios/dist/node/axios.cjs:1268:24)\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1555:16)`;
  return e;
}

describe('safeError — ที่อยู่เครือข่าย', () => {
  test('ECONNREFUSED <IP>:พอร์ต', () => {
    const s = safeError(netError('connect ECONNREFUSED 10.20.30.40:4100', 'ECONNREFUSED'));
    expect(s.message).toBe('connect ECONNREFUSED <ip>');
    expect(s.stack).not.toMatch(/10\.20\.30\.40|4100/);
    expect(s.stack).toContain('/app/node_modules/axios/dist/node/axios.cjs:1268:24');
    expect(s.stack).toContain('node:net:1555:16');
  });

  test('เฟรม stack ที่มี URL/IP ปนอยู่ก็ถูกปิด (เช่น stack ของ lib ที่พิมพ์ที่อยู่ในเฟรม)', () => {
    const e = new Error('boom');
    e.stack = 'Error: boom\n    at fetchIt (http://10.20.30.40:4100/lib.js:5:7)\n    at run (/app/services/x.js:12:3)';
    const s = safeError(e);
    expect(s.stack).not.toMatch(/10\.20\.30\.40|4100/);
    expect(s.stack).toContain('/app/services/x.js:12:3');
  });

  test('ENOTFOUND hostname', () => {
    const s = safeError(netError('getaddrinfo ENOTFOUND zabbix.corp.example', 'ENOTFOUND'));
    expect(s.message).toBe('getaddrinfo ENOTFOUND <host>');
    expect(s.stack).not.toMatch(/zabbix/);
  });

  test('URL ในข้อความ (axios บางรุ่น/proxy error)', () => {
    const s = safeError(netError('Request failed for https://omada-ctrl.office.lan:8043/openapi/v1/x?token=abc with 502', 'ERR_BAD_RESPONSE'));
    expect(s.message).toBe('Request failed for <url> with 502');
    expect(s.stack).not.toMatch(/omada|token=abc/);
  });

  test('timeout / status ยังอ่านรู้เรื่อง', () => {
    expect(safeError(new Error('timeout of 10000ms exceeded')).message).toBe('timeout of 10000ms exceeded');
    const r = new Error('Request failed with status code 502'); r.status = 502;
    expect(safeError(r).message).toContain('Request failed with status code 502');
    expect(safeError(r).message).toContain('status=502');
  });

  test('ไม่แก้ error เดิม และไม่ throw กับค่าแปลก', () => {
    const orig = netError('connect ECONNREFUSED 10.20.30.40:4100', 'ECONNREFUSED');
    safeError(orig);
    expect(orig.message).toContain('10.20.30.40');
    for (const v of [null, undefined, 'plain 10.0.0.1', 42, {}, { message: 'x http://10.0.0.1/a' }]) {
      expect(() => safeError(v)).not.toThrow();
    }
    expect(safeError('plain 10.0.0.1').message).not.toContain('10.0.0.1');
    expect(safeError({ message: 'x http://10.0.0.1/a' }).message).not.toContain('10.0.0.1');
  });
});

describe('safeMessage — ข้อความเดียวสำหรับต่อลงข้อความ log', () => {
  test('คืนสตริงที่ปิดบังแล้ว ไม่ใช่ Error', () => {
    const m = safeMessage(netError('connect ETIMEDOUT 192.168.1.10:8043', 'ETIMEDOUT'));
    expect(typeof m).toBe('string');
    expect(m).toBe('connect ETIMEDOUT <ip>');
  });
  test('รับค่าไม่ใช่ Error ได้', () => {
    expect(safeMessage('boom 10.0.0.1')).toBe('boom <ip>');
    expect(safeMessage(undefined)).toBe('unknown error');
  });
  test('ปิด Bearer/token ผ่าน redact เดิม', () => {
    expect(safeMessage(new Error('bad Bearer abcdefgh12345678'))).not.toContain('abcdefgh12345678');
  });
});
