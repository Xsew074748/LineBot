'use strict';
// retry + backoff ร่วมของ AI provider ทั้ง 3 ตัว — เปลี่ยนเฉพาะ "จำนวนครั้ง" และ "ช่วงรอ" ของ retry เดิม
// ไม่แตะ logic การเรียก provider ใน callXxx
//
// เหตุผล: 503 จาก Google ตอนไม่ว่างมักหายภายในไม่กี่วินาที แต่ retry เดิม (2 attempt ติดกันใน ~2 วินาที)
// ลองใหม่เร็วเกินไปจนเจอ 503 ซ้ำ (เกิดจริงบน production 2026-09-30 09:12 UTC)
//
// Time budget ต่อคำสั่ง (attempt ละ timeoutGuard 45s แต่ timeout จะไม่ retry):
//   ปกติ 503 ตอบเร็ว (~1s): 3 attempt + backoff 2s + 4s ≈ 10 วินาที
//   ช้าสุดที่ยังไม่ถึง timeout: 3 × 45s + 6s ≈ 141s (ไม่น่าเกิด: ต้องตอบ error ช้าเกือบ 45s ทั้ง 3 ครั้ง)
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 2000;

// อ่านค่าตอนเรียกทุกครั้ง (ไม่ cache) — ตั้ง AI_RETRY_BASE_MS ให้ต่ำมากได้ในเทสโดยไม่ต้องรอจริง
function backoffMs(failedAttempt) {
  const raw = process.env.AI_RETRY_BASE_MS;
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  const base = Number.isFinite(n) && n >= 0 ? n : DEFAULT_BACKOFF_BASE_MS;
  return base * 2 ** (failedAttempt - 1); // attempt 1 ล้มเหลว → base, attempt 2 ล้มเหลว → base×2 (2s, 4s)
}

// เก็บ sleep ไว้ในออบเจ็กต์เพื่อให้เทส spyOn ตรวจค่าที่ใช้ได้
const timers = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

// backoff เฉพาะเมื่อฝั่งเซิร์ฟเวอร์ไม่ว่างชั่วคราว (503/429); error อื่น retry ทันทีเหมือนเดิม (ไม่เปลี่ยนพฤติกรรม)
const isBusy = (err) => err && (err.status === 503 || err.status === 429);

async function withRetry({ provider, label, maxAttempts = DEFAULT_MAX_ATTEMPTS, logger, attemptFn }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await attemptFn();
    } catch (err) {
      const diag = err && err.diag ? ` [${err.diag}]` : '';
      // หมดเวลารอ → ไม่ retry: รออีกรอบเท่ากับรอเป็นหลายเท่า ผู้ใช้จะรอนานเกินไป ให้ caller แจ้ง error ทันที
      if (err && err.isTimeout) {
        logger.error(`ai-providers/${provider}: ${err.message}`);
        throw err;
      }
      if (attempt < maxAttempts) {
        const wait = isBusy(err) ? backoffMs(attempt) : 0;
        logger.warn(`ai-providers/${provider}: attempt ${attempt}/${maxAttempts} ล้มเหลว: ${err.message}${diag} — retry${wait ? ` ในอีก ${wait}ms` : ''}`);
        if (wait) await timers.sleep(wait);
        continue;
      }
      logger.error(`ai-providers/${provider}: ${label} ล้มเหลวทั้ง ${maxAttempts} ครั้ง${diag}`, err);
      throw err;
    }
  }
}

module.exports = { withRetry, backoffMs, timers, DEFAULT_MAX_ATTEMPTS, DEFAULT_BACKOFF_BASE_MS };
