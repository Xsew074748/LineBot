'use strict';
const fs = require('fs');
const path = require('path');

// ── สร้างโฟลเดอร์ logs ถ้ายังไม่มี ───────────────────────────────────────────
const LOG_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const INFO_LOG  = path.join(LOG_DIR, 'info.log');
const ERROR_LOG = path.join(LOG_DIR, 'error.log');
const AUDIT_LOG = path.join(LOG_DIR, 'audit.log');

// ── Format timestamp ───────────────────────────────────────────────────────────
function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ── เขียนลงไฟล์ (append) ──────────────────────────────────────────────────────
function writeToFile(filePath, line) {
  try {
    fs.appendFileSync(filePath, line + '\n', 'utf8');
  } catch {
    // ถ้าเขียนไม่ได้ (disk full ฯลฯ) ให้ไปต่อได้ ไม่ crash bot
  }
}

// ── Logger API ─────────────────────────────────────────────────────────────────
const logger = {
  // Log ข้อมูลทั่วไป (INFO level)
  info(message, meta = {}) {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    const line = `[${timestamp()}] [INFO]  ${message}${metaStr}`;
    console.log(line);
    writeToFile(INFO_LOG, line);
  },

  // Log ข้อผิดพลาด พร้อม stack trace ถ้ามี
  error(message, err = null) {
    const stack = err instanceof Error ? `\n  Stack: ${err.stack}` : '';
    const line = `[${timestamp()}] [ERROR] ${message}${stack}`;
    console.error(line);
    writeToFile(ERROR_LOG, line);
    writeToFile(INFO_LOG, line); // บันทึกใน info ด้วยเพื่อดู timeline ง่ายขึ้น
  },

  // Log คำเตือน
  warn(message, meta = {}) {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    const line = `[${timestamp()}] [WARN]  ${message}${metaStr}`;
    console.warn(line);
    writeToFile(INFO_LOG, line);
  },

  // Log ทุก API call พร้อม response time
  apiCall(service, method, durationMs, success = true) {
    const status = success ? 'OK' : 'FAIL';
    const line = `[${timestamp()}] [API]   ${service}.${method} → ${status} (${durationMs}ms)`;
    console.log(line);
    writeToFile(INFO_LOG, line);
  },

  // Log ทุก AI call พร้อม token usage
  aiCall(method, inputTokens, outputTokens, durationMs) {
    const line = `[${timestamp()}] [AI]    ${method} → in:${inputTokens} out:${outputTokens} tokens (${durationMs}ms)`;
    console.log(line);
    writeToFile(INFO_LOG, line);
  },

  // Audit log — บันทึกแยก ป้องกันการแก้ไข (append-only)
  // ใช้สำหรับคำสั่ง Admin ทุกอย่าง
  audit(userId, command, detail = '') {
    const line = `[${timestamp()}] [AUDIT] userId=${userId} cmd="${command}" ${detail}`;
    console.log(line);
    writeToFile(AUDIT_LOG, line);  // audit.log แยกต่างหาก
    writeToFile(INFO_LOG, line);
  },

  // Log incoming LINE message
  message(userId, text) {
    const safe = text.slice(0, 200); // ป้องกัน log file บวม
    logger.info(`MSG from ${userId}: "${safe}"`);
  },
};

module.exports = logger;
