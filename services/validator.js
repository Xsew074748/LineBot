'use strict';
require('dotenv').config();

// ── IP Validation ──────────────────────────────────────────────────────────────
// Regex ตรวจสอบ IPv4 ที่ถูกต้อง (ป้องกัน Command Injection)
const IPV4_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// prefix ที่อนุญาตให้ ping ได้ (จาก .env เช่น "192.168.")
const ALLOWED_PREFIX = process.env.ALLOWED_IP_PREFIX || '192.168.';

/**
 * ตรวจสอบว่า IP ถูกต้องและอยู่ใน network ขององค์กร
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateIP(ip) {
  if (typeof ip !== 'string' || ip.length > 15) {
    return { valid: false, reason: 'IP format ไม่ถูกต้อง' };
  }

  const match = ip.match(IPV4_REGEX);
  if (!match) return { valid: false, reason: 'IP ต้องอยู่ในรูปแบบ x.x.x.x' };

  // ตรวจสอบแต่ละ octet ว่าอยู่ใน 0-255
  const octets = match.slice(1).map(Number);
  if (octets.some((o) => o > 255)) {
    return { valid: false, reason: 'IP มี octet เกิน 255' };
  }

  // ตรวจสอบว่าอยู่ใน network ขององค์กรเท่านั้น (Whitelist)
  if (!ip.startsWith(ALLOWED_PREFIX)) {
    return { valid: false, reason: `อนุญาตเฉพาะ IP ใน ${ALLOWED_PREFIX}x.x เท่านั้น` };
  }

  return { valid: true };
}

// ── Command Injection Prevention ───────────────────────────────────────────────
// ตรวจสอบ UserID จาก LINE (ต้องเป็น alphanumeric เท่านั้น)
const LINE_USER_ID_REGEX = /^U[0-9a-f]{32}$/;

function validateLineUserId(userId) {
  if (typeof userId !== 'string') return false;
  return LINE_USER_ID_REGEX.test(userId);
}

// ── Role Validation ────────────────────────────────────────────────────────────
const VALID_ROLES = ['ADMIN', 'IT_STAFF', 'VIEWER'];

function validateRole(role) {
  return VALID_ROLES.includes(role?.toUpperCase());
}

// ── Text Sanitization ─────────────────────────────────────────────────────────
// ตัด whitespace และ จำกัดความยาว ป้องกัน log injection
function sanitizeText(text, maxLen = 500) {
  if (typeof text !== 'string') return '';
  return text.trim().slice(0, maxLen);
}

// ── Timestamp Validation (Replay Attack Prevention) ───────────────────────────
// ตรวจสอบว่า timestamp ของ LINE event ไม่เก่าเกิน 5 นาที
const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000;

function isTimestampFresh(timestampMs) {
  const age = Date.now() - timestampMs;
  return age >= 0 && age <= MAX_TIMESTAMP_AGE_MS;
}

module.exports = {
  validateIP,
  validateLineUserId,
  validateRole,
  sanitizeText,
  isTimestampFresh,
};
