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
const CA_PATH   = process.env.OMADA_CA_CERT_PATH || '';

// ── สร้าง HTTPS Agent ───────────────────────────────────────────────────────────
// ใช้ CA cert ที่กำหนด (Certificate Pinning) แทนการปิด rejectUnauthorized ทั้งหมด
// ถ้าไม่มี CA cert ให้แจ้ง warning และใช้ default (จะ fail ถ้า self-signed)
function buildHttpsAgent() {
  if (CA_PATH) {
    try {
      const ca = fs.readFileSync(CA_PATH);
      return new https.Agent({ ca, rejectUnauthorized: true });
    } catch (err) {
      logger.warn(`omada: โหลด CA cert ล้มเหลว (${CA_PATH}): ${err.message}`);
    }
  }
  // ไม่มี CA cert → warn แต่ยังต่อได้ (development only)
  logger.warn('omada: ไม่มี OMADA_CA_CERT_PATH → ใช้ default TLS (อาจ fail กับ self-signed cert)');
  return new https.Agent({ rejectUnauthorized: true });
}

const httpsAgent = buildHttpsAgent();

// ── Token ใน Memory ────────────────────────────────────────────────────────────
let authToken  = null;
let tokenExpAt = 0; // Unix ms

// ── Login ──────────────────────────────────────────────────────────────────────
async function login() {
  const start = Date.now();
  try {
    const resp = await axios.post(
      `${BASE_URL}/api/v2/hotspot/login`,
      { username: USERNAME, password: PASSWORD },
      { httpsAgent, timeout: 10_000 }
    );
    logger.apiCall('Omada', 'login', Date.now() - start);

    const data = resp.data;
    if (data.errorCode !== 0) throw new Error(`Omada login failed: ${data.msg}`);

    authToken  = data.result?.token;
    tokenExpAt = Date.now() + 23 * 60 * 60 * 1000; // สมมติ token อายุ 23 ชม.
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

// ── GET helper ─────────────────────────────────────────────────────────────────
async function omadaGet(path) {
  const token = await getToken();
  const start = Date.now();
  try {
    const resp = await axios.get(`${BASE_URL}${path}`, {
      headers: { 'Csrf-Token': token },
      httpsAgent,
      timeout: 10_000,
    });
    logger.apiCall('Omada', path, Date.now() - start);
    if (resp.data.errorCode !== 0) throw new Error(`Omada API error: ${resp.data.msg}`);
    return resp.data.result;
  } catch (err) {
    logger.apiCall('Omada', path, Date.now() - start, false);
    // Token หมดอายุ → login ใหม่แล้วลองอีกครั้ง
    if (err.response?.status === 401) {
      authToken = null;
      return omadaGet(path);
    }
    throw err;
  }
}

// ── ดึง Access Points ─────────────────────────────────────────────────────────
async function getAPs(siteId = SITE_ID) {
  const result = await omadaGet(`/api/v2/${siteId}/eaps`);
  return (result?.data || []).map((ap) => ({
    name:    ap.name,
    mac:     ap.mac,
    status:  ap.status === 0 ? '🟢 ออนไลน์' : '🔴 ออฟไลน์',
    clients: ap.clientNum || 0,
    model:   ap.model || 'N/A',
  }));
}

// ── ดึง Client ที่เชื่อมต่อ WiFi ─────────────────────────────────────────────
async function getClients(siteId = SITE_ID) {
  const result = await omadaGet(`/api/v2/${siteId}/clients`);
  return {
    total:    result?.totalRows || 0,
    wireless: (result?.data || []).filter((c) => c.wireless).length,
    wired:    (result?.data || []).filter((c) => !c.wireless).length,
  };
}

// ── ดึง Alert ─────────────────────────────────────────────────────────────────
async function getAlerts(siteId = SITE_ID) {
  const result = await omadaGet(`/api/v2/${siteId}/events?pageSize=10&currentPage=1`);
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

module.exports = { login, getAPs, getClients, getAlerts, healthCheck };
