'use strict';
// ทดสอบ credentials ที่ยังไม่ได้บันทึกลง .env (Manager Dashboard เรียกผ่าน POST /test-connection)
// thin wrapper — auth logic อยู่ใน services/zabbix.js, omada.js, hikcentral.js, ai-providers/*.js
// (แต่ละตัวมี override param รับ config ตรงๆ โดยไม่แตะ env)
//
// กติกา: ทุกฟังก์ชันไม่ throw — คืน { ok, message } เสมอ และห้าม log ค่า config (มี secret)
const zabbix     = require('./zabbix');
const omada      = require('./omada');
const hikcentral = require('./hikcentral');
const providers  = {
  claude: require('./ai-providers/claude'),
  gemini: require('./ai-providers/gemini'),
  openai: require('./ai-providers/openai'),
};

const OK = { ok: true, message: 'เชื่อมต่อสำเร็จ' };
const fail = (message) => ({ ok: false, message });

const SYSTEM_TIMEOUT_MS = 5000;
const AI_TIMEOUT_MS     = 15000;

// ── แปลง error เป็นข้อความไทยสั้นๆ (ไม่คืน message ดิบ/stack ออกไป) ──────────────
function describeError(err, { credLabel = 'ข้อมูลรับรอง' } = {}) {
  const status = err?.response?.status ?? err?.status;
  const raw    = String(err?.message || '');
  const code   = err?.code;

  // timeout ของ AI provider (services/ai-providers/timeout.js) — เชื่อมต่อได้แต่ผู้ให้บริการไม่ตอบทัน
  // ต้องแยกจาก timeout เครือข่ายด้านล่าง ไม่งั้นได้ข้อความ "ตรวจสอบ URL" ที่ไม่เกี่ยวกับ AI
  if (err?.isTimeout || /หมดเวลารอการตอบกลับ/.test(raw)) {
    return 'AI ตอบช้าเกินกำหนด (หมดเวลารอ) ลองใหม่อีกครั้ง';
  }
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || err?.name === 'TimeoutError' || /timeout|timed out/i.test(raw)) {
    return 'เชื่อมต่อไม่ได้ ตรวจสอบ URL และเครือข่าย';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'ไม่พบเซิร์ฟเวอร์ ตรวจสอบ URL';
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ECONNRESET') {
    return 'เชื่อมต่อไม่ได้ ตรวจสอบ URL และเครือข่าย';
  }
  if (/CERT|SSL|TLS|self.signed/i.test(code || '') || /certificate/i.test(raw)) {
    return 'ตรวจสอบใบรับรอง SSL/TLS ของเซิร์ฟเวอร์ไม่ผ่าน';
  }
  if (status === 401 || status === 403) return `${credLabel}ไม่ถูกต้อง หรือไม่มีสิทธิ์`;
  if (status === 404) return 'ไม่พบ endpoint ตรวจสอบ URL';
  // Gemini ตอบ 400 (API key not valid) แทน 401 — request ทดสอบเป็นรูปแบบตายตัว 400 จึงหมายถึง key เสีย
  if (status === 400 && /API error|api.?key/i.test(raw)) return `${credLabel}ไม่ถูกต้อง หรือไม่มีสิทธิ์`;
  if (status === 429) return 'ถูกจำกัดการเรียกชั่วคราว (rate limit) ลองใหม่ภายหลัง';
  if (status >= 500)  return 'เซิร์ฟเวอร์ปลายทางผิดพลาด ลองใหม่ภายหลัง';

  // error ที่ service โยนเองในรูปแบบข้อความ (ไม่มี HTTP status)
  const inMsg = raw.match(/\b(401|403|404|429)\b/);
  if (inMsg) return describeError({ status: Number(inMsg[1]) }, { credLabel });
  if (/not authorized|session terminated|incorrect (user|token)|invalid token|authoriz/i.test(raw)) {
    return `${credLabel}ไม่ถูกต้อง หรือไม่มีสิทธิ์`;
  }
  if (/Omada token failed|client_id|client_secret|omadacId/i.test(raw)) {
    return 'Omada ปฏิเสธการยืนยันตัวตน ตรวจสอบ Omadac ID, Client ID และ Client Secret';
  }
  if (/HikCentral API error/i.test(raw)) return 'HikCentral ปฏิเสธคำขอ ตรวจสอบ App Key และ App Secret';
  if (/Zabbix API Error/i.test(raw))     return 'Zabbix ปฏิเสธคำขอ ตรวจสอบ URL และ API Token';
  if (/Unexpected token|JSON|<html/i.test(raw)) return 'เซิร์ฟเวอร์ตอบกลับรูปแบบที่ไม่ถูกต้อง ตรวจสอบ URL';
  if (/finishReason: MAX_TOKENS/i.test(raw)) return 'เชื่อมต่อสำเร็จ แต่โมเดลตอบไม่ทัน token ที่กำหนด (ลองใหม่อีกครั้ง หรือรายงานผู้ดูแลระบบถ้าเกิดซ้ำ)';
  if (/ไม่มีคำตอบใน response/i.test(raw)) return 'เชื่อมต่อกับ API สำเร็จ แต่ไม่ได้คำตอบกลับมา (อาจเป็นปัญหาชั่วคราวของผู้ให้บริการ)';
  return 'เชื่อมต่อไม่สำเร็จ ตรวจสอบค่าที่กรอก';
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

