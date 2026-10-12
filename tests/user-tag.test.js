'use strict';
// แท็กย่อของ userId สำหรับ log: ไล่ log ของคนเดียวกันได้ แต่ย้อนกลับเป็น userId ไม่ได้ และ userId ดิบต้องไม่เข้า logger อีก
// เลือก HMAC-SHA256 (กุญแจ = LINE_CHANNEL_SECRET ที่บอทมีอยู่แล้ว ไม่พิมพ์ออก) ตัดเหลือ 6 hex:
//   one-way, เสถียรข้าม restart, คนที่มีแค่ log + รายการ userId ก็ยืนยันไม่ได้ว่าแท็กไหนเป็นใคร; ไม่มี secret → ถอยไปใช้ SHA-256 ธรรมดา

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { userTag } = require('../services/user-tag');

const ID_A = `U${'0123456789abcdef'.repeat(2)}`;      // รูปแบบ userId ปลอม (U + hex 32)
const ID_B = `U${'fedcba9876543210'.repeat(2)}`;

describe('userTag()', () => {
  it('รูปแบบ u-xxxxxx (6 hex) และไม่มี userId อยู่ในแท็ก', () => {
    const t = userTag(ID_A, 'secret-1');
    expect(t).toMatch(/^u-[0-9a-f]{6}$/);
    expect(t).not.toContain(ID_A.slice(1, 9));
    expect(ID_A).not.toContain(t.slice(2));
  });

  it('เสถียร: userId เดิม + secret เดิม ได้แท็กเดิมทุกครั้ง; userId ต่างกันได้แท็กต่างกัน', () => {
    expect(userTag(ID_A, 's')).toBe(userTag(ID_A, 's'));
    expect(userTag(ID_A, 's')).not.toBe(userTag(ID_B, 's'));
  });

  it('คีย์ต่างกัน → แท็กต่างกัน (ไม่ใช่แค่ SHA-256 ที่ใครก็คำนวณซ้ำจาก userId ได้)', () => {
    expect(userTag(ID_A, 'secret-1')).not.toBe(userTag(ID_A, 'secret-2'));
    const plain = 'u-' + crypto.createHash('sha256').update(ID_A).digest('hex').slice(0, 6);
    expect(userTag(ID_A, 'secret-1')).not.toBe(plain);
  });

  it('ไม่มี secret → ถอยไปใช้ SHA-256 ธรรมดา (ยังเสถียรและย้อนกลับไม่ได้)', () => {
    const plain = 'u-' + crypto.createHash('sha256').update(ID_A).digest('hex').slice(0, 6);
    expect(userTag(ID_A, '')).toBe(plain);
    expect(userTag(ID_A, undefined)).toMatch(/^u-[0-9a-f]{6}$/);
  });

  it('อ่านกุญแจจาก LINE_CHANNEL_SECRET เมื่อไม่ส่งมา', () => {
    const old = process.env.LINE_CHANNEL_SECRET;
    process.env.LINE_CHANNEL_SECRET = 'env-secret';
    try { expect(userTag(ID_A)).toBe(userTag(ID_A, 'env-secret')); } finally { if (old === undefined) delete process.env.LINE_CHANNEL_SECRET; else process.env.LINE_CHANNEL_SECRET = old; }
  });

  it('ค่าว่าง/แปลก ไม่ throw: ว่าง → u-none; ตัวเลข/object ก็ได้แท็กรูปแบบเดียวกัน', () => {
    for (const v of [undefined, null, '']) expect(userTag(v, 's')).toBe('u-none');
    for (const v of [42, {}, [1]]) expect(userTag(v, 's')).toMatch(/^u-[0-9a-f]{6}$/);
  });

  it('ชนกันน้อย: 300 userId สุ่มได้แท็กไม่ซ้ำเกิน 1 คู่ (24 บิต)', () => {
    const seen = new Set();
    let dup = 0;
    for (let i = 0; i < 300; i++) { const t = userTag('U' + crypto.randomBytes(16).toString('hex'), 'k'); if (seen.has(t)) dup++; seen.add(t); }
    expect(dup).toBeLessThanOrEqual(1);
  });
});

// ── ซอร์สระดับ: userId ดิบต้องไม่เข้า logger (info/warn/error/message) ──
// audit.log (logger.audit) ยกเว้นโดยตั้งใจ: เป็นบันทึกว่า "ใครสั่งอะไร" ต้องระบุตัวผู้กระทำ
describe('index.js — userId ดิบไม่เข้า logger', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  const lines = src.split('\n').map((text, i) => ({ text, n: i + 1 }));
  const logCall = /logger\.(info|warn|error|message)\(/;

  it('ทุกบรรทัดที่เรียก logger.info/warn/error/message และอ้าง userId ต้องผ่าน userTag(...)', () => {
    const bad = lines.filter((l) => logCall.test(l.text) && /\buserId\b/.test(l.text) && !/userTag\(userId\)/.test(l.text));
    expect(bad.map((l) => `${l.n}: ${l.text.trim().slice(0, 90)}`)).toEqual([]);
  });

  it('ไม่มีรูป userId=${userId} หรือ from ${userId} เหลืออยู่ในข้อความ log', () => {
    const bad = lines.filter((l) => logCall.test(l.text) && /(userId=\$\{userId\}|from \$\{userId\})/.test(l.text));
    expect(bad.map((l) => l.n)).toEqual([]);
  });

  it('ใช้ userTag อย่างน้อย 9 จุด (aiJob 3, stale 2, message 2, handler error 2) และนำเข้าจาก services/user-tag', () => {
    expect(src).toMatch(/require\('\.\/services\/user-tag'\)/);
    expect((src.match(/userTag\(userId\)/g) || []).length).toBeGreaterThanOrEqual(9);
  });

  it('logger.audit ยังรับ userId จริง (audit trail ต้องระบุผู้กระทำ) — ไม่ถูกเปลี่ยนเป็นแท็ก', () => {
    expect(src).toMatch(/logger\.audit\(userId, 'adduser'/);
    expect(src).not.toMatch(/logger\.audit\(userTag/);
  });
});
