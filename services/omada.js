'use strict';
require('dotenv').config();
const fs    = require('fs');
const https = require('https');
const axios = require('axios');
const logger = require('./logger');

const BASE_URL = process.env.OMADA_URL      || '';
const USERNAME  = process.env.OMADA_USERNAME || '';
const PASSWORD  = process.env.OMADA_PASSWORD || '';
const SITE_ID   = process.env.OMADA_SITE_ID  || '';
const CA_PATH        = process.env.OMADA_CA_CERT_PATH     || '';
// ตั้ง OMADA_TLS_SKIP_HOSTNAME=true เมื่อ cert ใช้ CN แทน SAN (ERR_TLS_CERT_ALTNAME_INVALID)
// ยัง verify chain อยู่ เพียงข้ามการเช็คชื่อ/IP เท่านั้น — ใช้คู่กับ CA_PATH เท่านั้น
const SKIP_HOSTNAME  = process.env.OMADA_TLS_SKIP_HOSTNAME === 'true';

// ── สร้าง HTTPS Agent ───────────────────────────────────────────────────────────
// ห้ามใช้ NODE_TLS_REJECT_UNAUTHORIZED=0 เพราะจะปิด TLS verify ทั้ง process
// (รวมถึง LINE API และ Claude API) — ปิดเฉพาะ agent นี้เท่านั้น
function buildHttpsAgent() {
  if (CA_PATH) {
    try {
      const ca = fs.readFileSync(CA_PATH);
      const opts = { ca, rejectUnauthorized: true };
      if (SKIP_HOSTNAME) opts.checkServerIdentity = () => undefined;
      logger.info(
        `omada: TLS โหมด CA cert → ${CA_PATH}` +
        (SKIP_HOSTNAME ? ' (+ skip hostname check)' : '')
      );
      return new https.Agent(opts);
    } catch (err) {
      logger.warn(`omada: โหลด CA cert ล้มเหลว (${CA_PATH}): ${err.message} → fallback dev insecure`);
    }
  }
  // dev/LAN mode — rejectUnauthorized: false เฉพาะ agent นี้ ไม่กระทบ TLS ของ process อื่น
  logger.warn('omada: TLS โหมด dev insecure (rejectUnauthorized: false) — ห้ามใช้ใน production');
  return new https.Agent({ rejectUnauthorized: false });
}

// ── Axios Instance — httpsAgent ฝังอยู่ใน instance ป้องกันลืมแนบรายตัว ────────
const omadaHttp = axios.create({ httpsAgent: buildHttpsAgent(), timeout: 10_000 });

// ── Token + Controller ID + Session Cookie ────────────────────────────────────
let authToken    = null;
let tokenExpAt   = 0;          // Unix ms
let omadacId     = null;       // cache จาก /api/info (stable ตลอดอายุ controller)
let sessionCookie = null;      // Set-Cookie จาก login — ต้องส่งคู่กับ Csrf-Token ทุก request

// ── Discovery: GET /api/info → omadacId ───────────────────────────────────────
async function fetchOmadacId() {
  const resp = await omadaHttp.get(`${BASE_URL}/api/info`);
  const id   = resp.data?.result?.omadacId || resp.data?.result?.controllerId;
  if (!id) throw new Error('Omada: /api/info ไม่คืน omadacId — ตรวจ URL อีกครั้ง');
  return id;
}

// ── Login (2-step: /api/info → /{omadacId}/api/v2/login) ─────────────────────
async function login() {
  const start = Date.now();
  try {
    if (!omadacId) omadacId = await fetchOmadacId();
    const resp = await omadaHttp.post(
      `${BASE_URL}/${omadacId}/api/v2/login`,
      { username: USERNAME, password: PASSWORD }
    );
    logger.apiCall('Omada', 'login', Date.now() - start);

    const data = resp.data;
    if (data.errorCode !== 0) throw new Error(`Omada login failed: ${data.msg}`);

    authToken  = data.result?.token;
    tokenExpAt = Date.now() + 23 * 60 * 60 * 1000;
    // เก็บ session cookie ที่ controller set — ต้องแนบทุก request หลังนี้
    // controller ตรวจทั้ง Csrf-Token + cookie คู่กัน ขาดอย่างใดอย่างหนึ่งคืน HTML
    const setCookies = resp.headers['set-cookie'] || [];
    sessionCookie = setCookies.map((c) => c.split(';')[0]).join('; ');
    logger.info(`omada: login สำเร็จ cookie=${sessionCookie.slice(0, 60)}…`);
    return authToken;
  } catch (err) {
    logger.apiCall('Omada', 'login', Date.now() - start, false);
    throw err;
  }
}

