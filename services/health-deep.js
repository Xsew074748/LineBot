'use strict';
// /health/deep — ตัดสินว่าบอท "ยังทำงานได้จริง" ไม่ใช่แค่ HTTP ตอบ (ใช้โดย Zabbix ภายนอก; /health เดิมไม่เปลี่ยน)
//
// กฎ 503 (เฉพาะสิ่งที่เปิดใช้อยู่):
//   1) checker (hik-temp-alarm, omada-traffic-alert) ไม่ tick เกิน max(3 × interval, 180 วินาที)
//      ยังไม่เคย tick → ใช้เวลาเริ่มบอท (startedAt) เป็นฐาน จึงมีช่วงอุ่นเครื่องในตัว
//   2) LINE ล้มเชิงระบบติดกัน ≥ HEALTH_DEEP_LINE_FAIL_THRESHOLD และความล้มเหลวล่าสุดไม่เก่ากว่า HEALTH_DEEP_LINE_FAIL_WINDOW_MIN
//      (หน้าต่างเวลากัน 503 ค้างเป็นวัน: ถ้าไม่มีการส่งใหม่เข้ามารีเซ็ต consecutive ความล้มเหลวเก่าต้องไม่ทำให้เตือนตลอดไป)
// ไม่เรียก upstream ใดๆ (Zabbix/Omada/HikCentral/LINE) — อ่านตัวนับในหน่วยความจำอย่างเดียว
// ตอบเฉพาะ "อายุเป็นวินาที" สถานะ และตัวนับ — ไม่มี IP ชื่อกล้อง userId หรือชื่อ key
//
// ตัวแปร .env:
//   HEALTH_DEEP_TOKEN                 token ≥ 24 ตัวอักษร (ว่าง/สั้นกว่า = ปิด endpoint ตอบ 404) ส่งผ่าน header x-health-token เท่านั้น
//   HEALTH_DEEP_LINE_FAIL_THRESHOLD   จำนวนครั้งที่ส่ง LINE ล้มติดกันจึง 503 (1–100, ค่าเริ่มต้น 3 — นับต่อ "การส่ง" หลัง retry)
//   HEALTH_DEEP_LINE_FAIL_WINDOW_MIN  ความล้มเหลวล่าสุดต้องไม่เก่ากว่ากี่นาที (1–1440, ค่าเริ่มต้น 60)
const crypto = require('crypto');

const TOKEN_MIN_LENGTH = 24;
const STALE_FACTOR = 3;
const STALE_MIN_MS = 180_000;
const DEFAULT_LINE_FAIL_THRESHOLD = 3;
const DEFAULT_LINE_FAIL_WINDOW_MIN = 60;

function intInRange(raw, def, min, max, label, warnings) {
  if (raw === undefined || String(raw).trim() === '') return def;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= min && n <= max) return n;
  warnings.push(`${label} ไม่ถูกต้อง (ต้องเป็นจำนวนเต็ม ${min}–${max}) — ใช้ค่าเริ่มต้น ${def}`);
  return def;
}

function loadConfig(env = process.env) {
  const warnings = [];
  const raw = String(env.HEALTH_DEEP_TOKEN ?? '').trim();
  let token = '';
  if (raw) {
    if (raw.length >= TOKEN_MIN_LENGTH) token = raw;
    else warnings.push(`HEALTH_DEEP_TOKEN สั้นกว่า ${TOKEN_MIN_LENGTH} ตัวอักษร — ปิด /health/deep`); // ไม่พิมพ์ค่า
  }
  return {
    token,
    enabled: token !== '',
    lineFailThreshold: intInRange(env.HEALTH_DEEP_LINE_FAIL_THRESHOLD, DEFAULT_LINE_FAIL_THRESHOLD, 1, 100, 'HEALTH_DEEP_LINE_FAIL_THRESHOLD', warnings),
    lineFailWindowMin: intInRange(env.HEALTH_DEEP_LINE_FAIL_WINDOW_MIN, DEFAULT_LINE_FAIL_WINDOW_MIN, 1, 1440, 'HEALTH_DEEP_LINE_FAIL_WINDOW_MIN', warnings),
    warnings,
  };
}

// เทียบแบบ timing-safe (เทียบ digest ความยาวเท่ากันเสมอ — ไม่รั่วความยาว token)
function tokenMatches(given, expected) {
  const digest = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : '').digest();
  const ok = crypto.timingSafeEqual(digest(given), digest(expected));
  return ok && typeof given === 'string' && given !== '' && typeof expected === 'string' && expected !== '';
}

