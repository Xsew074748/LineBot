'use strict';
// สรุป error ตอนส่ง LINE สำหรับลง log: มี status + body (ผ่าน redact) เพื่อรู้สาเหตุจริงของ 400
// เดิม daily summary log แค่ "400 - Bad Request" จึงสืบไม่ได้ว่าผู้รับล้มเพราะอะไร

const { describeSendError } = require('../services/send-error');

const UID = `U${'a1b2c3d4'.repeat(4)}`;               // รูปแบบ LINE userId (U + hex 32)
const BEARER = 'Bearer abcdefghijklmnop1234567890';

describe('describeSendError()', () => {
  it('รวม message + status + body', () => {
    const err = Object.assign(new Error('400 - Bad Request'), { status: 400, body: '{"message":"The property, \'to\', in the request body is invalid"}' });
    const s = describeSendError(err);
    expect(s).toContain('400 - Bad Request');
    expect(s).toContain('status=400');
    expect(s).toContain("The property, 'to', in the request body is invalid");
  });

  it('body ที่มี userId / Bearer token / secret ถูก redact', () => {
    const err = Object.assign(new Error('x'), {
      status: 400,
      body: `{"to":"${UID}","auth":"${BEARER}","channelSecret":"supersecretvalue1234"}`,
    });
    const s = describeSendError(err);
    expect(s).not.toContain(UID);
    expect(s).not.toContain('abcdefghijklmnop1234567890');
    expect(s).not.toContain('supersecretvalue1234');
  });

  it('message ที่มี userId ก็ถูก redact', () => {
    const s = describeSendError(new Error(`push to ${UID} failed`));
    expect(s).not.toContain(UID);
  });

  it('ตัด body ยาวไม่เกิน 300 ตัวอักษร', () => {
    const s = describeSendError(Object.assign(new Error('e'), { body: 'x'.repeat(5000) }));
    expect(s.length).toBeLessThan(450);
  });

  it('ไม่มี status/body → คืนแค่ message; ค่าแปลก (null, string, object ว่าง) ไม่ throw', () => {
    expect(describeSendError(new Error('boom'))).toBe('boom');
    expect(() => describeSendError(null)).not.toThrow();
    expect(() => describeSendError(undefined)).not.toThrow();
    expect(() => describeSendError('plain string')).not.toThrow();
    expect(() => describeSendError({})).not.toThrow();
    expect(describeSendError('plain string')).toContain('plain string');
  });

  it('body เป็น object (ไม่ใช่สตริง) ก็แปลงเป็นข้อความแล้ว redact', () => {
    const s = describeSendError(Object.assign(new Error('e'), { body: { to: UID, message: 'bad' } }));
    expect(s).toContain('bad');
    expect(s).not.toContain(UID);
  });
});

// ── safeError: ใช้แทนการส่ง error object ดิบให้ logger (logger.error พิมพ์ err.stack ซึ่งมีข้อความ error เดิมอยู่ด้วย) ──
const { safeError } = require('../services/send-error');

describe('safeError()', () => {
  const uid = `U${'9e8d7c6b'.repeat(4)}`;

  it('คืน Error ที่ stack ยังเป็น stack เดิม (เห็นเฟรม) แต่ข้อความผ่าน redact', () => {
    const src = new Error(`push to ${uid} failed with Bearer abcdefghijklmnop1234567890`);
    const e = safeError(src);
    expect(e).toBeInstanceOf(Error);
    expect(e.stack).toContain('at ');                       // ยังมีเฟรมไว้ debug
    expect(e.stack).not.toContain(uid);
    expect(e.stack).not.toContain('abcdefghijklmnop1234567890');
    expect(e.message).not.toContain(uid);
  });

  it('ปิดบัง IPv4 ในข้อความและ stack (เช่น connect ECONNREFUSED <ip>:port)', () => {
    const e = safeError(new Error('connect ECONNREFUSED 203.0.113.77:8443'));
    expect(e.stack).not.toContain('203.0.113.77');
    expect(e.message).not.toContain('203.0.113.77');
    expect(e.message).toContain('ECONNREFUSED');            // รหัส error ยังอยู่
  });

  it('IP ที่อยู่ในเฟรมของ stack (เช่น URL ใน path) ก็ถูกปิดบัง และเฟรมอื่นยังอยู่ครบ', () => {
    const src = new Error('boom');
    src.stack = 'Error: boom\n    at request (http://203.0.113.9:8080/api.js:10:5)\n    at run (/app/services/zabbix.js:34:18)';
    const e = safeError(src);
    expect(e.stack).not.toContain('203.0.113.9');
    expect(e.stack).toContain('/app/services/zabbix.js:34:18');
    expect(e.stack.split('\n').length).toBe(3);
  });

  it('error จาก LINE SDK: รวม status + body ที่ redact แล้วไว้ในข้อความ', () => {
    const src = Object.assign(new Error('400 - Bad Request'), { status: 400, body: `{"to":"${uid}","message":"invalid"}` });
    const e = safeError(src);
    expect(e.message).toContain('status=400');
    expect(e.message).toContain('invalid');
    expect(e.message).not.toContain(uid);
  });

  it('ไม่แก้ error เดิม (immutable) และไม่ throw กับค่าแปลก', () => {
    const src = new Error(`id ${uid}`);
    const before = src.message;
    safeError(src);
    expect(src.message).toBe(before);
    for (const v of [null, undefined, 'plain', 42, {}, { message: 'm' }]) expect(() => safeError(v)).not.toThrow();
    expect(safeError(null)).toBeInstanceOf(Error);
  });

  it('ข้อความธรรมดาที่ไม่มีข้อมูลลับไม่ถูกแก้', () => {
    expect(safeError(new Error('ordinary failure 42')).message).toBe('ordinary failure 42');
  });
});
