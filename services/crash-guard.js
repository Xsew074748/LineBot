'use strict';
// จัดการ uncaughtException / unhandledRejection: log รายละเอียด (redact แล้ว) → แจ้ง ADMIN แบบ best-effort (ถ้าเปิด) → exit(1)
// exit(1) เสมอ: ปล่อยให้ Docker restart policy ทำงานตามเดิม (Node 20 ล้มอยู่แล้วเมื่อไม่มี handler — handler นี้แค่เพิ่ม log/แจ้ง)
//
// ความปลอดภัยของการออก:
//   - hard timeout (ค่าเริ่มต้น 5 วินาที) ตั้งเป็นอย่างแรก → ต่อให้ log/แจ้งค้างก็ออก
//   - ออกครั้งเดียว (exitOnce); crash ซ้อนระหว่างปิดตัว → แค่ log ไม่แจ้งซ้ำ ไม่เริ่มกระบวนการใหม่
//   - ทุกขั้นครอบ try/catch — logger/notifier พังก็ยังออก
//
// ตัวแปร .env:
//   OPS_CRASH_NOTIFY=true            เปิดการแจ้ง ADMIN ทาง LINE (เฉพาะ "true" — ค่าเริ่มต้น false = log อย่างเดียว)
//   OPS_CRASH_NOTIFY_COOLDOWN_MIN=30 แจ้งซ้ำได้อีกหลังกี่นาที (1–1440; ผิดรูปแบบ → 30 + warning)
const DEFAULT_COOLDOWN_MIN = 30;
const DEFAULT_HARD_TIMEOUT_MS = 5000;
const MESSAGE_SNIPPET_MAX = 120;

function loadConfig(env = process.env) {
  const warnings = [];
  let cooldownMin = DEFAULT_COOLDOWN_MIN;
  const raw = env.OPS_CRASH_NOTIFY_COOLDOWN_MIN;
  if (raw !== undefined && String(raw).trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 1440) cooldownMin = n;
    else warnings.push(`OPS_CRASH_NOTIFY_COOLDOWN_MIN ไม่ถูกต้อง (ต้องเป็นจำนวนเต็ม 1–1440) — ใช้ค่าเริ่มต้น ${DEFAULT_COOLDOWN_MIN}`);
  }
  return { notify: String(env.OPS_CRASH_NOTIFY || '').trim() === 'true', cooldownMin, warnings };
}

// ข้อความสั้นถึง ADMIN (ผ่าน redact แล้ว; ตัดความยาว) — drill ใช้ฟังก์ชันเดียวกันเพื่อดูตัวอย่างตรงกับของจริง
function buildCrashMessage(kind, err, redact) {
  const msg = redact(err instanceof Error ? err.message : String(err ?? '')).replace(/\s+/g, ' ').trim().slice(0, MESSAGE_SNIPPET_MAX);
  return `🛑 บอทหยุดทำงานผิดปกติ (${kind}) — กำลังรีสตาร์ตเอง\n${msg}\nดูรายละเอียดที่ logs/error.log`;
}

// deps: { logger, redact, getNotifier() → { notify(key, text, { cooldownMs }) } | null, notifyEnabled, cooldownMs, hardTimeoutMs,
//         exit(code) (ค่าเริ่มต้น process.exit), setTimer, clearTimer }
function createCrashHandler({
  logger, redact, getNotifier = () => null, notifyEnabled = false, cooldownMs = DEFAULT_COOLDOWN_MIN * 60_000,
  hardTimeoutMs = DEFAULT_HARD_TIMEOUT_MS, exit = (code) => process.exit(code), setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let crashing = false;
  let exited = false;
  const exitOnce = () => { if (exited) return; exited = true; try { exit(1); } catch { /* ไม่มีอะไรให้ทำต่อ */ } };
  const safeLog = (level, text) => { try { logger[level](text); } catch { /* logger พัง — ไปต่อ */ } };

  return async function onCrash(kind, err) {
    if (crashing) { // crash ซ้อนระหว่างปิดตัว
      safeLog('error', `crash[${kind}] ซ้อนระหว่างปิดตัว: ${safeRedact(redact, err).slice(0, 300)}`);
      return;
    }
    crashing = true;
    const hard = setTimer(exitOnce, hardTimeoutMs);
    try {
      // log เป็นสตริงที่ redact แล้ว (ไม่ส่ง Error เข้า logger เพราะมันพิมพ์ stack ดิบ)
      safeLog('error', `crash[${kind}]: ${safeRedact(redact, err instanceof Error ? (err.stack || err.message) : err)}`);
      if (notifyEnabled) {
        const notifier = getNotifier();
        if (notifier) await notifier.notify('crash', buildCrashMessage(kind, err, redact), { cooldownMs });
      }
    } catch (e) {
      safeLog('warn', `crash[${kind}]: แจ้ง ADMIN ไม่สำเร็จ (${safeRedact(redact, e && e.message).slice(0, 120)})`);
    } finally {
      clearTimer(hard);
      exitOnce();
    }
  };
}

function safeRedact(redact, value) {
  try { return redact(value); } catch { return '(redact ล้มเหลว — ไม่แสดงรายละเอียด)'; }
}

// ลงทะเบียนกับ process (inject proc ได้เพื่อเทสต์)
function install({ handler, proc = process } = {}) {
  proc.on('uncaughtException', (err) => handler('uncaughtException', err));
  proc.on('unhandledRejection', (reason) => handler('unhandledRejection', reason));
}

module.exports = { createCrashHandler, install, loadConfig, buildCrashMessage, DEFAULT_COOLDOWN_MIN, DEFAULT_HARD_TIMEOUT_MS, MESSAGE_SNIPPET_MAX };
