'use strict';
require('dotenv').config();
const fs    = require('fs');
const https = require('https');
const axios = require('axios');
const logger = require('./logger');

const BASE_URL     = process.env.OMADA_URL           || '';
const OMADAC_ID     = process.env.OMADA_OMADAC_ID     || '';
const SITE_ID       = process.env.OMADA_SITE_ID       || '';
const CLIENT_ID     = process.env.OMADA_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.OMADA_CLIENT_SECRET || '';
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

// ── OAuth2 Client Credentials (Omada Open API) ────────────────────────────────
let accessToken = null;
let tokenExpAt  = 0; // Unix ms

// POST /openapi/authorize/token?grant_type=client_credentials
async function fetchToken() {
  const start = Date.now();
  try {
    const resp = await omadaHttp.post(
      `${BASE_URL}/openapi/authorize/token?grant_type=client_credentials`,
      { omadacId: OMADAC_ID, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }
    );
    logger.apiCall('Omada', 'authorize/token', Date.now() - start);

    const body = resp.data;
    if (body.errorCode !== 0) throw new Error(`Omada token failed [${body.errorCode}]: ${body.msg}`);

    const { accessToken: token, expiresIn } = body.result || {};
    if (!token) throw new Error('Omada: /authorize/token ไม่คืน accessToken');

    accessToken = token;
    tokenExpAt  = Date.now() + (Number(expiresIn) > 0 ? Number(expiresIn) * 1000 : 2 * 60 * 60 * 1000);
    logger.info(`omada: ออก access token สำเร็จ (หมดอายุใน ${expiresIn ?? '?'}s)`);
    return accessToken;
  } catch (err) {
    logger.apiCall('Omada', 'authorize/token', Date.now() - start, false);
    throw err;
  }
}

// เรียกก่อนทุก request — ออก token ใหม่เมื่อยังไม่มี หรือใกล้หมดอายุ (< 5 นาที)
async function getToken() {
  if (!accessToken || Date.now() >= tokenExpAt - 5 * 60 * 1000) await fetchToken();
  return accessToken;
}

// ── GET helper (low-level) — รับ absolute path, แนบ AccessToken header ────────
async function omadaGet(path, retried = false) {
  const token = await getToken();
  const start = Date.now();
  try {
    const resp = await omadaHttp.get(`${BASE_URL}${path}`, {
      headers: { Authorization: `AccessToken=${token}` },
    });
    const body = resp.data;
    if (body.errorCode !== 0) {
      const msg = body.msg || body.message || 'unknown error';
      logger.warn(`omada: errorCode=${body.errorCode} msg="${msg}" path=${path}`);
      throw new Error(`Omada API error [${body.errorCode}]: ${msg}`);
    }
    logger.apiCall('Omada', path, Date.now() - start);
    return body.result;
  } catch (err) {
    logger.apiCall('Omada', path, Date.now() - start, false);
    // token หมดอายุ/ถูก revoke เร็วกว่าที่คำนวณไว้ — ออกใหม่แล้ว retry 1 ครั้ง
    if (err.response?.status === 401 && !retried) {
      accessToken = null;
      return omadaGet(path, true);
    }
    throw err;
  }
}

function extractList(result) {
  return Array.isArray(result) ? result : (result?.data || []);
}

// ── ดึง Access Points ─────────────────────────────────────────────────────────
// GET /openapi/v1/{omadacId}/sites/{siteId}/devices — คืน AP + Switch + Gateway รวมกัน
async function getAPs(siteId = SITE_ID) {
  const result = await omadaGet(`/openapi/v1/${OMADAC_ID}/sites/${siteId}/devices?pageSize=100&page=1`);
  const all    = extractList(result);
  const aps    = all.filter((d) => d.type === 'ap');

  if (all.length > 0 && aps.length === 0) {
    logger.warn(`omada: getAPs กรอง 0 จาก ${all.length} devices — ตรวจ field type ของ device จริงแล้วปรับ filter`);
  }

  return aps.map((ap) => ({
    name:   ap.name,
    ip:     ap.ip,
    status: ap.status === 1 ? 'up' : 'down',
    mac:    ap.mac,
    model:  ap.model,
  }));
}

