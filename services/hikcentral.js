'use strict';
require('dotenv').config();
const axios  = require('axios');
const crypto = require('crypto');
const https  = require('https');
const fs     = require('fs');
const logger = require('./logger');

// ── HikCentral OpenAPI (artemis) — AK/SK Signature Authentication ─────────────
// อ้างอิง: HikCentral Professional OpenAPI Developer Guide V2.6.1
const BASE_URL   = (process.env.HIKCENTRAL_URL || '').replace(/\/+$/, '');
const APP_KEY    = process.env.HIKCENTRAL_APP_KEY    || '';
const APP_SECRET = process.env.HIKCENTRAL_APP_SECRET || '';

const CA_PATH       = process.env.HIKCENTRAL_CA_CERT_PATH || '';
const SKIP_HOSTNAME = process.env.HIKCENTRAL_TLS_SKIP_HOSTNAME === 'true';

// ── สร้าง HTTPS Agent (ใช้เฉพาะเมื่อ BASE_URL เป็น https) ─────────────────────
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
  return new https.Agent({ rejectUnauthorized: false });
}

const hikHttp = axios.create({ httpsAgent: buildHttpsAgent(), timeout: 10_000 });

// ── AK/SK Signature ────────────────────────────────────────────────────────────
// stringToSign = METHOD\nAccept\nContent-MD5\nContent-Type\nDate\n
//                x-ca-key:AppKey\nx-ca-timestamp:ts\n/path
// header ที่ไม่ได้ส่ง (Content-MD5, Date) ต้องข้ามบรรทัดไปเลย ห้ามใส่บรรทัดว่าง
// signature = Base64(HmacSHA256(stringToSign, AppSecret))
function buildSignedHeaders(method, path) {
  const timestamp   = Date.now().toString();
  const accept      = '*/*';
  const contentType = 'application/json';

  const stringToSign = [
    method.toUpperCase(),
    accept,
    contentType,
    `x-ca-key:${APP_KEY}`,
    `x-ca-timestamp:${timestamp}`,
    path,
  ].join('\n');

  const signature = crypto
    .createHmac('sha256', APP_SECRET)
    .update(stringToSign, 'utf8')
    .digest('base64');

  return {
    Accept:                   accept,
    'Content-Type':           contentType,
    'X-Ca-Key':               APP_KEY,
    'X-Ca-Signature':         signature,
    'X-Ca-Signature-Headers': 'x-ca-key,x-ca-timestamp',
    'X-Ca-Timestamp':         timestamp,
    'X-Ca-Nonce':             crypto.randomUUID(),
  };
}

// ── POST helper — ทุก endpoint ของ artemis ใช้ POST ────────────────────────────
async function hikPost(path, body = {}) {
  const start = Date.now();
  try {
    const resp = await hikHttp.post(`${BASE_URL}${path}`, body, {
      headers: buildSignedHeaders('POST', path),
    });
    logger.apiCall('HikCentral', path, Date.now() - start);

    const data = resp.data;
    // artemis ตอบ 200 เสมอ ต้องเช็ค code ในเนื้อ response เอง ('0' = สำเร็จ)
    if (data?.code !== undefined && String(data.code) !== '0') {
      throw new Error(`HikCentral API error ${data.code}: ${data.msg || 'unknown'}`);
    }
    return data?.data;
  } catch (err) {
    logger.apiCall('HikCentral', path, Date.now() - start, false);
    throw err;
  }
}

// ── ดึงกล้องทั้งหมด ───────────────────────────────────────────────────────────
// artemis จำกัด pageSize ไม่เกิน 500 — ถ้าขอมากกว่านั้นไล่ดึงทีละหน้าจนครบ
async function getCameras(pageNo = 1, pageSize = 100) {
  const per = Math.min(pageSize, 500);
  const all = [];
  let page  = pageNo;
  while (all.length < pageSize) {
    const data = await hikPost('/artemis/api/resource/v1/cameras', { pageNo: page, pageSize: per });
    const list = data?.list || [];
    all.push(...list);
    const total = Number(data?.total ?? 0);
    if (list.length < per || (total && all.length >= total)) break;
    page += 1;
  }
  return formatCameras(all.slice(0, pageSize));
}

// ── ดึงสถานะกล้องตาม indexCode ────────────────────────────────────────────────
async function getCameraStatus(indexCode) {
  const cam = await hikPost('/artemis/api/resource/v1/cameras/indexCode', { cameraIndexCode: indexCode });
  const online = isOnline(cam);
  return {
    id:     indexCode,
    name:   cam?.cameraName || 'N/A',
    online,
    status: online ? '🟢 ออนไลน์' : '🔴 ออฟไลน์',
  };
}

// ── ดึงกล้องตามพื้นที่ (regionIndexCode) ──────────────────────────────────────
async function getCamerasByArea(areaId) {
  const data = await hikPost('/artemis/api/resource/v1/cameras', { pageNo: 1, pageSize: 500 });
  const list = (data?.list || []).filter((c) => String(c.regionIndexCode) === String(areaId));
  return formatCameras(list);
}

// ── ดึง Event ล่าสุด ──────────────────────────────────────────────────────────
async function getEvents(limit = 10) {
  const data = await hikPost('/artemis/api/eventService/v1/eventRecords/page', {
    pageNo: 1,
    pageSize: limit,
  });
  return (data?.list || []).map((e) => ({
    name:     e.eventName || e.srcName || 'N/A',
    type:     e.eventType || 'N/A',
    cameraId: e.srcIndex || e.cameraIndexCode || null,
    time:     e.happenTime ? new Date(e.happenTime).toLocaleString('th-TH') : 'N/A',
  }));
}

// ── สถานะ online — artemis ใช้ status: 1 = online, 0 = offline ────────────────
function isOnline(cam) {
  if (!cam) return false;
  if (cam.online !== undefined) return cam.online === true;
  return Number(cam.status) === 1;
}

// ── แปลงข้อมูลกล้องให้อ่านง่าย ────────────────────────────────────────────────
function formatCameras(list) {
  return list.map((cam) => {
    const online = isOnline(cam);
    return {
      id:           cam.cameraIndexCode || cam.indexCode || cam.id,
      name:         cam.cameraName || cam.name || 'N/A',
      location:     cam.regionIndexCode || cam.areaName || 'N/A',
      status:       online ? '🟢 ออนไลน์' : '🔴 ออฟไลน์',
      online,
      offlineSince: null, // artemis camera list ไม่มี offlineTime
      duration:     '',
    };
  });
}

// ── Health Check — ยิงขอกล้อง 1 ตัวเพื่อทดสอบ signature + การเชื่อมต่อ ────────
async function healthCheck() {
  try {
    await hikPost('/artemis/api/resource/v1/cameras', { pageNo: 1, pageSize: 1 });
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
