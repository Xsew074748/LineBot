'use strict';
// แท็กย่อของ LINE userId สำหรับข้อความ log — แทนการพิมพ์ userId ดิบลง info.log/error.log
//
// HMAC-SHA256(กุญแจ = LINE_CHANNEL_SECRET, userId) ตัดเหลือ 6 hex ("u-1a2b3c"):
//   - ย้อนกลับเป็น userId ไม่ได้ (one-way; 24 บิตไม่พอจะสร้าง userId กลับ)
//   - เสถียร: คนเดิมได้แท็กเดิมทุกครั้งและข้าม restart จึงไล่ log ของคนเดียวกันได้
//   - ใช้กุญแจที่บอทมีอยู่แล้ว (ไม่พิมพ์ออก): คนที่มีแค่ log กับรายการ userId (เช่นจาก users.json ที่หลุด) คำนวณซ้ำเพื่อจับคู่แท็กไม่ได้
//   - ไม่มี secret (ทดสอบ/ยังไม่ตั้งค่า) → ถอยไปใช้ SHA-256 ธรรมดา
//   - ข้อจำกัด: ชนกันได้เมื่อผู้ใช้มีมาก (24 บิต) — พอสำหรับบอทที่มีผู้ใช้หลักสิบคน; เปลี่ยน LINE_CHANNEL_SECRET = แท็กเปลี่ยนทั้งหมด
// ไม่ใช้กับ logger.audit: audit.log ต้องระบุตัวผู้กระทำ/เป้าหมายจริง

const crypto = require('crypto');

function userTag(userId, secret = process.env.LINE_CHANNEL_SECRET) {
  if (userId === undefined || userId === null || userId === '') return 'u-none';
  const h = secret ? crypto.createHmac('sha256', String(secret)) : crypto.createHash('sha256');
  return 'u-' + h.update(String(userId)).digest('hex').slice(0, 6);
}

module.exports = { userTag };
