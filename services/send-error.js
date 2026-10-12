'use strict';
// สรุป error ตอนส่ง LINE สำหรับลง log — มี status และ body (ผ่าน redact เสมอ) เพื่อให้รู้สาเหตุจริงของ 400/4xx
// ใช้ได้กับ HTTPFetchError ของ @line/bot-sdk (มี .status / .body) และ Error ทั่วไป; ห้าม throw

const redact = require('./redact');

const MAX_BODY_CHARS = 300;

function bodyText(body) {
  if (body === undefined || body === null || body === '') return '';
  if (typeof body === 'string') return body;
  try { return JSON.stringify(body); } catch { return String(body); }
}

function describeSendError(err) {
  try {
    if (err === null || err === undefined) return 'unknown error';
    const message = redact(typeof err === 'object' ? (err.message ?? '') : String(err));
    const parts = [message];
    if (typeof err === 'object') {
      if (err.status !== undefined && err.status !== null) parts.push(`status=${redact(err.status)}`);
      const body = redact(bodyText(err.body)).slice(0, MAX_BODY_CHARS);
      if (body) parts.push(`body=${body}`);
    }
    return parts.filter(Boolean).join(' ');
  } catch {
    return 'unreadable error';
  }
}

module.exports = { describeSendError };
