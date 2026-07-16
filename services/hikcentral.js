'use strict';
require('dotenv').config();
const axios  = require('axios');
const https  = require('https');
const fs     = require('fs');
const logger = require('./logger');

const BASE_URL     = (process.env.HIKCENTRAL_URL          || '').replace(/\/+$/, '');
const CLIENT_ID    = process.env.HIKCENTRAL_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.HIKCENTRAL_CLIENT_SECRET || '';
const CA_PATH       = process.env.HIKCENTRAL_CA_CERT_PATH  || '';
const SKIP_HOSTNAME = process.env.HIKCENTRAL_TLS_SKIP_HOSTNAME === 'true';

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
        `hikcentral: TLS โหมด CA cert → ${CA_PATH}` +
        (SKIP_HOSTNAME ? ' (+ skip hostname check)' : '')
      );
      return new https.Agent(opts);
    } catch (err) {
      logger.warn(`hikcentral: โหลด CA cert ล้มเหลว (${CA_PATH}): ${err.message} → fallback dev insecure`);
    }
  }
  // dev/LAN mode — rejectUnauthorized: false เฉพาะ agent นี้ ไม่กระทบ TLS ของ process อื่น
  logger.warn('hikcentral: TLS โหมด dev insecure (rejectUnauthorized: false) — ห้ามใช้ใน production');
  return new https.Agent({ rejectUnauthorized: false });
}

// ── Axios Instance — httpsAgent ฝังอยู่ใน instance ป้องกันลืมแนบรายตัว ────────
const hikHttp = axios.create({ httpsAgent: buildHttpsAgent(), timeout: 10_000 });

// ── Token ใน Memory ────────────────────────────────────────────────────────────
let accessToken = null;
let tokenExpAt  = 0;

// ── Login ด้วย client_credentials (ไม่ใช้ password) ──────────────────────────
async function login() {
  const start = Date.now();
  try {
    const resp = await hikHttp.post(
      `${BASE_URL}/api/v1/oauth/token`,
      new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    logger.apiCall('HikCentral', 'login', Date.now() - start);

    const data = resp.data;
    if (!data.access_token) throw new Error('HikCentral: ไม่ได้รับ access_token');

    accessToken = data.access_token;
    // หัก 60 วินาทีเพื่อ refresh ก่อนหมดอายุ
    tokenExpAt  = Date.now() + (data.expires_in - 60) * 1000;
  } catch (err) {
    logger.apiCall('HikCentral', 'login', Date.now() - start, false);
    throw err;
  }
}

// ── GET helper ─────────────────────────────────────────────────────────────────
async function hikGet(path, params = {}, retried = false) {
  if (!accessToken || Date.now() >= tokenExpAt) await login();

  const start = Date.now();
  try {
    const resp = await hikHttp.get(`${BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params,
    });
    logger.apiCall('HikCentral', path, Date.now() - start);
    return resp.data;
  } catch (err) {
    logger.apiCall('HikCentral', path, Date.now() - start, false);
    // Token หมดอายุ → clear แล้วลองใหม่ครั้งเดียว
    if (err.response?.status === 401) {
      if (retried) throw err;
      accessToken = null;
      tokenExpAt  = 0;
      return hikGet(path, params, true);
    }
    throw err;
  }
}

// ── ดึงกล้องทั้งหมด ───────────────────────────────────────────────────────────
async function getCameras(pageNo = 1, pageSize = 100) {
  const data = await hikGet('/api/v1/cameras', { pageNo, pageSize });
  return formatCameras(data?.list || []);
}

// ── ดึงสถานะกล้องตาม ID ───────────────────────────────────────────────────────
async function getCameraStatus(cameraId) {
  const data = await hikGet(`/api/v1/cameras/${cameraId}/status`);
  return {
    id:     cameraId,
    online: data?.online === true,
    status: data?.online ? '🟢 ออนไลน์' : '🔴 ออฟไลน์',
  };
}

// ── ดึงกล้องตามพื้นที่ (Area) ─────────────────────────────────────────────────
async function getCamerasByArea(areaId) {
  const data = await hikGet('/api/v1/cameras', { areaId, pageSize: 200 });
  return formatCameras(data?.list || []);
}

// ── ดึง Event ล่าสุด ──────────────────────────────────────────────────────────
async function getEvents(limit = 10) {
  const data = await hikGet('/api/v1/events', { pageSize: limit, pageNo: 1 });
  return (data?.list || []).map((e) => ({
    name:      e.name || 'N/A',
    type:      e.eventType || 'N/A',
    cameraId:  e.cameraId,
    time:      e.time ? new Date(e.time).toLocaleString('th-TH') : 'N/A',
  }));
}

// ── แปลงข้อมูลกล้องให้อ่านง่าย ────────────────────────────────────────────────
// แสดง: ชื่อกล้อง, ตำแหน่ง, สถานะ, เวลา offline, ระยะเวลา
function formatCameras(list) {
  return list.map((cam) => {
    const online       = cam.online !== false;
    const offlineSince = cam.offlineTime
      ? new Date(cam.offlineTime).toLocaleString('th-TH')
      : null;
    let duration = '';
    if (!online && cam.offlineTime) {
      const mins = Math.floor((Date.now() - cam.offlineTime) / 60_000);
      duration   = mins < 60
        ? `${mins} นาที`
        : `${Math.floor(mins / 60)} ชม. ${mins % 60} นาที`;
    }
    return {
      id:          cam.cameraId || cam.id,
      name:        cam.cameraName || cam.name || 'N/A',
      location:    cam.areaName || cam.location || 'N/A',
      status:      online ? '🟢 ออนไลน์' : '🔴 ออฟไลน์',
      online,
      offlineSince,
      duration,
    };
  });
}

// ── Health Check ───────────────────────────────────────────────────────────────
async function healthCheck() {
  try {
    await login();
    return { ok: true, name: 'HikCentral' };
  } catch (err) {
    return { ok: false, name: 'HikCentral', error: err.message };
  }
}

module.exports = {
  getCameras,
  getCameraStatus,
  getCamerasByArea,
  getEvents,
  healthCheck,
};