// ── ตรวจสอบ Token ก่อนทุก request ────────────────────────────────────────────
async function getToken() {
  if (!authToken || Date.now() >= tokenExpAt) await login();
  return authToken;
}

// ── GET helper (low-level) — รับ absolute path ────────────────────────────────
async function omadaGet(path, retried = false) {
  const token = await getToken();
  const start = Date.now();
  try {
    const resp = await omadaHttp.get(`${BASE_URL}${path}`, {
      headers: {
        'Csrf-Token': token,
        // cookie ต้องส่งคู่กับ Csrf-Token — ขาด cookie controller คืน HTML แทน JSON
        ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      },
    });
    const raw = resp.data;

    // Omada คืน HTTP 200 + HTML login page เมื่อ session/cookie หมด (ไม่ใช่ 401)
    // ตรวจก่อน log OK และก่อน JSON.parse เพื่อกัน SyntaxError และให้ retry ทำงานได้
    if (typeof raw === 'string' && raw.trimStart().startsWith('<')) {
      const e = new Error('Omada session expired (HTML response received)');
      e._htmlSession = true;
      throw e;
    }

    const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (body.errorCode !== 0) {
      const msg = body.msg || body.message || 'unknown error';
      logger.warn(`omada: errorCode=${body.errorCode} msg="${msg}" path=${path}`);
      throw new Error(`Omada API error [${body.errorCode}]: ${msg}`);
    }
    logger.apiCall('Omada', path, Date.now() - start);
    return body.result;
  } catch (err) {
    logger.apiCall('Omada', path, Date.now() - start, false);
    // รวม 2 เคส session หมด: HTTP 401 และ HTTP 200 + HTML (Omada redirect ไป login page)
    if (err.response?.status === 401 || err._htmlSession) {
      if (retried) throw new Error('Omada session expired — ยังคืน HTML หลัง re-login แล้ว');
      authToken     = null;
      sessionCookie = null;
      return omadaGet(path, true);
    }
    throw err;
  }
}

// ── GET helper สำหรับ site-level endpoint ─────────────────────────────────────
// ประกอบ path /{omadacId}/api/v2/sites/{siteId}/{resource} อัตโนมัติ
// แก้ที่นี่จุดเดียว ทุกฟังก์ชันได้ path ถูกต้องทันที
async function omadaSiteGet(siteId, resource) {
  if (!omadacId) omadacId = await fetchOmadacId();
  return omadaGet(`/${omadacId}/api/v2/sites/${siteId}/${resource}`);
}

// ── ดึง Access Points ─────────────────────────────────────────────────────────
// /devices คืน AP + Switch + Gateway รวมกัน — filter เฉพาะ AP
// ค่า type จริงรอยืนยันจาก device จริง: log ด้านล่างจะแสดงทันทีที่มีอุปกรณ์
function isAP(d) {
  const t = d.type;
  // รองรับทั้ง number (0) และ string ('ap', 'eap', 'AP') — ยืนยันค่าจริงจาก log
  return t === 0 || t === '0' || String(t ?? '').toLowerCase().includes('ap');
}

async function getAPs(siteId = SITE_ID) {
  const result = await omadaSiteGet(siteId, 'devices');
  const all    = Array.isArray(result) ? result : (result?.data || []);

  const aps = all.filter(isAP);

  if (all.length > 0 && aps.length === 0) {
    logger.warn(`omada: getAPs กรอง 0 จาก ${all.length} devices — ตรวจ field type ของ device แล้วปรับ isAP()`);
  }

  const CONNECTION_STATUS = {
    0:  '🔴 ไม่เชื่อมต่อ',
    1:  '🔵 กำลังผูกอุปกรณ์',
    2:  '🔵 กำลังตั้งค่า',
    3:  '🟡 รอตอบรับ',
    4:  '🔵 กำลังอัปเดต',
    5:  '🔵 กำลังรีบูต',
    7:  '🔴 ตั้งค่าล้มเหลว',
    10: '🔴 ถูกปฏิเสธ',
    14: '🟢 เชื่อมต่อ',
  };

  function healthLabel(score) {
    if (score === -1)              return 'No Data';
    if (score >= 8 && score <= 10) return '🟢 ดีเยี่ยม';
    if (score >= 4 && score <= 7)  return '🟡 ปานกลาง';
    if (score >= 1 && score <= 3)  return '🔴 แย่';
    if (score === 0)               return '🔴 แย่มาก';
    return `health=${score}`;
  }

  return aps.map((ap) => {
    const connStatus = CONNECTION_STATUS[ap.status] ?? `⚪ status=${ap.status}`;
    return {
      name:      ap.name,
      mac:       ap.mac,
      ip:        ap.ip || null,
      status:    connStatus,
      health:    healthLabel(ap.healthScore),
      clients:   ap.clientNum || 0,
      model:     ap.model || 'N/A',
      // true เฉพาะ state ที่เป็นปัญหาจริง (0=ไม่เชื่อมต่อ, 7=ตั้งค่าล้มเหลว, 10=ถูกปฏิเสธ)
      // transient (1/2/3/4/5) และ connected (14) = false — ไม่นับ offline
      isProblem: [0, 7, 10].includes(ap.status),
    };
  });
}