// คืน URL ที่ใช้ได้ หรือ null ถ้าไม่ใช่ http(s)
function cleanUrl(v) {
  const s = str(v);
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? s.replace(/\/+$/, '') : null;
  } catch { return null; }
}

async function run(fn, label) {
  try {
    await fn();
    return OK;
  } catch (err) {
    return fail(describeError(err, label));
  }
}

async function testZabbix(config) {
  const base     = cleanUrl(config?.url);
  const apiToken = str(config?.apiToken);
  if (!base)     return fail('URL ไม่ถูกต้อง (ต้องขึ้นต้นด้วย http:// หรือ https://)');
  if (!apiToken) return fail('กรุณากรอก API Token');
  // ZABBIX_URL ใน .env เป็น endpoint เต็ม (…/api_jsonrpc.php) — ถ้ากรอกมาแค่ base URL ให้เติมให้
  const url = /\.php$/i.test(base) ? base : `${base}/api_jsonrpc.php`;
  return run(() => withTimeout(
    zabbix.checkAuth({ url, apiToken, timeoutMs: SYSTEM_TIMEOUT_MS }), SYSTEM_TIMEOUT_MS + 500
  ), { credLabel: 'API Token' });
}

async function testOmada(config) {
  const url = cleanUrl(config?.url);
  const omadacId     = str(config?.omadacId);
  const clientId     = str(config?.clientId);
  const clientSecret = str(config?.clientSecret);
  if (!url) return fail('URL ไม่ถูกต้อง (ต้องขึ้นต้นด้วย http:// หรือ https://)');
  if (!omadacId || !clientId || !clientSecret) return fail('กรุณากรอก Omadac ID, Client ID และ Client Secret');
  return run(() => withTimeout(
    omada.requestToken({ url, omadacId, clientId, clientSecret, timeoutMs: SYSTEM_TIMEOUT_MS }), SYSTEM_TIMEOUT_MS + 500
  ), { credLabel: 'Client ID/Secret' });
}

async function testHikCentral(config) {
  const url       = cleanUrl(config?.url);
  const appKey    = str(config?.appKey);
  const appSecret = str(config?.appSecret);
  if (!url) return fail('URL ไม่ถูกต้อง (ต้องขึ้นต้นด้วย http:// หรือ https://)');
  if (!appKey || !appSecret) return fail('กรุณากรอก App Key และ App Secret');
  return run(() => withTimeout(
    hikcentral.checkAuth({ url, appKey, appSecret, timeoutMs: SYSTEM_TIMEOUT_MS }), SYSTEM_TIMEOUT_MS + 500
  ), { credLabel: 'App Key/Secret' });
}

async function testAiProvider(providerName, apiKey) {
  const provider = providers[providerName];
  if (!provider) return fail('ไม่รู้จัก AI provider');
  const key = str(apiKey);
  if (!key) return fail('กรุณากรอก API Key');
  return run(() => withTimeout(
    // maxTokens 10 เดิมเล็กเกินไปสำหรับ thinking model บางตัว (Gemini) ที่กิน token ไปกับ reasoning
    // ก่อนตอบจริง จนไม่เหลือคำตอบเลย — เพิ่มเป็น 64 ให้มีที่เหลือพอ
    provider.complete({ systemPrompt: 'ตอบคำเดียว', userPrompt: 'test', maxTokens: 64, apiKey: key, maxAttempts: 1 }),
    AI_TIMEOUT_MS
  ), { credLabel: 'API Key' });
}

module.exports = { testZabbix, testOmada, testHikCentral, testAiProvider, describeError };
