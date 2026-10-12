'use strict';
// services/logger.js — ทุกบรรทัดที่ออก (console + ไฟล์) ต้องผ่านการปิดบังก่อนเขียน รวม stack ของ error

const fs = require('fs');

describe('logger scrubs every line before writing', () => {
  let logger; let consoleOut; let fileOut;
  let spies;

  beforeEach(() => {
    consoleOut = [];
    fileOut = [];
    jest.resetModules();
    spies = [
      jest.spyOn(console, 'log').mockImplementation((l) => consoleOut.push(String(l))),
      jest.spyOn(console, 'warn').mockImplementation((l) => consoleOut.push(String(l))),
      jest.spyOn(console, 'error').mockImplementation((l) => consoleOut.push(String(l))),
      jest.spyOn(fs, 'appendFileSync').mockImplementation((p, l) => { fileOut.push(String(l)); }),
    ];
    logger = require('../services/logger');
  });
  afterEach(() => spies.forEach((s) => s.mockRestore()));

  const all = () => [...consoleOut, ...fileOut].join('\n');
  const LEAKS = /\b(?:10|172|192|203)\.\d+\.\d+\.\d+|zabbix\.corp|omada-ctrl|abcdefgh12345678|https?:\/\//;

  function axiosLikeError() {
    const e = new Error('connect ECONNREFUSED 10.20.30.40:4100');
    e.code = 'ECONNREFUSED';
    e.stack = [
      'Error: connect ECONNREFUSED 10.20.30.40:4100',
      '    at AxiosError.from (/app/node_modules/axios/dist/node/axios.cjs:1268:24)',
      '    at Function.from (/app/node_modules/axios/dist/node/axios.cjs:1296:12)',
      '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1555:16)',
    ].join('\n');
    return e;
  }

  test('error(): ข้อความและ stack ของ error ดิบไม่ทำให้ IP หลุด แต่รหัส error และเฟรมยังอยู่', () => {
    logger.error('poller: offline camera refresh failed', axiosLikeError());
    expect(all()).not.toMatch(LEAKS);
    expect(all()).toContain('ECONNREFUSED');
    expect(all()).toContain('/app/node_modules/axios/dist/node/axios.cjs:1268:24');
    expect(all()).toContain('node:net:1555:16');
    expect(all()).toContain('Stack:');
  });

  test('error(): ข้อความหลักที่มี URL/hostname/Bearer', () => {
    logger.error('call http://zabbix.corp.example:10051/api failed: getaddrinfo ENOTFOUND zabbix.corp.example Bearer abcdefgh12345678');
    expect(all()).not.toMatch(LEAKS);
    expect(all()).toContain('ENOTFOUND');
  });

  test('warn()/info(): ข้อความและ meta (JSON) ถูกปิดบัง', () => {
    logger.warn('omada: ล้มเหลว connect ETIMEDOUT 192.168.1.10:8043', { url: 'https://omada-ctrl.office.lan/x' });
    logger.info('เรียก http://10.0.0.5/health', { host: '10.0.0.5' });
    expect(all()).not.toMatch(LEAKS);
    expect(all()).not.toContain('omada-ctrl');
    expect(all()).toContain('ETIMEDOUT');
  });

  test('apiCall()/aiCall()/message() ผ่านการปิดบังด้วย', () => {
    logger.apiCall('Zabbix 10.0.0.9', 'host.get', 12, false);
    logger.aiCall('claude 10.0.0.9', 1, 2, 3);
    logger.message('u-1a2b3c', 'ช่วยดู 10.0.0.9 หน่อย http://10.0.0.9/x');
    expect(all()).not.toMatch(LEAKS);
    expect(all()).toContain('host.get');
    expect(all()).toContain('u-1a2b3c');
  });

  test('audit(): ปิดที่อยู่เครือข่าย แต่ userId ต้องไม่ถูกแก้ (audit trail ต้องระบุผู้กระทำจริง)', () => {
    const uid = 'U' + 'b1c2d3e4'.repeat(4);
    logger.audit(uid, 'approve', 'จาก 10.0.0.9');
    expect(all()).toContain(uid);
    expect(all()).not.toContain('10.0.0.9');
  });

  test('ข้อความธรรมดา (ไม่มีที่อยู่/ความลับ) ออกเหมือนเดิมทุกตัวอักษร', () => {
    logger.info('บอทเริ่มทำงาน พอร์ต 3000 โหลด monitor: zabbix, omada');
    expect(consoleOut[0]).toMatch(/\] \[INFO\]  บอทเริ่มทำงาน พอร์ต 3000 โหลด monitor: zabbix, omada$/);
  });

  test('error() ที่ไม่มี err หรือ err ไม่ใช่ Error ไม่ throw และไม่มี Stack', () => {
    expect(() => logger.error('x')).not.toThrow();
    expect(() => logger.error('x', 'string error 10.0.0.1')).not.toThrow();
    expect(all()).not.toContain('Stack:');
  });

  test('ตัวปิดบังต้องไม่ทำให้ logger throw แม้ข้อความอ่านไม่ได้', () => {
    const weird = { toString() { throw new Error('boom'); } };
    expect(require('../services/log-scrub').scrubNetwork(weird)).toBe('');
    expect(require('../services/log-scrub').scrubForLog(weird)).toBe('');
  });
});