// ── ดึง Client ที่เชื่อมต่อ WiFi ─────────────────────────────────────────────
// controller รุ่นนี้บังคับ filters.active=true — ไม่ส่งจะคืน errorCode=-1 "General error."
// ถ้าล้มเหลวคืนค่าเปล่า (unavailable) แทน throw เพื่อไม่ให้คำสั่ง client/summary พังทั้งหมด
async function getClients(siteId = SITE_ID) {
  let result = null;
  try {
    result = await omadaSiteGet(siteId, 'clients?currentPage=1&currentPageSize=100&filters.active=true');
  } catch (err) {
    logger.warn(`omada: getClients ล้มเหลว: ${err.message}`);
    return { total: 0, wireless: 0, wired: 0, unavailable: true };
  }
  const data  = Array.isArray(result) ? result : (result?.data  || []);
  const total = Array.isArray(result) ? result.length : (result?.totalRows || 0);
  return {
    total,
    wireless: data.filter((c) =>  c.wireless).length,
    wired:    data.filter((c) => !c.wireless).length,
  };
}

// ── ดึง Alert ─────────────────────────────────────────────────────────────────
// response: result = { totalRows, data: [...] } — อ่าน result.data
async function getAlerts(siteId = SITE_ID) {
  const result = await omadaSiteGet(siteId, 'events?currentPage=1&currentPageSize=10');
  return (result?.data || []).map((e) => ({
    name:   e.name || 'N/A',
    time:   e.time ? new Date(e.time).toLocaleString('th-TH') : 'N/A',
    level:  e.level === 0 ? '⚠️ เตือน' : '🔴 วิกฤต',
  }));
}

// ── Health Check ───────────────────────────────────────────────────────────────
async function healthCheck() {
  try {
    await login();
    return { ok: true, name: 'Omada WiFi' };
  } catch (err) {
    return { ok: false, name: 'Omada WiFi', error: err.message };
  }
}

// ── Test Connection — รับ credentials จาก caller แทน env ─────────────────────
// ใช้ใน Setup UI (routes/config.js) เพื่อทดสอบก่อนบันทึก
// คืน { ok, message } — single source of truth กับ login()
async function testConnection(baseUrl, username, password) {
  const url = (baseUrl || '').replace(/\/$/, '');
  try {
    // Step 1: ดึง omadacId
    const infoResp = await omadaHttp.get(`${url}/api/info`, { timeout: 6000 });
    const cId = infoResp.data?.result?.omadacId || infoResp.data?.result?.controllerId;
    if (!cId) return { ok: false, message: '/api/info ไม่คืน omadacId — ตรวจ URL และ port' };

    // Step 2: login ด้วย credentials ที่รับมา
    const loginResp = await omadaHttp.post(
      `${url}/${cId}/api/v2/login`,
      { username, password },
      { timeout: 6000 }
    );
    const data = loginResp.data;
    if (data.errorCode !== 0) {
      return { ok: false, message: `Auth ล้มเหลว: ${data.msg || 'username/password ผิด'}` };
    }
    return { ok: true, message: `✅ เชื่อมต่อ Omada สำเร็จ (omadacId: ${cId})` };
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      return { ok: false, message: `ต่อไม่ติด: ตรวจ URL และ port (${err.code})` };
    }
    if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message)) {
      return { ok: false, message: 'Connection timeout — ตรวจ URL / firewall' };
    }
    return { ok: false, message: err.message || 'เชื่อมต่อไม่ได้' };
  }
}

// http: axios instance ที่ฝัง httpsAgent ไว้แล้ว — ใช้ได้จากภายนอก (เช่น routes/config.js)
module.exports = { login, getAPs, getClients, getAlerts, healthCheck, testConnection, http: omadaHttp };
