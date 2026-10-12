'use strict';
// สรุป error ตอนส่ง LINE สำหรับลง log — มี status และ body (ผ่าน redact เสมอ) เพื่อให้รู้สาเหตุจริงของ 400/4xx
// ใช้ได้กับ HTTPFetchError ของ @line/bot-sdk (มี .status / .body) และ Error ทั่วไป; ห้าม throw

const redact = require('./redact');
const { scrubNetwork } = require('./log-scrub');

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

const STACK_FRAME = /^\s+at /;
// ปิด IPv4/IPv6, URL, hostname (ดู log-scrub.js) — เดิมปิดเฉพาะ IPv4
const maskIps = scrubNetwork;

// ใช้แทนการส่ง error object ดิบให้ logger — logger.error พิมพ์ err.stack ซึ่งมีข้อความ error เดิมอยู่ด้วย (อาจมี IP/URL/hostname/userId/token)
// คืน Error ใหม่: ข้อความ = describeSendError (redact + status/body) แล้วปิดบังที่อยู่เครือข่าย; stack = เฟรมเดิม (ยังไล่ได้ว่าพังที่ไหน)
// ส่วนหัวของ stack เป็นข้อความที่ปิดบังแล้ว; ไม่แก้ error เดิม และห้าม throw
function safeError(err) {
  try {
    const e = new Error(maskIps(describeSendError(err)));
    const stack = err && typeof err === 'object' && typeof err.stack === 'string' ? err.stack : null;
    if (stack) {
      const frames = stack.split('\n').filter((l) => STACK_FRAME.test(l)).map(maskIps).join('\n');
      e.stack = `${err.name || 'Error'}: ${e.message}${frames ? '\n' + frames : ''}`;
    }
    return e;
  } catch {
    return new Error('unreadable error');
  }
}

// ข้อความอย่างเดียว (สตริง) สำหรับต่อลงข้อความ log แทน ${err.message} — ผ่านการปิดบังแล้ว; รหัส error (ECONNREFUSED ฯลฯ) ยังอยู่
function safeMessage(err) {
  return safeError(err).message;
}

module.exports = { describeSendError, safeError, safeMessage };