const maxAgeMs = (intervalMs) => Math.max(STALE_FACTOR * intervalMs, STALE_MIN_MS);
const secs = (ms) => Math.round(Math.max(0, ms) / 1000);
const ageSec = (now, at) => (Number.isFinite(at) ? secs(now - at) : null);
// lastResult มาจากชุดสถานะคงที่ของ checker (ok, fetch-failed, ...) — กรองให้เหลือรูปแบบนั้นเท่านั้น
const safeResult = (r) => (typeof r === 'string' && /^[a-z][a-z-]{0,23}$/.test(r) ? r : null);

const CHECKERS = [
  { key: 'hikTempAlarm', reason: 'hik-temp-alarm-stale' },
  { key: 'omadaTrafficAlert', reason: 'omada-traffic-alert-stale' },
];

// input: { now, startedAt, checkers: { hikTempAlarm?, omadaTrafficAlert? } (ผล getStatus() หรือ null), line (ผล snapshot()),
//          lineFailThreshold, lineFailWindowMin, hikBreaker? } → { ok, reasons[], body }
function evaluate({ now, startedAt, checkers = {}, line, lineFailThreshold = DEFAULT_LINE_FAIL_THRESHOLD, lineFailWindowMin = DEFAULT_LINE_FAIL_WINDOW_MIN, hikBreaker = null }) {
  const reasons = [];
  const checkerViews = {};

  for (const { key, reason } of CHECKERS) {
    const st = checkers[key];
    if (!st || !st.enabled) { checkerViews[key] = { enabled: false }; continue; }
    const base = Number.isFinite(st.lastTickAt) ? st.lastTickAt : startedAt;
    const max = maxAgeMs(st.intervalMs);
    checkerViews[key] = {
      enabled: true,
      lastTickAgoSec: ageSec(now, st.lastTickAt),
      lastResult: safeResult(st.lastResult),
      maxAgeSec: secs(max),
    };
    if (now - base > max) reasons.push(reason);
  }

  const l = line || {};
  const recentFailure = Number.isFinite(l.lastFailureAt) && now - l.lastFailureAt <= lineFailWindowMin * 60_000;
  if ((l.consecutive || 0) >= lineFailThreshold && recentFailure) reasons.push(l.quotaExhausted ? 'line-quota-exhausted' : 'line-push-failing');

  const body = {
    status: reasons.length ? 'fail' : 'ok',
    reasons,
    uptimeSec: secs(now - startedAt),
    checkers: checkerViews,
    line: {
      consecutiveFailures: l.consecutive || 0,
      failedTotal: l.failed || 0,
      pushTotal: l.total || 0,
      status429: l.status429 || 0,
      quotaExhausted: !!l.quotaExhausted,
      lastStatus: l.lastStatus ?? null,
      lastSuccessAgoSec: ageSec(now, l.lastSuccessAt),
      lastFailureAgoSec: ageSec(now, l.lastFailureAt),
    },
  };
  if (typeof hikBreaker === 'string' && /^[a-z_]{1,12}$/.test(hikBreaker)) body.hikcentral = { breaker: hikBreaker };
  return { ok: reasons.length === 0, reasons, body };
}

// handler ของ route (แยกออกมาเพื่อเทสต์ผ่าน HTTP จริงได้): ปิด → 404, token ผิด/ว่าง → 401 เปล่าๆ, ถูก → 200/503 + JSON
// cfg: ผล loadConfig(); getState() → { startedAt, checkers, line, hikBreaker } (อ่านหน่วยความจำอย่างเดียว ไม่เรียก upstream)
function createHandler({ cfg, getState, now = Date.now }) {
  return function healthDeepHandler(req, res) {
    if (!cfg.enabled) return res.status(404).end();
    if (!tokenMatches(req.get('x-health-token'), cfg.token)) return res.status(401).end();
    const r = evaluate({ now: now(), lineFailThreshold: cfg.lineFailThreshold, lineFailWindowMin: cfg.lineFailWindowMin, ...getState() });
    res.set('Cache-Control', 'no-store').status(r.ok ? 200 : 503).json(r.body);
  };
}

module.exports = { evaluate, loadConfig, createHandler, tokenMatches, maxAgeMs, TOKEN_MIN_LENGTH, STALE_FACTOR, STALE_MIN_MS, DEFAULT_LINE_FAIL_THRESHOLD, DEFAULT_LINE_FAIL_WINDOW_MIN };
