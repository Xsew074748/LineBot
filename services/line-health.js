'use strict';
// ตัวนับผลการส่ง LINE push — ใช้ตอบ /health/deep ว่า "ส่ง LINE ได้อยู่หรือไม่" (ไม่ส่งข้อความใดๆ เอง ไม่มีทางวนลูป)
//
// นับที่ระดับ "การส่งหนึ่งครั้ง" หลัง retry จบแล้ว ไม่ใช่ทุกครั้งที่ลอง:
//   - push() ใน index.js ลองได้ถึง 3 ครั้ง (flex+quickReply → flex → text) → เรียก recordSuccess()/recordFailure(err สุดท้าย) ครั้งเดียวตอนจบ
//     (retry ที่สำเร็จเพราะตัด quickReply ไม่ถือว่าล้มเหลว)
//   - จุดที่ส่งครั้งเดียวไม่มี retry (pushToUsers, daily summary, ops-alert) ใช้ track(fn) ครอบฟังก์ชันส่ง
//   - ไม่นับ replyMessage (ไม่กินโควตา push) และไม่ครอบ lineClient.pushMessage โดยตรง
//
// consecutive (ล้มติดกัน) นับเฉพาะความล้มเหลวเชิงระบบ: ไม่มี HTTP status (เครือข่าย/timeout), 429, 401, 403, 5xx
// 4xx อื่น (400/404 ฯลฯ — เช่น ผู้ใช้บล็อกบอทหรือ userId ไม่ถูกต้อง) นับใน failedTotal เท่านั้น: ไม่เพิ่มและไม่รีเซ็ต consecutive
// (คนเดียวที่มีปัญหาต้องไม่ทำให้ Zabbix เห็นว่า LINE ล่มทั้งระบบ)
// สำเร็จหนึ่งครั้ง → consecutive = 0
//
// 429 นับแยกใน status429; "โควตาเต็ม" ตรวจจาก 429 ที่ body มีคำว่า monthly limit/quota
//   ⚠️ ข้อความ body ของ LINE ยังไม่ยืนยันกับของจริง — จึงเก็บ status429 แยกไว้เสมอ ไม่พึ่ง quotaExhausted อย่างเดียว
// ไม่เก็บ/ไม่ log body, userId หรือข้อความ error (เก็บแค่ตัวเลข/เวลา/status code)
const QUOTA_BODY_RE = /monthly limit|quota/i;

const statusOf = (err) => {
  const s = err && err.status;
  return Number.isInteger(s) ? s : null;
};
const isSystemic = (err) => {
  const s = statusOf(err);
  return s === null || s === 429 || s === 401 || s === 403 || s >= 500;
};
const isQuota = (err) => statusOf(err) === 429 && QUOTA_BODY_RE.test(String((err && (err.body ?? err.message)) ?? ''));

function createLineHealth({ now = Date.now, logger = null } = {}) {
  const s = {
    total: 0, failed: 0, consecutive: 0, status429: 0,
    quotaAt: null, lastSuccessAt: null, lastFailureAt: null, lastStatus: null,
  };
  const log = (level, msg) => { try { if (logger && typeof logger[level] === 'function') logger[level](msg); } catch { /* log พังไม่กระทบการส่ง */ } };

  function recordSuccess() {
    try {
      s.total += 1;
      if (s.consecutive > 0) log('info', `line-health: ส่ง LINE สำเร็จอีกครั้งหลังล้มติดกัน ${s.consecutive} ครั้ง`);
      s.consecutive = 0;
      s.quotaAt = null;
      s.lastSuccessAt = now();
    } catch { /* ตัวนับต้องไม่ทำให้การส่งพัง */ }
  }

  function recordFailure(err) {
    try {
      s.total += 1;
      s.failed += 1;
      s.lastFailureAt = now();
      const status = statusOf(err);
      s.lastStatus = status === null ? 'network' : status;
      if (status === 429) s.status429 += 1;
      if (isQuota(err)) {
        if (s.quotaAt === null) log('warn', 'line-health: LINE ตอบว่าโควตา push เต็ม (429)');
        s.quotaAt = now();
      }
      if (isSystemic(err)) {
        if (s.consecutive === 0) log('warn', `line-health: ส่ง LINE ล้มเหลว (status=${s.lastStatus}) — เริ่มนับล้มติดกัน`);
        s.consecutive += 1;
      }
    } catch { /* ตัวนับต้องไม่ทำให้การส่งพัง */ }
  }

  // ครอบฟังก์ชันส่งแบบครั้งเดียว: นับผลแล้วคืนผล/โยน error ต่อตามเดิม
  function track(fn) {
    return async (...args) => {
      try {
        const result = await fn(...args);
        recordSuccess();
        return result;
      } catch (err) {
        recordFailure(err);
        throw err;
      }
    };
  }

  const snapshot = () => ({
    total: s.total,
    failed: s.failed,
    consecutive: s.consecutive,
    status429: s.status429,
    quotaExhausted: s.quotaAt !== null,
    lastSuccessAt: s.lastSuccessAt,
    lastFailureAt: s.lastFailureAt,
    lastStatus: s.lastStatus,
  });

  return { recordSuccess, recordFailure, track, snapshot };
}

module.exports = { createLineHealth, isSystemic, isQuota };
