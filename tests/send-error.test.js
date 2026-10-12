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
