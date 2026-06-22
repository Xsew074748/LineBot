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
async function omadaGet(path) {
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
    logger.apiCall('Omada', path, Date.now() - start);
    const body = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
    if (body.errorCode !== 0) {
      const msg = body.msg || body.message || 'unknown error';
      logger.warn(`omada: errorCode=${body.errorCode} msg="${msg}" path=${path}`);
      throw new Error(`Omada API error [${body.errorCode}]: ${msg}`);
    }
    return body.result;
  } catch (err) {
    logger.apiCall('Omada', path, Date.now() - start, false);
    // Token หมดอายุ → login ใหม่แล้วลองอีกครั้ง (ห้ามวนซ้ำ)
    if (err.response?.status === 401) {
      authToken = null;
      return omadaGet(path);
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
  const all    = result?.data || [];

  // log ทุก device เพื่อดู field type จริง — ลบ/ปิดหลังยืนยันค่าแล้ว
  all.forEach((d) => logger.info(`omada device: name=${d.name} type=${d.type} mac=${d.mac}`));

  const aps = all.filter(isAP);

  if (all.length > 0 && aps.length === 0) {
    logger.warn(`omada: getAPs กรอง 0 จาก ${all.length} devices — ตรวจ log "omada device: type=..." ด้านบนแล้วปรับ isAP()`);
  }

  return aps.map((ap) => ({
    name:     ap.name,
    mac:      ap.mac,
    status:   ap.status === 0 ? '🟢 ออนไลน์' : '🔴 ออฟไลน์',
    clients:  ap.clientNum || 0,
    model:    ap.model || 'N/A',
    _rawType: ap.type, // debug — ลบออกหลังยืนยันค่า type จริงแล้ว
  }));
}

// ── ดึง Client ที่เชื่อมต่อ WiFi ─────────────────────────────────────────────
async function getClients(siteId = SITE_ID) {
  const result = await omadaSiteGet(siteId, 'clients');
  return {
    total:    result?.totalRows || 0,
    wireless: (result?.data || []).filter((c) => c.wireless).length,
    wired:    (result?.data || []).filter((c) => !c.wireless).length,
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
