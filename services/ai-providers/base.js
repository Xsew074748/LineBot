'use strict';

// ── Interface กลางของทุก AI provider adapter (services/ai-providers/*.js) ──────
// ไม่ใช้ class เหมือน adapters/base.js เพราะ provider ที่นี่ไม่มี state ที่ต้องเก็บ
// เป็น instance — แค่ต้อง export ฟังก์ชันเดียวชื่อ complete() ตาม signature นี้:
//
//   async function complete({ systemPrompt, userPrompt, maxTokens }) → Promise<string>
//
// กติกา:
//   - คืนค่าเป็น plain text เสมอ ไม่ว่า provider จะ format คำตอบยังไงข้างใน
//     (claude คืนจาก content[0].text, gemini คืนจาก candidates[0].content.parts[0].text,
//      openai คืนจาก choices[0].message.content — แต่ผู้เรียก (services/ai.js) เห็นแค่ string)
//   - retry เองข้างในไม่เกิน 1 ครั้ง (รวม 2 attempts) เหมือนของเดิมใน ai.js
//   - throw Error ถ้าเรียกไม่สำเร็จหลัง retry ครบแล้ว — ให้ index.js เดิม (withAI())
//     จัดการเรื่อง quota/error message ต่อ ไม่ต้อง catch เองในนี้
//
// ตัวอ้างอิงด้านล่างไว้เพื่อ documentation/type-check เท่านั้น ไม่ได้ถูกเรียกจริง
// (แต่ละ provider เขียน complete() ของตัวเองแทนที่อันนี้)

/**
 * @param {Object} params
 * @param {string} params.systemPrompt
 * @param {string} params.userPrompt
 * @param {number} [params.maxTokens=500]
 * @returns {Promise<string>} คำตอบเป็น plain text เสมอ
 * @throws {Error} เมื่อเรียก API ไม่สำเร็จ (หลัง retry ในตัว adapter เองแล้ว)
 */
async function complete({ systemPrompt, userPrompt, maxTokens = 500 }) {
  throw new Error('ต้อง implement complete() ในแต่ละ provider adapter');
}

module.exports = { complete };
