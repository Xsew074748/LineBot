'use strict';
// redact: ตัดความลับที่หน้าตาเป็น key/token/userId โดยไม่ผูกกับค่าใน .env และไม่แตะข้อความธรรมดา
// ค่าทั้งหมดในไฟล์นี้เป็นค่าปลอมที่สร้างขึ้นเพื่อทดสอบ

const redact = require('../services/redact');

const USER_ID = `U${'0123456789abcdef'.repeat(2)}`; // U + hex 32 ตัว (รูปแบบเหมือน LINE userId แต่ปลอม)
const CHANNEL_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const ACCESS_TOKEN = `Zm9vYmFyQmF6${'QUJDREVGR0hJSktMTU5PUA'.repeat(6)}+/Ab12==`; // base64 ยาวแบบ access token ปลอม

describe('redact()', () => {
  it('ตัด AppKey/AppSecret/StringToSign แบบข้อความ error ของ Artemis (ไม่ผูกกับค่าใน env)', () => {
    const msg = 'api AK/SK signature authentication failed,Invalid Signature! and StringToSign: POST\n*/*\nx-ca-key:fake-app-key-1\n/artemis/x, apiName : Search, appKey : fake-app-key-1, appSecret=fake-secret-2';
    const out = redact(msg);
    expect(out).not.toContain('fake-app-key-1');
    expect(out).not.toContain('fake-secret-2');
    expect(out).not.toContain('x-ca-key');
    expect(out).toContain('StringToSign:(ตัด)');
    expect(out).toContain('appKey : [redacted]');
  });

  it('ตัด LINE channel secret (hex ยาว) และ access token (base64 ยาว) แม้ไม่มีชื่อ key นำหน้า', () => {
    const out = redact(`ล้มเหลว ${CHANNEL_SECRET} และ ${ACCESS_TOKEN} ในคำขอ`);
    expect(out).not.toContain(CHANNEL_SECRET);
    expect(out).not.toContain('QUJDREVGR0hJSktMTU5PUA');
    expect(out).toContain('ล้มเหลว');
    expect(out).toContain('ในคำขอ');
  });

  it('ตัดค่าที่ตามหลังชื่อ key แบบ key=value / key: value / JSON', () => {
    const out = redact('channelSecret=abc123 accessToken: tok_456 {"LINE_CHANNEL_ACCESS_TOKEN":"tok789","password":"pw1"}');
    for (const leaked of ['abc123', 'tok_456', 'tok789', 'pw1']) expect(out).not.toContain(leaked);
    expect(out).toContain('channelSecret=[redacted]');
  });

  it('ตัด Bearer token', () => {
    const out = redact('Authorization: Bearer abcDEF123456.ghi_jkl-MNO');
    expect(out).not.toContain('abcDEF123456');
    expect(out).toContain('Bearer [redacted]');
  });

  it('ตัดค่า header x-health-token (ทั้งรูปแบบ header และ JSON)', () => {
    const out = redact('x-health-token: s3cr3tvalue-9999 และ {"x-health-token":"another-secret-1"}');
    expect(out).not.toContain('s3cr3tvalue');
    expect(out).not.toContain('another-secret-1');
    expect(out).toContain('x-health-token: [redacted]');
  });

  it('ตัด LINE userId (U + hex 32 ตัว) แต่คงตัว U ไว้ให้รู้ชนิด', () => {
    const out = redact(`push ไปที่ userId=${USER_ID} ไม่สำเร็จ และ ${USER_ID}`);
    expect(out).not.toContain(USER_ID);
    expect(out).not.toContain('0123456789abcdef');
    expect(out).toContain('U[redacted]');
  });

  it('ข้อความธรรมดาไม่ถูกแก้ (ไทย/อังกฤษ/ตัวเลข/IP:port/stack frame/path)', () => {
    const plain = [
      'ต่อ HikCentral ไม่ได้ (ETIMEDOUT) — ข้ามรอบนี้',
      'connect ECONNREFUSED 127.0.0.1:8080',
      'TypeError: Cannot read properties of undefined (reading \'map\')',
      '    at refreshOfflineCameraCache (/app/index.js:1569:5)',
      '    at /app/node_modules/express-rate-limit/dist/index.cjs:123:45',
      'กล้อง CAM-TEST เหตุการณ์ 2030-01-01 09:10:37 +07:00 จำนวน 3 ครั้ง',
      'token หมดอายุแล้ว กรุณาขอใหม่', // มีคำว่า token แต่ไม่ใช่รูปแบบ key: value
    ];
    for (const t of plain) expect(redact(t)).toBe(t);
  });

  it('รับค่าที่ไม่ใช่สตริงได้ (null/undefined/Error/ตัวเลข) ไม่โยน', () => {
    expect(redact(null)).toBe('');
    expect(redact(undefined)).toBe('');
    expect(redact(404)).toBe('404');
    expect(redact(new Error(`พัง ${USER_ID}`))).not.toContain(USER_ID);
  });
});
