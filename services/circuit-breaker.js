'use strict';
// Circuit breaker แบบง่าย — กันระบบภายนอกที่ช้า/ล่มลากให้คำสั่งอื่นรอจนหมดเวลาทีละ 10 วินาที
//
//   closed    ปกติ — ล้มเหลวติดกัน failureThreshold ครั้ง → open
//   open      งดเรียก: ตอบ CircuitOpenError ทันที (ไม่แตะเครือข่าย) จนครบ cooldownMs
//   half_open หลัง cooldown ปล่อย "คำขอเดียว" ไปลอง (ที่เหลือยังถูกปฏิเสธ): สำเร็จ → closed, ล้ม → open (เริ่มนับ cooldown ใหม่)
//
// นับเฉพาะ "ระบบไม่พร้อมให้บริการ" (isFailure) — คำขอที่เซิร์ฟเวอร์ตอบมาแล้วแต่ปฏิเสธเพราะเราส่งผิด (4xx, ลายเซ็น, code!=0)
// ไม่นับ และถือว่าเซิร์ฟเวอร์ยังตอบอยู่ (รีเซ็ตตัวนับ/ปิด breaker ถ้ากำลัง half_open) ไม่งั้นคำขอผิดของเราจะทำให้ breaker เปิดเอง
// ไม่มี state ร่วมกันระหว่าง breaker คนละตัว: breaker ของ HikCentral ไม่กระทบ Zabbix/Omada
class CircuitOpenError extends Error {
  constructor(name, retryInMs) {
    super(`${name}: circuit breaker เปิดอยู่ — งดเรียกชั่วคราว (ลองใหม่ได้ในอีก ~${Math.max(1, Math.ceil(retryInMs / 1000))} วินาที)`);
    this.name = 'CircuitOpenError';
    this.code = 'ECIRCUITOPEN';
    this.circuit = name;
    this.retryInMs = retryInMs;
  }
}

const NETWORK_CODES = new Set([
  'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH',
  'ENETUNREACH', 'EAI_AGAIN', 'EPIPE', 'ERR_NETWORK',
]);

// ใช้กับ error ของ axios: timeout / เครือข่ายขาด / HTTP 5xx = ระบบไม่พร้อม; อย่างอื่น (4xx, error ที่เราโยนเอง) = ไม่นับ
function isAvailabilityFailure(err) {
  if (!err || err.code === 'ECIRCUITOPEN') return false;
  if (err.response) return err.response.status >= 500;
  if (NETWORK_CODES.has(err.code)) return true;
  return /timeout|timed out|socket hang up|network error/i.test(String(err.message || '')) && !!err.isAxiosError;
}

function createBreaker({ name, failureThreshold = 3, cooldownMs = 60_000, isFailure = isAvailabilityFailure, now = Date.now, logger = null } = {}) {
  if (!name) throw new Error('breaker name required');
  let state = 'closed';
  let failures = 0;      // ล้มเหลวติดกัน (ตอน closed)
  let openedAt = 0;
  let probing = false;   // มีคำขอทดลองอยู่ใน half_open หรือยัง

  const log = (level, msg) => { if (logger && typeof logger[level] === 'function') logger[level](`circuit[${name}]: ${msg}`); };

  const retryInMs = () => Math.max(0, openedAt + cooldownMs - now());

  function open(reason) {
    state = 'open';
    openedAt = now();
    probing = false;
    log('warn', `OPEN — ${reason}; งดเรียก ${Math.round(cooldownMs / 1000)} วินาที`);
  }

  function close() {
    const was = state;
    state = 'closed';
    failures = 0;
    probing = false;
    if (was !== 'closed') log('info', 'CLOSED — เรียกกลับมาได้ปกติ');
  }

  async function execute(fn) {
    if (state === 'open') {
      if (now() - openedAt < cooldownMs) throw new CircuitOpenError(name, retryInMs());
      state = 'half_open';
      probing = false;
      log('info', 'HALF_OPEN — ลองเรียก 1 คำขอ');
    }
    let isProbe = false;
    if (state === 'half_open') {
      if (probing) throw new CircuitOpenError(name, 1000); // มีตัวทดลองอยู่แล้ว คำขออื่นรอผลของมันก่อน
      probing = true;
      isProbe = true;
    }

    try {
      const result = await fn();
      close();
      return result;
    } catch (err) {
      if (isFailure(err)) {
        failures += 1;
        if (isProbe) open(`คำขอทดลองล้มเหลว (${shortReason(err)})`);
        else if (state === 'closed' && failures >= failureThreshold) open(`ล้มเหลวติดกัน ${failures} ครั้ง (ล่าสุด: ${shortReason(err)})`);
      } else {
        close(); // เซิร์ฟเวอร์ตอบอยู่ (ปฏิเสธคำขอของเรา) ไม่ใช่ปัญหาความพร้อมใช้งาน
      }
      throw err;
    } finally {
      if (isProbe) probing = false;
    }
  }

  const snapshot = () => ({
    name,
    state: state === 'open' && now() - openedAt >= cooldownMs ? 'half_open' : state, // เลย cooldown แล้ว = คำขอถัดไปจะเป็นตัวทดลอง
    failures,
    retryInMs: state === 'open' ? retryInMs() : 0,
  });

  return { execute, snapshot, get state() { return snapshot().state; } };
}

// ข้อความสั้นสำหรับ log — ไม่ใส่ URL/header/body (อาจมี secret)
function shortReason(err) {
  if (!err) return 'unknown';
  if (err.response) return `HTTP ${err.response.status}`;
  if (err.code) return String(err.code);
  return String(err.message || 'error').slice(0, 60);
}

// อ่านเลขจำนวนเต็มบวกจาก env ไม่ผ่านใช้ค่า default
function envPositiveInt(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

module.exports = { createBreaker, CircuitOpenError, isAvailabilityFailure, envPositiveInt };