// ── ดึง Client ที่เชื่อมต่อ ────────────────────────────────────────────────────
// ถ้าล้มเหลวคืนค่าเปล่า (unavailable) แทน throw เพื่อไม่ให้คำสั่ง client/summary พังทั้งหมด
async function getClients(siteId = SITE_ID) {
  let result = null;
  try {
    result = await omadaGet(`/openapi/v1/${OMADAC_ID}/sites/${siteId}/clients?pageSize=100&page=1`);
  } catch (err) {
    logger.warn(`omada: getClients ล้มเหลว: ${err.message}`);
    return { total: 0, wireless: 0, wired: 0, unavailable: true };
  }
  const data  = extractList(result);
  const total = Array.isArray(result) ? result.length : (result?.totalRows ?? data.length);
  return {
    total,
    wireless: data.filter((c) =>  c.wireless).length,
    wired:    data.filter((c) => !c.wireless).length,
  };
}

// ── ดึง Alert ─────────────────────────────────────────────────────────────────
// หมายเหตุ: path นี้ไม่ได้อยู่ใน scope endpoint ที่ยืนยันแล้ว (sites/devices/clients เท่านั้น)
// ยังไม่ได้ทดสอบกับ controller จริง — กัน error ด้วย fallback คืน [] แทน throw
// เพื่อไม่ให้ adapters/omada.js (getProblems) พังทั้งหมด จนกว่าจะยืนยัน endpoint จริง
async function getAlerts(siteId = SITE_ID) {
  try {
    const result = await omadaGet(`/openapi/v1/${OMADAC_ID}/sites/${siteId}/alerts?pageSize=10&page=1`);
    return extractList(result).map((e) => ({
      name:  e.name || e.msg || 'N/A',
      time:  e.time ? new Date(e.time).toLocaleString('th-TH') : 'N/A',
      level: e.level === 0 ? '⚠️ เตือน' : '🔴 วิกฤต',
    }));
  } catch (err) {
    logger.warn(`omada: getAlerts ล้มเหลว (endpoint ยังไม่ยืนยัน): ${err.message}`);
    return [];
  }
}

// ── Health Check — GET /sites แล้วดู errorCode === 0 (omadaGet throw ถ้าไม่ใช่ 0) ──
async function healthCheck() {
  try {
    await omadaGet(`/openapi/v1/${OMADAC_ID}/sites?pageSize=10&page=1`);
    return { ok: true, name: 'Omada WiFi' };
  } catch (err) {
    return { ok: false, name: 'Omada WiFi', error: err.message };
  }
}

// ── Test Connection — ใช้ใน Setup UI (routes/config.js) ก่อนบันทึกค่า ─────────
// หมายเหตุ: Open API ใช้ client_id/client_secret จาก .env เท่านั้น (ไม่ใช่ username/password
// ที่ route ยังส่งมา) — พารามิเตอร์ username/password จึงไม่ถูกใช้แล้ว คงไว้เพื่อไม่ต้องแก้ signature
async function testConnection(baseUrl /*, username, password */) {
  const url = (baseUrl || BASE_URL || '').replace(/\/$/, '');
  try {
    const resp = await omadaHttp.post(
      `${url}/openapi/authorize/token?grant_type=client_credentials`,
      { omadacId: OMADAC_ID, client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
      { timeout: 6000 }
    );
    const body = resp.data;
    if (body.errorCode !== 0) {
      return { ok: false, message: `Auth ล้มเหลว [${body.errorCode}]: ${body.msg || 'client_id/client_secret ผิด'}` };
    }
    return { ok: true, message: '✅ เชื่อมต่อ Omada (Open API) สำเร็จ' };
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
module.exports = { getToken, getAPs, getClients, getAlerts, healthCheck, testConnection, http: omadaHttp };
