'use strict';
// สรุปข้อมูลวินิจฉัยที่ "ปลอดภัย" จาก response ที่ไม่สำเร็จของ AI provider เพื่อ log
// (แทนการใส่ response body ดิบใน Error ซึ่งอาจสะท้อน API key กลับมา — ดู commit 62c52e4)
//
// หลักการ: allowlist เท่านั้น — เก็บเฉพาะ field ที่รู้ว่าปลอดภัย ไม่ log object/body ดิบ
//   - retry-after (header): ตรวจรูปแบบก่อน
//   - code: error.status (Google) / error.code / error.type — ต้องเป็นตัวอักษรสั้นๆ แบบ enum (เช่น UNAVAILABLE)
//   - message: เฉพาะ 429/5xx (server ไม่ว่าง) และผ่านการ redact key + ตัดความยาว —
//     ไม่ใส่ตอน 4xx อื่น (400/401/403) เพราะ provider บางเจ้า (OpenAI) สะท้อน key ในข้อความประเภทนี้
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,60}$/;
const SAFE_RETRY_AFTER = /^[A-Za-z0-9 ,:-]{1,40}$/;
const MAX_MESSAGE_CHARS = 140;

function redact(text, apiKey) {
  let s = String(text);
  if (apiKey && apiKey.length >= 6) s = s.split(apiKey).join('***');
  return s
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, '***')
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '***')
    .replace(/(key=)[^&\s"']+/gi, '$1***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
}

// errObj = object ฝั่ง error ของ body (เช่น body.error) — ไม่ต้องเป็น object ก็ได้
function formatDiag({ status, retryAfter, errObj, apiKey }) {
  const parts = [];
  if (retryAfter != null && SAFE_RETRY_AFTER.test(String(retryAfter))) parts.push(`retry-after=${retryAfter}`);
  const code = errObj && typeof errObj === 'object' ? (errObj.status ?? errObj.code ?? errObj.type) : null;
  if (code != null && SAFE_TOKEN.test(String(code))) parts.push(`code=${code}`);
  const message = errObj && typeof errObj === 'object' ? errObj.message : null;
  if ((status === 429 || status >= 500) && typeof message === 'string' && message) {
    parts.push(`msg="${redact(message, apiKey)}"`);
  }
  return parts.join(' ');
}

// สำหรับ provider ที่ใช้ fetch (gemini/openai): อ่าน body แบบไม่ throw
async function httpFailureDiag(res, apiKey) {
  let errObj = null;
  try {
    const parsed = JSON.parse(await res.text());
    errObj = parsed && parsed.error;
  } catch { /* body ไม่ใช่ JSON/อ่านไม่ได้ — ข้ามไป */ }
  let retryAfter = null;
  try { retryAfter = res.headers && res.headers.get && res.headers.get('retry-after'); } catch { /* ignore */ }
  return formatDiag({ status: res.status, retryAfter, errObj, apiKey });
}

module.exports = { formatDiag, httpFailureDiag, redact };
